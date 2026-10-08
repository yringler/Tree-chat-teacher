import { createProviderRegistry } from '@tangent/providers';
import type { ProviderRegistry } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { ChatService, DEFAULT_CHAT_SETTINGS } from '../../src/services/chat-service.js';
import { createMemoryRepositories } from '../../src/testing/memory-repositories.js';
import { registryOf, ScriptedProvider, send, setup } from './helpers.js';

/**
 * A trunk exchange, then `depth` summary-mode branches, each from the last
 * reply of the one before, with one exchange each. Returns the deepest branch.
 */
async function nestedSummaryBranches(chat: ChatService, depth: number): Promise<string> {
  const { tree } = await chat.createTree({});
  let reply = (await send(chat, tree.trunkBranchId, 'ROOT')).begin.assistantNode.id;
  let branchId = tree.trunkBranchId;
  for (let level = 1; level <= depth; level++) {
    const branch = await chat.createBranch({ fromNodeId: reply, contextMode: 'summary' });
    branchId = branch.id;
    reply = (await send(chat, branchId, `LEVEL-${level}`)).begin.assistantNode.id;
  }
  return branchId;
}

describe('ChatService summary resolution', () => {
  it.each([5, 6])('generates the outer summary of %i nested summary branches', async (depth) => {
    const { chat, provider } = setup({ autoTitle: false });
    const deepest = await nestedSummaryBranches(chat, depth);
    // One new summary per level; the inner ones come from the cache.
    expect(provider.summaryCalls()).toHaveLength(depth);
    const last = provider.chatCalls().at(-1)!;
    expect(last.system ?? '').toContain('SUMMARY(');
    const plan = await chat.planContext(deepest, null, { resolveSummaries: false });
    expect(plan.plan.complete).toBe(true);
  });

});

describe('ChatService summary provider', () => {
  /** The scripted provider, plus a real registry's `anthropic` entry with no key. */
  function withKeylessSummaryProvider(provider: ScriptedProvider): ProviderRegistry {
    const keyless = createProviderRegistry(
      [
        {
          id: 'anthropic',
          kind: 'anthropic',
          label: 'Anthropic',
          apiKeySecret: 'ANTHROPIC_API_KEY',
          defaultModel: 'claude-haiku-4-5',
          models: [{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }],
        },
      ],
      { secrets: {} },
    );
    const own = registryOf(provider);
    return {
      get: (id) => own.get(id) ?? keyless.get(id),
      list: () => [...own.list(), ...keyless.list()],
      defaultProviderId: () => own.defaultProviderId(),
    };
  }

  it('summarizes and titles on the branch’s own route when the summary provider is unavailable', async () => {
    const provider = new ScriptedProvider();
    const chat = new ChatService({
      repos: createMemoryRepositories(),
      providers: withKeylessSummaryProvider(provider),
      settings: {
        ...DEFAULT_CHAT_SETTINGS,
        summaryProviderId: 'anthropic',
        summaryModel: 'claude-haiku-4-5',
      },
    });
    const { tree } = await chat.createTree({ providerId: 'scripted' });
    const root = await send(chat, tree.trunkBranchId, 'ROOT');
    const branch = await chat.createBranch({
      fromNodeId: root.begin.assistantNode.id,
      contextMode: 'summary',
    });
    const { last } = await send(chat, branch.id, 'Q');
    expect(provider.summaryCalls()).toHaveLength(1);
    expect(provider.summaryCalls()[0]!.model).toBe('m1');
    expect(provider.chatCalls().at(-1)!.system ?? '').toContain('SUMMARY(');
    expect(last).toMatchObject({ type: 'done', branch: { title: 'Scripted Title' } });
  });
});
