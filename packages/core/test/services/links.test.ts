import { MAX_LINKS_PER_TREE, type TreeBackup } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError } from '../../src/errors.js';
import { ChatService, DEFAULT_CHAT_SETTINGS } from '../../src/services/chat-service.js';
import { registryOf, send, setup } from './helpers.js';

/**
 * trunk: q0 r0 q1 r1
 *   r0 ─ a: a0 a1
 *   r0 ─ b: b0 b1
 * plus a second tree of the same account, and a service acting as account `other`.
 */
async function fixture() {
  const ctx = setup({ autoTitle: false });
  const { chat, repos, provider } = ctx;
  const { tree } = await chat.createTree({ title: 'Primes' });
  const first = await send(chat, tree.trunkBranchId, 'What is a prime?');
  const second = await send(chat, tree.trunkBranchId, 'And 1?');
  const r0 = first.begin.assistantNode;
  const a = await chat.createBranch({ fromNodeId: r0.id, title: 'A' });
  const aMsg = await send(chat, a.id, 'in a');
  const b = await chat.createBranch({ fromNodeId: r0.id, title: 'B' });
  const bMsg = await send(chat, b.id, 'in b');
  const { tree: elsewhere } = await chat.createTree({ title: 'Elsewhere' });
  const far = await send(chat, elsewhere.trunkBranchId, 'Far away');
  const other = new ChatService({
    repos,
    providers: registryOf(provider),
    settings: { ...DEFAULT_CHAT_SETTINGS, autoTitle: false },
    accountId: 'other',
  });
  const { tree: theirs } = await other.createTree({ title: 'Theirs' });
  const foreign = await send(other, theirs.trunkBranchId, 'Not yours');
  return {
    ...ctx,
    other,
    tree,
    r0,
    q1: second.begin.userNode,
    r1: second.begin.assistantNode,
    a,
    a0: aMsg.begin.userNode,
    a1: aMsg.begin.assistantNode,
    b,
    b0: bMsg.begin.userNode,
    b1: bMsg.begin.assistantNode,
    elsewhere: far.begin.userNode,
    foreign: foreign.begin.userNode,
  };
}

