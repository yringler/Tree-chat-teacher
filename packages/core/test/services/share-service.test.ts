import { describe, expect, it } from 'vitest';
import { GoneError, NotFoundError, ValidationError } from '../../src/errors.js';
import { send, setup } from './helpers.js';

async function seeded() {
  const ctx = setup({ autoTitle: false });
  const { tree } = await ctx.chat.createTree({ title: 'Shared tree' });
  const first = await send(ctx.chat, tree.trunkBranchId, 'PUBLIC-ROOT');
  const side = await ctx.chat.createBranch({ fromNodeId: first.begin.assistantNode.id, title: 'Side' });
  await send(ctx.chat, side.id, 'PUBLIC-SIDE');
  const secret = await ctx.chat.createBranch({
    fromNodeId: first.begin.assistantNode.id,
    title: 'Secret',
    isPrivate: true,
  });
  const secretMsg = await send(ctx.chat, secret.id, 'PRIVATE-MARKER');
  return { ...ctx, tree, first, side, secret, secretMsg };
}

describe('ShareService', () => {
  it('creates a snapshot share that does not change until republished', async () => {
    const { shares, chat, tree } = await seeded();
    const summary = await shares.create({ treeId: tree.id, scope: 'tree' });
    expect(summary).toMatchObject({
      scope: 'tree',
      mode: 'snapshot',
      state: 'active',
      version: 1,
      url: 'https://tangent.test/s/token1',
      treeTitle: 'Shared tree',
    });
    const before = await shares.resolvePublic(summary.token);
    if (!before.ok) throw new Error('expected ok');
    const json = JSON.stringify(before.payload);
    expect(json).toContain('PUBLIC-SIDE');
    expect(json).not.toContain('PRIVATE-MARKER');

    await send(chat, tree.trunkBranchId, 'LATER-MESSAGE');
    const unchanged = await shares.resolvePublic(summary.token);
    expect(JSON.stringify(unchanged.ok && unchanged.payload)).not.toContain('LATER-MESSAGE');

    const republished = await shares.republish(summary.id);
    expect(republished.version).toBe(2);
    expect(republished.token).toBe(summary.token);
    const after = await shares.resolvePublic(summary.token);
    expect(JSON.stringify(after.ok && after.payload)).toContain('LATER-MESSAGE');
  });

  it('live shares reflect new messages', async () => {
    const { shares, chat, tree } = await seeded();
    const s = await shares.create({ treeId: tree.id, scope: 'tree', mode: 'live' });
    expect(s.publishedAt).toBeNull();
    await send(chat, tree.trunkBranchId, 'LIVE-UPDATE');
    const res = await shares.resolvePublic(s.token);
    expect(JSON.stringify(res.ok && res.payload)).toContain('LIVE-UPDATE');
  });

  it('revocation takes effect immediately and deletes the snapshot', async () => {
    const { shares, tree, repos } = await seeded();
    const s = await shares.create({ treeId: tree.id, scope: 'tree' });
    const revoked = await shares.revoke(s.id);
    expect(revoked.state).toBe('revoked');
    expect(await shares.resolvePublic(s.token)).toEqual({ ok: false, reason: 'gone' });
    expect(await shares.checkPublic(s.token)).toEqual({ ok: false, reason: 'gone' });
    expect(await repos.shares.getSnapshot(s.id)).toBeNull();
    await expect(shares.republish(s.id)).rejects.toBeInstanceOf(GoneError);
    // Idempotent.
    expect((await shares.revoke(s.id)).state).toBe('revoked');
  });

  it('deletes a share in any state: the link stops resolving and the share leaves the list', async () => {
    const { shares, tree, repos } = await seeded();
    const active = await shares.create({ treeId: tree.id, scope: 'tree' });
    const revoked = await shares.create({ treeId: tree.id, scope: 'tree', mode: 'live' });
    await shares.revoke(revoked.id);

    expect((await shares.delete(active.id)).token).toBe(active.token);
    expect(await shares.resolvePublic(active.token)).toEqual({ ok: false, reason: 'not_found' });
    expect(await repos.shares.getSnapshot(active.id)).toBeNull();
    expect((await shares.delete(revoked.id)).state).toBe('revoked');
    expect(await shares.list()).toEqual([]);

    await expect(shares.delete(active.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(shares.republish(active.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('expires', async () => {
    const { shares, tree, advance } = await seeded();
    const s = await shares.create({
      treeId: tree.id,
      scope: 'tree',
      expiresAt: new Date(Date.parse('2026-01-01T01:00:00Z')).toISOString(),
    });
    expect((await shares.checkPublic(s.token)).ok).toBe(true);
    advance(2 * 3600_000);
    expect(await shares.checkPublic(s.token)).toEqual({ ok: false, reason: 'gone' });
    expect((await shares.list())[0]?.state).toBe('expired');
  });

  it('rejects expiry in the past', async () => {
    const { shares, tree } = await seeded();
    await expect(
      shares.create({ treeId: tree.id, scope: 'tree', expiresAt: '2000-01-01T00:00:00Z' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses to share inside a private branch', async () => {
    const { shares, tree, secretMsg } = await seeded();
    await expect(
      shares.create({ treeId: tree.id, scope: 'path', nodeId: secretMsg.begin.assistantNode.id }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('live share whose target becomes private is gone', async () => {
    const { shares, chat, tree, side } = await seeded();
    const nodes = (await chat.getTreeDetail(tree.id)).nodes.filter((n) => n.branchId === side.id);
    const s = await shares.create({ treeId: tree.id, scope: 'subtree', nodeId: nodes[0]!.id, mode: 'live' });
    expect((await shares.resolvePublic(s.token)).ok).toBe(true);
    await chat.updateBranch(side.id, { isPrivate: true });
    expect(await shares.resolvePublic(s.token)).toEqual({ ok: false, reason: 'gone' });
  });

  it('unknown tokens are not found; views are counted', async () => {
    const { shares, tree } = await seeded();
    expect(await shares.resolvePublic('nope')).toEqual({ ok: false, reason: 'not_found' });
    const s = await shares.create({ treeId: tree.id, scope: 'tree', title: '  Custom  ' });
    expect(s.title).toBe('Custom');
    await shares.recordView(s.id);
    await shares.recordView(s.id);
    expect((await shares.list()).find((x) => x.id === s.id)?.viewCount).toBe(2);
  });

  it('updates title/expiry and 404s on unknown shares', async () => {
    const { shares, tree } = await seeded();
    const s = await shares.create({ treeId: tree.id, scope: 'tree' });
    const u = await shares.update(s.id, { title: 'New title' });
    expect(u.title).toBe('New title');
    await expect(shares.update('missing', { title: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(shares.create({ treeId: 'missing', scope: 'tree' })).rejects.toBeInstanceOf(NotFoundError);
  });
});
