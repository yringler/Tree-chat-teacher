import type { GenerateRequest, ProviderEvent, ReviewEvent, UsageTag } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { ChatService, DEFAULT_CHAT_SETTINGS } from '../../src/services/chat-service.js';
import { createMemoryRepositories } from '../../src/testing/memory-repositories.js';
import { registryOf, ScriptedProvider, send } from './helpers.js';

/**
 * Scripted provider that interleaves `billing` events the way the
 * OpenRouter adapter does: one with the generation id before any delta, one
 * with the cost before `done`, and a late one after `done`.
 */
class BillingProvider extends ScriptedProvider {
  override async *stream(req: GenerateRequest): AsyncIterable<ProviderEvent> {
    yield { type: 'billing', generationId: 'gen-1' };
    for await (const event of super.stream(req)) {
      if (event.type === 'done') yield { type: 'billing', generationId: 'gen-1', costUsd: 0.0012 };
      yield event;
    }
    yield { type: 'billing', costUsd: 0.0013 };
  }
}

function setupWith(provider: ScriptedProvider, autoTitle = true) {
  const repos = createMemoryRepositories();
  const reviewer = new ScriptedProvider('reviewer');
  let n = 0;
  const chat = new ChatService({
    repos,
    providers: registryOf(provider, reviewer),
    settings: { ...DEFAULT_CHAT_SETTINGS, autoTitle },
    newId: () => `id${(++n).toString().padStart(4, '0')}`,
  });
  return { repos, provider, reviewer, chat };
}

async function drain<T>(events: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const tags = (calls: GenerateRequest[]): (UsageTag | undefined)[] => calls.map((c) => c.usageTag);

describe('ChatService usage tags', () => {
  it('tags replies, summaries, titles and reviews', async () => {
    const { chat, provider, reviewer } = setupWith(new ScriptedProvider());
    const { tree } = await chat.createTree({});

    // Trunk reply, then the tree title.
    const root = await send(chat, tree.trunkBranchId, 'ROOT');
    expect(root.last.type).toBe('done');
    expect(tags(provider.calls)).toEqual([
      { purpose: 'reply', treeId: tree.id, nodeId: root.begin.assistantNode.id },
      { purpose: 'title', treeId: tree.id, nodeId: null },
    ]);
    expect(provider.kindOf(provider.calls[1]!)).toBe('title');

    // Summary-mode branch: summary of the parent, reply, branch title.
    provider.calls.length = 0;
    const branch = await chat.createBranch({
      fromNodeId: root.begin.assistantNode.id,
      contextMode: 'summary',
    });
    const side = await send(chat, branch.id, 'SIDE');
    expect(side.last.type).toBe('done');
    expect(provider.calls.map((c) => provider.kindOf(c))).toEqual(['summary', 'chat', 'title']);
    expect(tags(provider.calls)).toEqual([
      { purpose: 'summary', treeId: tree.id, nodeId: null },
      { purpose: 'reply', treeId: tree.id, nodeId: side.begin.assistantNode.id },
      { purpose: 'title', treeId: tree.id, nodeId: null },
    ]);

    // Review of the side reply (the summary is cached, so only the reviewer runs).
    provider.calls.length = 0;
    const prepared = await chat.prepareReview(side.begin.assistantNode.id, {
      providerId: 'reviewer',
      model: 'm1',
    });
    const review = await drain<ReviewEvent>(chat.runReview(prepared, new AbortController().signal));
    expect(review.at(-1)?.type).toBe('done');
    expect(provider.calls).toEqual([]);
    expect(tags(reviewer.calls)).toEqual([
      { purpose: 'review', treeId: tree.id, nodeId: side.begin.assistantNode.id },
    ]);
  });

  it('tags summaries resolved through planContext', async () => {
    const { chat, provider } = setupWith(new ScriptedProvider(), false);
    const { tree } = await chat.createTree({});
    const root = await send(chat, tree.trunkBranchId, 'ROOT');
    const branch = await chat.createBranch({
      fromNodeId: root.begin.assistantNode.id,
      contextMode: 'summary',
    });
    provider.calls.length = 0;
    await chat.planContext(branch.id, null, { resolveSummaries: true });
    expect(tags(provider.calls)).toEqual([{ purpose: 'summary', treeId: tree.id, nodeId: null }]);
  });
});

describe('ChatService with billing events', () => {
  it('completes replies, summaries and titles normally and stores only the text', async () => {
    const { chat, repos, provider } = setupWith(new BillingProvider());
    const { tree } = await chat.createTree({});
    const root = await send(chat, tree.trunkBranchId, 'ROOT');
    expect(root.last).toMatchObject({
      type: 'done',
      node: {
        content: 'reply to: ROOT',
        status: 'complete',
        usage: { inputTokens: 10, outputTokens: 3 },
      },
    });
    expect(root.events.map((e) => e.type)).not.toContain('billing');
    const stored = await repos.trees.getNode(root.begin.assistantNode.id);
    expect(stored).toMatchObject({ content: 'reply to: ROOT', status: 'complete', error: null });
    expect((await repos.trees.getTree(tree.id))?.title).toBe('Scripted Title');

    const branch = await chat.createBranch({
      fromNodeId: root.begin.assistantNode.id,
      contextMode: 'summary',
    });
    const side = await send(chat, branch.id, 'SIDE');
    expect(side.last).toMatchObject({ type: 'done', branch: { title: 'Scripted Title' } });
    expect(provider.summaryCalls()).toHaveLength(1);
    const plan = await chat.planContext(branch.id, null, { resolveSummaries: false });
    expect(plan.rendered.system ?? '').toContain('SUMMARY(');
    expect((await repos.trees.getNode(side.begin.assistantNode.id))?.content).toBe(
      'reply to: SIDE',
    );
  });

  it('completes reviews normally', async () => {
    const reviewer = new BillingProvider('reviewer');
    const repos = createMemoryRepositories();
    const provider = new ScriptedProvider();
    const chat = new ChatService({
      repos,
      providers: registryOf(provider, reviewer),
      settings: { ...DEFAULT_CHAT_SETTINGS, autoTitle: false },
    });
    const { tree } = await chat.createTree({});
    const root = await send(chat, tree.trunkBranchId, 'ROOT');
    const prepared = await chat.prepareReview(root.begin.assistantNode.id, {
      providerId: 'reviewer',
      model: 'm1',
    });
    const events = await drain<ReviewEvent>(chat.runReview(prepared, new AbortController().signal));
    expect(events.map((e) => e.type)).not.toContain('billing');
    expect(events.at(-1)).toEqual({
      type: 'done',
      providerId: 'reviewer',
      model: 'm1',
      usage: { inputTokens: 10, outputTokens: 3 },
    });
  });
});