describe('ChatService.createLink', () => {
  it('links two messages of a tree, bumps the tree and shows the link in its detail', async () => {
    const { chat, tree, r1, a1 } = await fixture();
    const before = (await chat.getTreeDetail(tree.id)).tree.updatedAt;

    const { link, created } = await chat.createLink({
      fromNodeId: r1.id,
      toNodeId: a1.id,
      note: '  same idea  ',
    });

    expect(created).toBe(true);
    expect(link).toMatchObject({
      treeId: tree.id,
      sourceNodeId: r1.id,
      targetNodeId: a1.id,
      note: 'same idea',
      origin: 'user',
    });
    expect(link.createdAt).toBe(link.updatedAt);
    const detail = await chat.getTreeDetail(tree.id);
    expect(detail.links).toEqual([link]);
    expect(detail.tree.updatedAt > before).toBe(true);
  });

  it('returns the existing link for a pair already linked, either way round', async () => {
    const { chat, tree, r1, a1 } = await fixture();
    const first = await chat.createLink({ fromNodeId: r1.id, toNodeId: a1.id });
    const again = await chat.createLink({ fromNodeId: r1.id, toNodeId: a1.id, note: 'x' });
    const reversed = await chat.createLink({ fromNodeId: a1.id, toNodeId: r1.id });
    expect(first.created).toBe(true);
    expect(again).toEqual({ link: first.link, created: false });
    expect(reversed).toEqual({ link: first.link, created: false });
    expect((await chat.getTreeDetail(tree.id)).links).toHaveLength(1);
  });

  it('stores a blank note as none', async () => {
    const { chat, r1, a1 } = await fixture();
    const { link } = await chat.createLink({ fromNodeId: r1.id, toNodeId: a1.id, note: '   ' });
    expect(link.note).toBeNull();
  });

  it('refuses a message linked to itself, and messages of two trees', async () => {
    const { chat, tree, r1, elsewhere } = await fixture();
    await expect(chat.createLink({ fromNodeId: r1.id, toNodeId: r1.id })).rejects.toThrow();
    await expect(
      chat.createLink({ fromNodeId: r1.id, toNodeId: elsewhere.id }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await chat.getTreeDetail(tree.id)).links).toEqual([]);
  });

  it('404s on unknown messages and on another account’s', async () => {
    const { chat, other, r1, foreign } = await fixture();
    await expect(chat.createLink({ fromNodeId: r1.id, toNodeId: 'gone' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      chat.createLink({ fromNodeId: r1.id, toNodeId: foreign.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      other.createLink({ fromNodeId: foreign.id, toNodeId: r1.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it(`refuses a link past ${MAX_LINKS_PER_TREE} in a tree, but still answers an existing pair`, async () => {
    const { chat, repos, tree, r1, a1, b1 } = await fixture();
    const existing = await chat.createLink({ fromNodeId: r1.id, toNodeId: a1.id });
    const links = repos.dump().links;
    for (let i = links.size; i < MAX_LINKS_PER_TREE; i++) {
      links.set(`filler${i}`, {
        ...existing.link,
        id: `filler${i}`,
        sourceNodeId: `x${i}`,
        targetNodeId: `y${i}`,
      });
    }
    await expect(chat.createLink({ fromNodeId: r1.id, toNodeId: b1.id })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await chat.createLink({ fromNodeId: a1.id, toNodeId: r1.id })).toEqual({
      link: existing.link,
      created: false,
    });
    expect((await chat.getTreeDetail(tree.id)).links).toHaveLength(MAX_LINKS_PER_TREE);
  });
});

describe('ChatService.updateLink / deleteLink', () => {
  it('changes the note (trimmed, blank = none) and its updatedAt', async () => {
    const { chat, tree, r1, a1 } = await fixture();
    const { link } = await chat.createLink({ fromNodeId: r1.id, toNodeId: a1.id });
    const noted = await chat.updateLink(link.id, { note: ' because ' });
    expect(noted).toMatchObject({ id: link.id, note: 'because', createdAt: link.createdAt });
    expect(noted.updatedAt > link.updatedAt).toBe(true);
    expect((await chat.updateLink(link.id, { note: '' })).note).toBeNull();
    expect((await chat.updateLink(link.id, { note: 'again' })).note).toBe('again');
    expect((await chat.updateLink(link.id, { note: null })).note).toBeNull();
    expect((await chat.getTreeDetail(tree.id)).links[0]?.note).toBeNull();
  });

  it('deletes a link once; a second delete is 404', async () => {
    const { chat, tree, r1, a1 } = await fixture();
    const { link } = await chat.createLink({ fromNodeId: r1.id, toNodeId: a1.id });
    await chat.deleteLink(link.id);
    expect((await chat.getTreeDetail(tree.id)).links).toEqual([]);
    await expect(chat.deleteLink(link.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(chat.updateLink(link.id, { note: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    // The pair can be linked again.
    expect((await chat.createLink({ fromNodeId: a1.id, toNodeId: r1.id })).created).toBe(true);
  });

  it('404s on another account’s link, and changes nothing', async () => {
    const { chat, other, tree, r1, a1 } = await fixture();
    const { link } = await chat.createLink({ fromNodeId: r1.id, toNodeId: a1.id, note: 'mine' });
    await expect(other.updateLink(link.id, { note: 'theirs' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(other.deleteLink(link.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(other.getTreeDetail(tree.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await chat.getTreeDetail(tree.id)).links).toEqual([link]);
  });
});

describe('links when messages go', () => {
  it('deleting a branch drops the links touching its subtree only', async () => {
    const { chat, tree, r0, r1, a, a1, b1 } = await fixture();
    const sub = await chat.createBranch({ fromNodeId: a1.id, title: 'A1' });
    const subMsg = await send(chat, sub.id, 'deeper');
    const doomedToTrunk = await chat.createLink({ fromNodeId: r1.id, toNodeId: a1.id });
    const doomedFromB = await chat.createLink({
      fromNodeId: b1.id,
      toNodeId: subMsg.begin.userNode.id,
    });
    const kept = await chat.createLink({ fromNodeId: r0.id, toNodeId: b1.id });

    await chat.deleteBranch(a.id);

    const links = (await chat.getTreeDetail(tree.id)).links;
    expect(links).toEqual([kept.link]);
    expect(links.some((l) => l.id === doomedToTrunk.link.id)).toBe(false);
    expect(links.some((l) => l.id === doomedFromB.link.id)).toBe(false);
  });

  it('deleting the tree drops its links, not other trees’', async () => {
    const { chat, repos, tree, r1, a1, elsewhere } = await fixture();
    await chat.createLink({ fromNodeId: r1.id, toNodeId: a1.id });
    const elsewhereTree = elsewhere.treeId;
    const farReply = (await chat.getTreeDetail(elsewhereTree)).nodes.find(
      (n) => n.role === 'assistant',
    )!;
    const keep = await chat.createLink({ fromNodeId: elsewhere.id, toNodeId: farReply.id });
    await chat.deleteTree(tree.id);
    expect([...repos.dump().links.values()]).toEqual([keep.link]);
  });
});

describe('links in backups', () => {
  it('exports the links and restores them on the new message ids', async () => {
    const { chat, tree, r1, a1, b0 } = await fixture();
    const l1 = await chat.createLink({ fromNodeId: r1.id, toNodeId: a1.id, note: 'why' });
    const l2 = await chat.createLink({ fromNodeId: b0.id, toNodeId: r1.id });
    const backup = await chat.exportBackup(tree.id);
    expect(backup.links).toEqual([l1.link, l2.link]);

    const restored = await chat.importBackup(backup);

    const contentOf = (id: string) => restored.nodes.find((n) => n.id === id)?.content;
    expect(restored.links).toHaveLength(2);
    for (const link of restored.links) {
      expect(link.treeId).toBe(restored.tree.id);
      expect([l1.link.id, l2.link.id]).not.toContain(link.id);
    }
    expect(
      restored.links.map((l) => [contentOf(l.sourceNodeId), contentOf(l.targetNodeId), l.note]),
    ).toEqual([
      ['reply to: And 1?', 'reply to: in a', 'why'],
      ['in b', 'reply to: And 1?', null],
    ]);
    expect((await chat.getTreeDetail(restored.tree.id)).links).toEqual(restored.links);
    // The original keeps its own.
    expect((await chat.getTreeDetail(tree.id)).links).toEqual([l1.link, l2.link]);
  });

  it('drops dangling, self and repeated links, and reads a backup without links', async () => {
    const { chat, tree, r1, a1, b1 } = await fixture();
    const { link } = await chat.createLink({ fromNodeId: r1.id, toNodeId: a1.id });
    const backup = await chat.exportBackup(tree.id);
    const tampered: TreeBackup = {
      ...backup,
      links: [
        link,
        { ...link, id: 'reversed', sourceNodeId: a1.id, targetNodeId: r1.id },
        { ...link, id: 'self', sourceNodeId: b1.id, targetNodeId: b1.id },
        { ...link, id: 'dangling', targetNodeId: 'not-in-backup' },
        { ...link, id: 'ok', sourceNodeId: b1.id, targetNodeId: a1.id, note: ' ' },
      ],
    };
    const restored = await chat.importBackup(tampered);
    expect(restored.links).toHaveLength(2);
    expect(restored.links[1]?.note).toBeNull();

    const { links: _links, ...old } = backup;
    expect((await chat.importBackup(old)).links).toEqual([]);
  });

  it('carries links into Learn (copy to Learn adapts the backup)', async () => {
    const { chat, repos, provider, tree, r1, a1 } = await fixture();
    await chat.createLink({ fromNodeId: r1.id, toNodeId: a1.id, note: 'see' });
    const learn = new ChatService({
      repos,
      accountId: 'u_learner',
      providers: registryOf(provider),
      profile: { kind: 'learn' },
      settings: { ...DEFAULT_CHAT_SETTINGS, autoTitle: false },
    });
    const lesson = await learn.importBackup(await chat.exportBackup(tree.id));
    expect(lesson.links).toHaveLength(1);
    expect(lesson.links[0]).toMatchObject({ treeId: lesson.tree.id, note: 'see' });
    expect((await learn.getTreeDetail(lesson.tree.id)).links).toEqual(lesson.links);
  });
});
