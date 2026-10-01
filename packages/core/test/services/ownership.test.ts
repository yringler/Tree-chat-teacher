import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../../src/errors.js';
import { ChatService, DEFAULT_CHAT_SETTINGS } from '../../src/services/chat-service.js';
import { registryOf, send, setup } from './helpers.js';

async function drain<T>(events: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/**
 * The owner (default account) builds a tree with a side branch; a second
 * service over the same storage acts as account `other`.
 */
async function foreignTree() {
  const base = setup({ autoTitle: false });
  const other = new ChatService({
    repos: base.repos,
    providers: registryOf(base.provider),
    settings: { ...DEFAULT_CHAT_SETTINGS, autoTitle: false },
    accountId: 'other',
  });
  const { tree } = await base.chat.createTree({ title: 'Mine' });
  const root = await send(base.chat, tree.trunkBranchId, 'ROOT');
  const branch = await base.chat.createBranch({ fromNodeId: root.begin.assistantNode.id });
  return { ...base, other, tree, root, branch, reply: root.begin.assistantNode };
}

describe('ChatService branch/node ownership', () => {
  it('exposes owned rows through getOwnedBranch/getOwnedNode only', async () => {
    const { chat, other, branch, reply } = await foreignTree();
    expect((await chat.getOwnedBranch(branch.id)).id).toBe(branch.id);
    expect((await chat.getOwnedNode(reply.id)).id).toBe(reply.id);
    await expect(other.getOwnedBranch(branch.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(other.getOwnedNode(reply.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(chat.getOwnedBranch('missing')).rejects.toBeInstanceOf(NotFoundError);
    await expect(chat.getOwnedNode('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses to branch from a foreign node', async () => {
    const { repos, tree, other, reply } = await foreignTree();
    const before = await repos.trees.listBranches(tree.id);
    await expect(other.createBranch({ fromNodeId: reply.id })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await repos.trees.listBranches(tree.id)).toEqual(before);
  });

  it('refuses to update a foreign branch', async () => {
    const { repos, other, branch } = await foreignTree();
    await expect(other.updateBranch(branch.id, { title: 'hijacked' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect((await repos.trees.getBranch(branch.id))?.title).toBe(branch.title);
  });

  it('refuses to plan context in a foreign branch', async () => {
    const { other, tree, reply } = await foreignTree();
    await expect(
      other.planContext(tree.trunkBranchId, null, { resolveSummaries: false }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      other.planContext(tree.trunkBranchId, reply.id, { resolveSummaries: true }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses to send into a foreign branch', async () => {
    const { repos, provider, other, tree, branch } = await foreignTree();
    const callsBefore = provider.calls.length;
    const nodesBefore = await repos.trees.listNodes(tree.id);
    await expect(other.beginSend(branch.id, 'hi')).rejects.toBeInstanceOf(NotFoundError);
    await expect(other.beginSend(tree.trunkBranchId, 'hi')).rejects.toBeInstanceOf(NotFoundError);
    expect(await repos.trees.listNodes(tree.id)).toEqual(nodesBefore);
    expect(provider.calls).toHaveLength(callsBefore);
  });

  it('refuses to review a foreign reply', async () => {
    const { other, reply } = await foreignTree();
    await expect(
      other.prepareReview(reply.id, { providerId: 'scripted', model: 'm1' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses to delete a foreign branch', async () => {
    const { repos, other, branch } = await foreignTree();
    await expect(other.deleteBranch(branch.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await repos.trees.getBranch(branch.id)).not.toBeNull();
  });

  it('still lets the owner do all of it', async () => {
    const { chat, tree, branch, reply } = await foreignTree();
    await chat.updateBranch(branch.id, { title: 'Renamed' });
    const plan = await chat.planContext(branch.id, null, { resolveSummaries: false });
    expect(plan.plan.segments.length).toBeGreaterThan(0);
    const { last } = await send(chat, branch.id, 'SIDE');
    expect(last.type).toBe('done');
    const prepared = await chat.prepareReview(reply.id, { providerId: 'scripted', model: 'm1' });
    expect((await drain(chat.runReview(prepared, new AbortController().signal))).at(-1)?.type).toBe(
      'done',
    );
    expect((await chat.deleteBranch(branch.id)).treeId).toBe(tree.id);
  });
});
