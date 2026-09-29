import { describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '../../src/errors.js';
import { DEFAULT_TREE_TITLE, TRUNK_TITLE } from '../../src/services/chat-service.js';
import { send, setup } from './helpers.js';

describe('ChatService trees and branches', () => {
  it('creates a tree with an empty trunk using the default provider', async () => {
    const { chat } = setup();
    const detail = await chat.createTree({});
    expect(detail.tree.title).toBe(DEFAULT_TREE_TITLE);
    expect(detail.branches).toHaveLength(1);
    const trunk = detail.branches[0]!;
    expect(trunk).toMatchObject({
      id: detail.tree.trunkBranchId,
      parentBranchId: null,
      branchPointNodeId: null,
      title: TRUNK_TITLE,
      providerId: 'scripted',
      model: 'm1',
    });
    expect(detail.nodes).toEqual([]);
  });

  it('rejects unknown providers', async () => {
    const { chat } = setup();
    await expect(chat.createTree({ providerId: 'nope' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('creates branches that inherit provider/model and default their title', async () => {
    const { chat } = setup();
    const { tree } = await chat.createTree({ title: 'T' });
    const { begin } = await send(chat, tree.trunkBranchId, 'Explain monads in detail please');
    const branch = await chat.createBranch({
      fromNodeId: begin.assistantNode.id,
      contextMode: 'summary',
      anchorQuote: '  bind operator  ',
    });
    expect(branch).toMatchObject({
      parentBranchId: tree.trunkBranchId,
      branchPointNodeId: begin.assistantNode.id,
      contextMode: 'summary',
      anchorQuote: 'bind operator',
      providerId: 'scripted',
      model: 'm1',
      titleSource: 'default',
      isPrivate: false,
    });
    expect(branch.title).toContain('bind operator');
  });

  it('refuses to set a mode on the trunk', async () => {
    const { chat } = setup();
    const { tree } = await chat.createTree({});
    await expect(
      chat.updateBranch(tree.trunkBranchId, { contextMode: 'independent' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('marks user-edited titles', async () => {
    const { chat } = setup();
    const { tree } = await chat.createTree({});
    const b = await chat.updateBranch(tree.trunkBranchId, { title: 'Renamed' });
    expect(b).toMatchObject({ title: 'Renamed', titleSource: 'user' });
  });

  it('404s on missing things', async () => {
    const { chat } = setup();
    await expect(chat.getTreeDetail('x')).rejects.toBeInstanceOf(NotFoundError);
    await expect(chat.createBranch({ fromNodeId: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(chat.beginSend('x', 'hi')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('ChatService sending', () => {
  it('streams a reply and persists it with usage', async () => {
    const { chat, repos } = setup({ autoTitle: false });
    const { tree } = await chat.createTree({});
    const { begin, events, last } = await send(chat, tree.trunkBranchId, 'Hello there');
    expect(begin.userNode).toMatchObject({ seq: 0, parentId: null, role: 'user', status: 'complete' });
    expect(begin.assistantNode).toMatchObject({ seq: 1, parentId: begin.userNode.id, status: 'streaming' });
    const text = events
      .filter((e) => e.type === 'delta')
      .map((e) => (e.type === 'delta' ? e.text : ''))
      .join('');
    expect(text).toBe('reply to: Hello there');
    expect(last.type).toBe('done');
    const stored = await repos.trees.getNode(begin.assistantNode.id);
    expect(stored).toMatchObject({
      content: 'reply to: Hello there',
      status: 'complete',
      usage: { inputTokens: 10, outputTokens: 3 },
    });
  });

  it('appends to the branch leaf on normal replies', async () => {
    const { chat } = setup({ autoTitle: false });
    const { tree } = await chat.createTree({});
    const first = await send(chat, tree.trunkBranchId, 'one');
    const second = await send(chat, tree.trunkBranchId, 'two');
    expect(second.begin.userNode.parentId).toBe(first.begin.assistantNode.id);
    expect(second.begin.userNode.seq).toBe(2);
  });

  it('starts an empty branch at its branch point', async () => {
    const { chat } = setup({ autoTitle: false });
    const { tree } = await chat.createTree({});
    const first = await send(chat, tree.trunkBranchId, 'one');
    const branch = await chat.createBranch({ fromNodeId: first.begin.userNode.id });
    const { begin } = await send(chat, branch.id, 'side question');
    expect(begin.userNode).toMatchObject({ branchId: branch.id, seq: 0, parentId: first.begin.userNode.id });
  });

  it('rejects a second send while the leaf is streaming', async () => {
    const { chat } = setup();
    const { tree } = await chat.createTree({});
    await chat.beginSend(tree.trunkBranchId, 'first');
    await expect(chat.beginSend(tree.trunkBranchId, 'second')).rejects.toBeInstanceOf(ConflictError);
  });

  it('sends only the path context: siblings never leak', async () => {
    const { chat, provider } = setup({ autoTitle: false });
    const { tree } = await chat.createTree({});
    const root = await send(chat, tree.trunkBranchId, 'ROOT');
    const a = await chat.createBranch({ fromNodeId: root.begin.assistantNode.id });
    const b = await chat.createBranch({ fromNodeId: root.begin.assistantNode.id });
    await send(chat, a.id, 'SIBLING-A');
    await send(chat, b.id, 'IN-B');
    const lastCall = provider.chatCalls().at(-1)!;
    const all = JSON.stringify(lastCall.messages);
    expect(all).toContain('ROOT');
    expect(all).toContain('IN-B');
    expect(all).not.toContain('SIBLING-A');
  });

  it('independent branches send no ancestor content', async () => {
    const { chat, provider } = setup({ autoTitle: false });
    const { tree } = await chat.createTree({});
    const root = await send(chat, tree.trunkBranchId, 'SECRET-ROOT');
    const b = await chat.createBranch({
      fromNodeId: root.begin.assistantNode.id,
      contextMode: 'independent',
      anchorQuote: 'topic quote',
    });
    await send(chat, b.id, 'fresh start');
    const call = provider.chatCalls().at(-1)!;
    expect(JSON.stringify(call)).not.toContain('SECRET-ROOT');
    expect(call.system ?? '').toContain('topic quote');
  });

  it('summary branches generate, cache and reuse summaries', async () => {
    const { chat, provider, repos } = setup({ autoTitle: false });
    const { tree } = await chat.createTree({});
    const root = await send(chat, tree.trunkBranchId, 'long discussion');
    const b = await chat.createBranch({ fromNodeId: root.begin.assistantNode.id, contextMode: 'summary' });
    const first = await send(chat, b.id, 'follow up');
    expect(first.events.some((e) => e.type === 'status')).toBe(true);
    expect(provider.summaryCalls()).toHaveLength(1);
    expect(repos.dump().summaries.size).toBe(1);
    const call = provider.chatCalls().at(-1)!;
    expect(call.system ?? '').toContain('SUMMARY(');
    expect(JSON.stringify(call.messages)).not.toContain('long discussion');

    // Same ancestor path → cache hit, no new summary call.
    await send(chat, b.id, 'another');
    expect(provider.summaryCalls()).toHaveLength(1);

    // Inspector sees the cached summary without resolving.
    const plan = await chat.planContext(b.id, null, { resolveSummaries: false });
    const summary = plan.plan.segments.find((s) => s.kind === 'summary');
    expect(summary).toMatchObject({ status: 'ready' });
  });

  it('planContext without resolve leaves summaries pending', async () => {
    const { chat, provider } = setup({ autoTitle: false });
    const { tree } = await chat.createTree({});
    const root = await send(chat, tree.trunkBranchId, 'x');
    const b = await chat.createBranch({ fromNodeId: root.begin.assistantNode.id, contextMode: 'summary' });
    const res = await chat.planContext(b.id, null, { resolveSummaries: false });
    expect(res.plan.complete).toBe(false);
    expect(res.plan.pendingSummaries).toHaveLength(1);
    expect(provider.summaryCalls()).toHaveLength(0);
    const resolved = await chat.planContext(b.id, null, { resolveSummaries: true });
    expect(resolved.plan.complete).toBe(true);
    expect(resolved.providerId).toBe('scripted');
  });

  it('persists partial content with an error on provider failure', async () => {
    const { chat, provider, repos } = setup({ autoTitle: false });
    const { tree } = await chat.createTree({});
    provider.failNext = 'boom';
    const { begin, last } = await send(chat, tree.trunkBranchId, 'hi');
    expect(last).toMatchObject({ type: 'error', message: 'boom' });
    const stored = await repos.trees.getNode(begin.assistantNode.id);
    expect(stored).toMatchObject({ status: 'error', error: 'boom', content: 'reply' });
  });

  it('cancels via AbortSignal and keeps partial content', async () => {
    const { chat, provider, repos } = setup({ autoTitle: false });
    provider.delayMs = 5;
    const { tree } = await chat.createTree({});
    const begin = await chat.beginSend(tree.trunkBranchId, 'a long question here');
    const ctrl = new AbortController();
    const events = [];
    for await (const e of chat.runGeneration(begin, ctrl.signal)) {
      events.push(e);
      if (e.type === 'delta') ctrl.abort();
    }
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'Cancelled' });
    const stored = await repos.trees.getNode(begin.assistantNode.id);
    expect(stored?.status).toBe('error');
    expect(stored?.content.length).toBeGreaterThan(0);
  });

  it('auto-titles a default-titled branch and the tree', async () => {
    const { chat, repos } = setup();
    const { tree } = await chat.createTree({});
    const root = await send(chat, tree.trunkBranchId, 'q');
    expect((await repos.trees.getTree(tree.id))?.title).toBe('Scripted Title');
    const b = await chat.createBranch({ fromNodeId: root.begin.assistantNode.id });
    const { last } = await send(chat, b.id, 'side');
    expect(last).toMatchObject({ type: 'done', branch: { title: 'Scripted Title', titleSource: 'auto' } });
    // Only after the first reply.
    const again = await send(chat, b.id, 'more');
    expect(again.last.type).toBe('done');
  });

  it('recovers interrupted streaming nodes', async () => {
    const { chat, repos } = setup();
    const { tree } = await chat.createTree({});
    const begin = await chat.beginSend(tree.trunkBranchId, 'hi');
    expect(await chat.recoverInterrupted(tree.id)).toBe(1);
    expect((await repos.trees.getNode(begin.assistantNode.id))?.status).toBe('error');
    // Branch is usable again.
    await expect(chat.beginSend(tree.trunkBranchId, 'again')).resolves.toBeDefined();
  });
});

describe('ChatService backup', () => {
  it('round-trips a tree under fresh ids', async () => {
    const { chat } = setup({ autoTitle: false });
    const { tree } = await chat.createTree({ title: 'Backup me', systemPrompt: 'Be brief' });
    const root = await send(chat, tree.trunkBranchId, 'hello');
    const b = await chat.createBranch({ fromNodeId: root.begin.assistantNode.id, isPrivate: true });
    await send(chat, b.id, 'private stuff');
    const backup = await chat.exportBackup(tree.id);
    expect(backup.nodes).toHaveLength(4);
    const restored = await chat.importBackup(backup);
    expect(restored.tree.id).not.toBe(tree.id);
    expect(restored.tree.title).toBe('Backup me');
    expect(restored.branches).toHaveLength(2);
    const ids = new Set([...backup.nodes.map((n) => n.id), ...backup.branches.map((x) => x.id)]);
    for (const n of restored.nodes) {
      expect(ids.has(n.id)).toBe(false);
      if (n.parentId) expect(restored.nodes.some((m) => m.id === n.parentId)).toBe(true);
    }
    const priv = restored.branches.find((x) => x.isPrivate)!;
    expect(restored.nodes.some((n) => n.id === priv.branchPointNodeId)).toBe(true);
    // Restored tree is fully usable.
    const detail = await chat.getTreeDetail(restored.tree.id);
    expect(detail.nodes).toHaveLength(4);
  });

  it('rejects malformed backups', async () => {
    const { chat } = setup();
    await expect(
      chat.importBackup({ format: 'tangent-tree-backup', version: 1 } as never),
    ).rejects.toThrow();
  });
});
