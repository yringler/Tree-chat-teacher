import {
  DEFAULT_SYSTEM_PROMPT,
  REPLY_LENGTH_INSTRUCTIONS,
  type LearnReplyLength,
} from '@tangent/shared';
import { replyInstructions } from '../../src/context/render.js';
import { describe, expect, it } from 'vitest';
import { ChatService, DEFAULT_CHAT_SETTINGS } from '../../src/services/chat-service.js';
import { createMemoryRepositories } from '../../src/memory/memory-repositories.js';
import type { GenerationProfile } from '../../src/services/profile.js';
import { registryOf, ScriptedProvider, send } from './helpers.js';

/**
 * One account seen by power, Learn with and without the learner's own
 * instructions, and the pool: Learn always sends its tutor prompt, and adds
 * the tree's learner instructions after it only where the profile allows
 * (the learner pays with their own key or credit).
 */
function setup() {
  const repos = createMemoryRepositories();
  const learnProvider = new ScriptedProvider('openrouter');
  const powerProvider = new ScriptedProvider('ant');
  let n = 0;
  const service = (profile: GenerationProfile, defaultSystemPrompt: string) =>
    new ChatService({
      repos,
      providers: registryOf(profile.kind === 'power' ? powerProvider : learnProvider),
      profile,
      defaultSystemPrompt,
      settings: { ...DEFAULT_CHAT_SETTINGS, autoTitle: false },
      newId: () => `id${++n}`,
    });
  return {
    learnProvider,
    powerProvider,
    power: service({ kind: 'power' }, DEFAULT_SYSTEM_PROMPT),
    /** Power on the same account after the built-in prompt changed. */
    powerWith: (builtIn: string) => service({ kind: 'power' }, builtIn),
    learn: service({ kind: 'learn', customPrompt: true }, 'TUTOR'),
    learnPlain: service({ kind: 'learn', customPrompt: false }, 'TUTOR'),
    /** Learn on the same account after the operator changed its tutor prompt. */
    learnWith: (tutor: string) => service({ kind: 'learn', customPrompt: true }, tutor),
    pool: service(
      {
        kind: 'pool',
        model: 'm1',
        systemPrompt: 'POOL',
        estimateTokens: (text: string) => text.length,
        anchorQuoteMaxChars: 1000,
      },
      'POOL',
    ),
  };
}

/** The system prompt of the latest chat call `chat` made on `branchId` through `provider`. */
async function systemSent(
  provider: ScriptedProvider,
  chat: ChatService,
  branchId: string,
): Promise<string | null | undefined> {
  await send(chat, branchId, 'hi');
  return provider.chatCalls().at(-1)?.system;
}

describe("Learn's system prompt", () => {
  it('adds the learner instructions after the tutor prompt where they are allowed', async () => {
    const s = setup();
    const { tree } = await s.learn.createTree({});
    await s.learn.updateTree(tree.id, { learnerInstructions: '  Answer in French.\n' });
    expect(await systemSent(s.learnProvider, s.learn, tree.trunkBranchId)).toBe(
      'TUTOR\n\nAnswer in French.',
    );
  });

  it('sends the tutor prompt alone where they are not, and the pool its locked prompt', async () => {
    const s = setup();
    const { tree } = await s.learn.createTree({});
    await s.learn.updateTree(tree.id, { learnerInstructions: 'Answer in French.' });
    expect(await systemSent(s.learnProvider, s.learnPlain, tree.trunkBranchId)).toBe('TUTOR');
    expect(await systemSent(s.learnProvider, s.pool, tree.trunkBranchId)).toBe('POOL');
  });

  it('adds nothing for blank learner instructions', async () => {
    const s = setup();
    const { tree } = await s.learn.createTree({});
    expect(tree.learnerInstructions).toBeNull();
    expect(await systemSent(s.learnProvider, s.learn, tree.trunkBranchId)).toBe('TUTOR');
    await s.learn.updateTree(tree.id, { learnerInstructions: '   ' });
    expect((await s.learn.getTreeDetail(tree.id)).tree.learnerInstructions).toBeNull();
    expect(await systemSent(s.learnProvider, s.learn, tree.trunkBranchId)).toBe('TUTOR');
  });

  it("ignores the tree's own system prompt", async () => {
    const s = setup();
    const { tree } = await s.power.createTree({ systemPrompt: 'Answer in French.' });
    expect(await systemSent(s.learnProvider, s.learn, tree.trunkBranchId)).toBe('TUTOR');
    // The tree keeps its prompt for power.
    expect((await s.power.getTreeDetail(tree.id)).tree.systemPrompt).toBe('Answer in French.');
  });

  it('never doubles a tutor prompt that changed after the lesson was made', async () => {
    const s = setup();
    const lesson = await s.learn.createTree({});
    const powerTree = await s.power.createTree({});
    const changed = s.learnWith('NEW TUTOR');
    expect(await systemSent(s.learnProvider, changed, lesson.tree.trunkBranchId)).toBe('NEW TUTOR');
    expect(await systemSent(s.learnProvider, changed, powerTree.tree.trunkBranchId)).toBe(
      'NEW TUTOR',
    );
  });

  it("stores no prompt on a new lesson and sends the tutor prompt, not the account's saved power prompt", async () => {
    const s = setup();
    await s.power.updateSettings({ systemPrompt: 'My power prompt.' });
    const { tree } = await s.learn.createTree({});
    expect(tree.systemPrompt).toBeNull();
    expect(await systemSent(s.learnProvider, s.learn, tree.trunkBranchId)).toBe('TUTOR');
  });
});

