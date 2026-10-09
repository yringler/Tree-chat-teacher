import { DEFAULT_SYSTEM_PROMPT } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { ChatService, DEFAULT_CHAT_SETTINGS } from '../../src/services/chat-service.js';
import { createMemoryRepositories } from '../../src/memory/memory-repositories.js';
import type { GenerationProfile } from '../../src/services/profile.js';
import { registryOf, ScriptedProvider, send } from './helpers.js';

/**
 * One account seen by power, Learn with and without its custom prompt, and
 * the pool: Learn always sends its tutor prompt, and adds the tree's own
 * after it only where the profile allows (the learner pays with their own
 * key or credit).
 */
function setup() {
  const repos = createMemoryRepositories();
  const learnProvider = new ScriptedProvider('openrouter');
  let n = 0;
  const service = (profile: GenerationProfile, defaultSystemPrompt: string) =>
    new ChatService({
      repos,
      providers: registryOf(profile.kind === 'power' ? new ScriptedProvider('ant') : learnProvider),
      profile,
      defaultSystemPrompt,
      settings: { ...DEFAULT_CHAT_SETTINGS, autoTitle: false },
      newId: () => `id${++n}`,
    });
  return {
    learnProvider,
    power: service({ kind: 'power' }, DEFAULT_SYSTEM_PROMPT),
    learn: service({ kind: 'learn', customPrompt: true }, 'TUTOR'),
    learnPlain: service({ kind: 'learn', customPrompt: false }, 'TUTOR'),
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

/** The system prompt of the latest chat call `chat` made on `branchId`. */
async function systemSent(
  s: ReturnType<typeof setup>,
  chat: ChatService,
  branchId: string,
): Promise<string | null | undefined> {
  await send(chat, branchId, 'hi');
  return s.learnProvider.chatCalls().at(-1)?.system;
}

describe("Learn's system prompt", () => {
  it('adds the tree prompt after the tutor prompt where custom prompts are allowed', async () => {
    const s = setup();
    const { tree } = await s.power.createTree({ systemPrompt: 'Answer in French.' });
    expect(await systemSent(s, s.learn, tree.trunkBranchId)).toBe('TUTOR\n\nAnswer in French.');
  });

  it('sends the tutor prompt alone where they are not, and the pool its locked prompt', async () => {
    const s = setup();
    const { tree } = await s.power.createTree({ systemPrompt: 'Answer in French.' });
    expect(await systemSent(s, s.learnPlain, tree.trunkBranchId)).toBe('TUTOR');
    expect(await systemSent(s, s.pool, tree.trunkBranchId)).toBe('POOL');
    // The tree keeps its prompt for power.
    expect((await s.power.getTreeDetail(tree.id)).tree.systemPrompt).toBe('Answer in French.');
  });

  it('adds nothing for a tree with no prompt or a built-in one', async () => {
    const s = setup();
    const lesson = await s.learn.createTree({});
    expect(lesson.tree.systemPrompt).toBe('TUTOR');
    expect(await systemSent(s, s.learn, lesson.tree.trunkBranchId)).toBe('TUTOR');
    const powerTree = await s.power.createTree({});
    expect(powerTree.tree.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(await systemSent(s, s.learn, powerTree.tree.trunkBranchId)).toBe('TUTOR');
    const cleared = await s.power.createTree({});
    await s.power.updateTree(cleared.tree.id, { systemPrompt: null });
    expect(await systemSent(s, s.learn, cleared.tree.trunkBranchId)).toBe('TUTOR');
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
