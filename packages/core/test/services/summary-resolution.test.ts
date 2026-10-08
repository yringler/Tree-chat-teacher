import { describe, expect, it } from 'vitest';
import type { ChatService } from '../../src/services/chat-service.js';
import { send, setup } from './helpers.js';

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