describe("Power's system prompt", () => {
  it('sends the tree prompt as it is and ignores learner instructions', async () => {
    const s = setup();
    const { tree } = await s.power.createTree({ systemPrompt: 'Be terse.' });
    await s.power.updateTree(tree.id, { learnerInstructions: 'Answer in French.' });
    expect(await systemSent(s.powerProvider, s.power, tree.trunkBranchId)).toBe('Be terse.');
  });

  it('stores no prompt on a tree made without one', async () => {
    const s = setup();
    await s.power.updateSettings({ systemPrompt: 'My default.' });
    expect((await s.power.createTree({})).tree.systemPrompt).toBeNull();
    expect((await s.power.createTree({ systemPrompt: '  ' })).tree.systemPrompt).toBeNull();
  });

  it('sends the current default for a tree without a prompt: the saved one, else the built-in one', async () => {
    const s = setup();
    const { tree } = await s.power.createTree({});
    expect(await systemSent(s.powerProvider, s.power, tree.trunkBranchId)).toBe(
      DEFAULT_SYSTEM_PROMPT,
    );
    await s.power.updateSettings({ systemPrompt: 'My default.' });
    expect(await systemSent(s.powerProvider, s.power, tree.trunkBranchId)).toBe('My default.');
    await s.power.updateSettings({ systemPrompt: 'My new default.' });
    expect(await systemSent(s.powerProvider, s.power, tree.trunkBranchId)).toBe('My new default.');
    await s.power.updateSettings({ systemPrompt: null });
    expect(await systemSent(s.powerProvider, s.powerWith('NEW BUILT-IN'), tree.trunkBranchId)).toBe(
      'NEW BUILT-IN',
    );
  });

  it("prefers the tree's own prompt to the saved default", async () => {
    const s = setup();
    await s.power.updateSettings({ systemPrompt: 'My default.' });
    const { tree } = await s.power.createTree({ systemPrompt: 'Be terse.' });
    expect(await systemSent(s.powerProvider, s.power, tree.trunkBranchId)).toBe('Be terse.');
  });

  it('follows the default again once the tree prompt is cleared', async () => {
    const s = setup();
    await s.power.updateSettings({ systemPrompt: 'My default.' });
    const { tree } = await s.power.createTree({ systemPrompt: 'Be terse.' });
    await s.power.updateTree(tree.id, { systemPrompt: '' });
    expect((await s.power.getTreeDetail(tree.id)).tree.systemPrompt).toBeNull();
    expect(await systemSent(s.powerProvider, s.power, tree.trunkBranchId)).toBe('My default.');
  });

  it('sends no prompt when there is neither a saved nor a built-in one', async () => {
    const s = setup();
    const { tree } = await s.powerWith('').createTree({});
    expect(await systemSent(s.powerProvider, s.powerWith(''), tree.trunkBranchId)).toBeNull();
  });
});

describe("Learn's reply length", () => {
  /** Learn with `replyLength` saved, on the same account as `s`. */
  function lengthService(replyLength: LearnReplyLength) {
    const repos = createMemoryRepositories();
    const provider = new ScriptedProvider('openrouter');
    const service = (profile: GenerationProfile) =>
      new ChatService({
        repos,
        providers: registryOf(provider),
        profile,
        defaultSystemPrompt: 'TUTOR',
        settings: { ...DEFAULT_CHAT_SETTINGS, autoTitle: false },
      });
    const reply = { tier: 'normal', replyLength } as const;
    return {
      provider,
      learn: service({ kind: 'learn', customPrompt: true, reply }),
      pool: service({
        kind: 'pool',
        model: 'm1',
        systemPrompt: 'POOL',
        estimateTokens: (text: string) => text.length,
        anchorQuoteMaxChars: 1000,
      }),
    };
  }

  it('asks a longer reply for its length after the history, never in the system prompt', async () => {
    const s = lengthService('veryLong');
    const { tree } = await s.learn.createTree({});
    await send(s.learn, tree.trunkBranchId, 'hi');
    const call = s.provider.chatCalls().at(-1);
    expect(call?.turnInstructions).toBe(replyInstructions(REPLY_LENGTH_INSTRUCTIONS.veryLong));
    expect(call?.system).toBe('TUTOR');
  });

  it('asks nothing for Normal, nor on the pool', async () => {
    const normal = lengthService('normal');
    const { tree } = await normal.learn.createTree({});
    await send(normal.learn, tree.trunkBranchId, 'hi');
    expect(normal.provider.chatCalls().at(-1)?.turnInstructions).toBeUndefined();
    const long = lengthService('long');
    const lesson = await long.learn.createTree({});
    await send(long.pool, lesson.tree.trunkBranchId, 'hi');
    expect(long.provider.chatCalls().at(-1)?.turnInstructions).toBeUndefined();
  });

  it("doesn't change the reply's output cap", async () => {
    const caps = await Promise.all(
      (['normal', 'long', 'veryLong'] as const).map(async (length) => {
        const s = lengthService(length);
        const { tree } = await s.learn.createTree({});
        await send(s.learn, tree.trunkBranchId, 'hi');
        return s.provider.chatCalls().at(-1)?.maxOutputTokens;
      }),
    );
    expect(caps[0]).toBeDefined();
    expect(new Set(caps).size).toBe(1);
  });
});
