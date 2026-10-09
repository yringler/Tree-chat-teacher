import { DEFAULT_SYSTEM_PROMPT } from '@tangent/shared';
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
    expect(lesson.tree.systemPrompt).toBe('TUTOR');
    const powerTree = await s.power.createTree({});
    expect(powerTree.tree.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    const changed = s.learnWith('NEW TUTOR');
    expect(await systemSent(s.learnProvider, changed, lesson.tree.trunkBranchId)).toBe('NEW TUTOR');
    expect(await systemSent(s.learnProvider, changed, powerTree.tree.trunkBranchId)).toBe(
      'NEW TUTOR',
    );
  });

  it("new lessons get the tutor prompt, not the account's saved power prompt", async () => {
    const s = setup();
    await s.power.updateSettings({ systemPrompt: 'My power prompt.' });
    expect((await s.power.createTree({})).tree.systemPrompt).toBe('My power prompt.');
    expect((await s.learn.createTree({})).tree.systemPrompt).toBe('TUTOR');
    expect((await s.learn.createTree({ systemPrompt: 'Be brief.' })).tree.systemPrompt).toBe(
      'Be brief.',
    );
  });
});

describe("Power's system prompt", () => {
  it('sends the tree prompt as it is and ignores learner instructions', async () => {
    const s = setup();
    const { tree } = await s.power.createTree({ systemPrompt: 'Be terse.' });
    await s.power.updateTree(tree.id, { learnerInstructions: 'Answer in French.' });
    expect(await systemSent(s.powerProvider, s.power, tree.trunkBranchId)).toBe('Be terse.');
  });
});
