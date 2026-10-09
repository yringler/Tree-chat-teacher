import { describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '../../src/errors.js';
import {
  ChatService,
  DEFAULT_CHAT_SETTINGS,
  type CandidateRunEvent,
  type ChatSettings,
  type HeldCandidate,
} from '../../src/services/chat-service.js';
import { createMemoryRepositories } from '../../src/memory/memory-repositories.js';
import { registryOf, ScriptedProvider, send } from './helpers.js';

function setupCompare(settings: Partial<ChatSettings> = {}) {
  const repos = createMemoryRepositories();
  const provider = new ScriptedProvider();
  const other = new ScriptedProvider('other');
  let t = Date.parse('2026-01-01T00:00:00Z');
  let n = 0;
  const deps = {
    repos,
    providers: registryOf(provider, other),
    settings: { ...DEFAULT_CHAT_SETTINGS, autoTitle: false, ...settings },
    clock: () => new Date((t += 1000)),
    newId: () => `id${(++n).toString().padStart(4, '0')}`,
  };
  const chat = new ChatService(deps);
  const stranger = new ChatService({ ...deps, accountId: 'someone-else' });
  return { repos, provider, other, chat, stranger };
}

async function collect(events: AsyncIterable<CandidateRunEvent>): Promise<CandidateRunEvent[]> {
  const out: CandidateRunEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/** Prepares and runs a candidate; returns its events and the held candidate. */
async function ask(
  chat: ChatService,
  branchId: string,
  content: string,
  route: { model: string; providerId?: string },
  signal = new AbortController().signal,
) {
  const prepared = await chat.prepareCandidate(branchId, { content, ...route });
  const events = await collect(chat.runCandidate(prepared, signal));
  const last = events.at(-1)!;
  const held: HeldCandidate | null = last.type === 'done' ? last.candidate : null;
  return { prepared, events, last, held };
}

describe('ChatService compare candidates', () => {
  it('answers the question after the leaf without storing anything', async () => {
    const { chat, provider } = setupCompare();
    const { tree } = await chat.createTree({ systemPrompt: 'TREE-SYSTEM' });
    const first = await send(chat, tree.trunkBranchId, 'FIRST');
    const before = await chat.getTreeDetail(tree.id);

    const { events, held, prepared } = await ask(chat, tree.trunkBranchId, 'COMPARE-Q', {
      model: 'm1',
    });

    expect(prepared.parentId).toBe(first.begin.assistantNode.id);
    expect(events.filter((e) => e.type === 'delta').length).toBeGreaterThan(0);
    // Usage is reported once, on the candidate.
    expect(events.some((e) => (e as { type: string }).type === 'usage')).toBe(false);
    expect(held).toMatchObject({
      id: prepared.id,
      treeId: tree.id,
      branchId: tree.trunkBranchId,
      parentId: first.begin.assistantNode.id,
      question: 'COMPARE-Q',
      content: 'reply to: COMPARE-Q',
      providerId: 'scripted',
      funding: 'own-key',
      model: 'm1',
      usage: { inputTokens: 10, outputTokens: 3 },
      sources: null,
    });
    // The context is the conversation so far plus the question as the last user turn.
    const call = provider.chatCalls().at(-1)!;
    expect(call.system).toContain('TREE-SYSTEM');
    expect(call.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'FIRST'],
      ['assistant', 'reply to: FIRST'],
      ['user', 'COMPARE-Q'],
    ]);
    expect(await chat.getTreeDetail(tree.id)).toEqual(before);
  });

  it('runs on the candidate’s route and model, metered as a reply without a node', async () => {
    const { chat, provider, other } = setupCompare();
    const { tree } = await chat.createTree({});
    await send(chat, tree.trunkBranchId, 'hi');
    const sameRoute = await ask(chat, tree.trunkBranchId, 'Q', { model: 'big' });
    const call = provider.chatCalls().at(-1)!;
    expect(call.model).toBe('big');
    expect(call.usageTag).toEqual({
      purpose: 'reply',
      treeId: tree.id,
      branchId: tree.trunkBranchId,
      nodeId: null,
    });
    expect(sameRoute.held?.model).toBe('big');

    const otherRoute = await ask(chat, tree.trunkBranchId, 'Q', {
      providerId: 'other',
      model: 'o1',
    });
    expect(other.chatCalls()).toHaveLength(1);
    expect(other.chatCalls()[0]!.model).toBe('o1');
    expect(otherRoute.held).toMatchObject({ providerId: 'other', funding: 'own-key', model: 'o1' });
    // The branch keeps its own route and model.
    const branch = await chat.getOwnedBranch(tree.trunkBranchId);
    expect(branch).toMatchObject({ providerId: 'scripted', model: 'm1' });
  });

  it('refuses an empty question, a streaming leaf, unknown providers and foreign branches', async () => {
    const { chat, stranger } = setupCompare();
    const { tree } = await chat.createTree({});
    const branchId = tree.trunkBranchId;
    await expect(
      chat.prepareCandidate(branchId, { content: '  ', model: 'm1' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      chat.prepareCandidate(branchId, { content: 'q', model: 'm1', providerId: 'nope' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      stranger.prepareCandidate(branchId, { content: 'q', model: 'm1' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await chat.beginSend(branchId, 'pending');
    await expect(
      chat.prepareCandidate(branchId, { content: 'q', model: 'm1' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('commits the picked candidate as a normal exchange; the branch keeps its model', async () => {
    const { chat, provider } = setupCompare();
    const { tree } = await chat.createTree({});
    const first = await send(chat, tree.trunkBranchId, 'FIRST');
    const { held } = await ask(chat, tree.trunkBranchId, 'PICKED-Q', { model: 'big' });

    const result = await chat.commitCandidate(held!);

    expect(result.userNode).toMatchObject({
      branchId: tree.trunkBranchId,
      parentId: first.begin.assistantNode.id,
      seq: 2,
      role: 'user',
      content: 'PICKED-Q',
      status: 'complete',
    });
    expect(result.assistantNode).toMatchObject({
      parentId: result.userNode.id,
      seq: 3,
      role: 'assistant',
      content: 'reply to: PICKED-Q',
      status: 'complete',
      error: null,
      providerId: 'scripted',
      model: 'big',
      usage: { inputTokens: 10, outputTokens: 3 },
      sources: null,
    });
    expect(result.branch.model).toBe('m1');
    const detail = await chat.getTreeDetail(tree.id);
    expect(detail.nodes.map((n) => n.content)).toEqual([
      'FIRST',
      'reply to: FIRST',
      'PICKED-Q',
      'reply to: PICKED-Q',
    ]);
    // The next send continues after the committed exchange, on the branch's model.
    await send(chat, tree.trunkBranchId, 'NEXT');
    const next = provider.chatCalls().at(-1)!;
    expect(next.model).toBe('m1');
    expect(next.messages.map((m) => m.content)).toContain('reply to: PICKED-Q');
  });

  it('refuses a commit once the branch moved on, a second commit, and a foreign account', async () => {
    const { chat, stranger } = setupCompare();
    const { tree } = await chat.createTree({});
    await send(chat, tree.trunkBranchId, 'FIRST');
    const a = await ask(chat, tree.trunkBranchId, 'Q', { model: 'm1' });
    const b = await ask(chat, tree.trunkBranchId, 'Q', { model: 'big' });
    await expect(stranger.commitCandidate(a.held!)).rejects.toBeInstanceOf(NotFoundError);

    await chat.commitCandidate(a.held!);
    // The sibling was asked at the same leaf, which is no longer the leaf.
    await expect(chat.commitCandidate(b.held!)).rejects.toBeInstanceOf(ConflictError);
    await expect(chat.commitCandidate(a.held!)).rejects.toBeInstanceOf(ConflictError);

    const c = await ask(chat, tree.trunkBranchId, 'LATE', { model: 'm1' });
    await send(chat, tree.trunkBranchId, 'SENT MEANWHILE');
    await expect(chat.commitCandidate(c.held!)).rejects.toThrow(/moved on/);

    const d = await ask(chat, tree.trunkBranchId, 'WHILE STREAMING', { model: 'm1' });
    await chat.beginSend(tree.trunkBranchId, 'pending');
    await expect(chat.commitCandidate(d.held!)).rejects.toThrow(/still being generated/);
  });

  it('answers and commits in an empty branch, after its branch point', async () => {
    const { chat, provider } = setupCompare();
    const { tree } = await chat.createTree({});
    const root = await send(chat, tree.trunkBranchId, 'ROOT');
    const branch = await chat.createBranch({ fromNodeId: root.begin.assistantNode.id });

    const { held } = await ask(chat, branch.id, 'SIDE-Q', { model: 'm1' });
    expect(held?.parentId).toBe(root.begin.assistantNode.id);
    expect(
      provider
        .chatCalls()
        .at(-1)!
        .messages.map((m) => m.content),
    ).toEqual(['ROOT', 'reply to: ROOT', 'SIDE-Q']);

    const { userNode, assistantNode } = await chat.commitCandidate(held!);
    expect(userNode).toMatchObject({
      branchId: branch.id,
      parentId: root.begin.assistantNode.id,
      seq: 0,
    });
    expect(assistantNode).toMatchObject({ branchId: branch.id, seq: 1 });
  });

  it('resolves and caches summaries once, so the second candidate reuses them', async () => {
    const { chat, provider } = setupCompare({
      summaryProviderId: 'scripted',
      summaryModel: 'lite',
    });
    const { tree } = await chat.createTree({});
    const root = await send(chat, tree.trunkBranchId, 'ROOT');
    const branch = await chat.createBranch({
      fromNodeId: root.begin.assistantNode.id,
      contextMode: 'summary',
    });

    const normal = await ask(chat, branch.id, 'Q', { model: 'm1' });
    expect(normal.events[0]).toEqual({
      type: 'status',
      message: 'Summarizing the parent conversation…',
    });
    expect(provider.summaryCalls()).toHaveLength(1);
    const max = await ask(chat, branch.id, 'Q', { providerId: 'other', model: 'o1' });
    expect(provider.summaryCalls()).toHaveLength(1);
    expect(max.events.some((e) => e.type === 'status')).toBe(false);
    expect(max.held?.content).toBe('reply to: Q');
  });

  it('without a summary provider, summarizes once on the branch’s own route, not each candidate’s', async () => {
    const { chat, provider, other } = setupCompare();
    const { tree } = await chat.createTree({});
    const root = await send(chat, tree.trunkBranchId, 'ROOT');
    const branch = await chat.createBranch({
      fromNodeId: root.begin.assistantNode.id,
      contextMode: 'summary',
    });

    await ask(chat, branch.id, 'Q', { model: 'big' });
    await ask(chat, branch.id, 'Q', { providerId: 'other', model: 'o1' });

    expect(provider.summaryCalls().map((c) => c.model)).toEqual(['m1']);
    expect(other.summaryCalls()).toHaveLength(0);
    expect(other.chatCalls().map((c) => c.model)).toEqual(['o1']);
  });

  it('auto-titles the branch after its first exchange, like a send', async () => {
    const { chat } = setupCompare({ autoTitle: true });
    const { tree } = await chat.createTree({});
    const root = await send(chat, tree.trunkBranchId, 'ROOT');
    const branch = await chat.createBranch({ fromNodeId: root.begin.assistantNode.id });
    const { held } = await ask(chat, branch.id, 'SIDE-Q', { model: 'big' });

    const result = await chat.commitCandidate(held!);

    expect(result.branch).toMatchObject({ id: branch.id, title: 'Scripted Title' });
    expect(result.branch.titleSource).toBe('auto');
  });

  it('can append without the title call and title afterwards (outside a lock)', async () => {
    const { chat, provider } = setupCompare({ autoTitle: true });
    const { tree } = await chat.createTree({});
    const root = await send(chat, tree.trunkBranchId, 'ROOT');
    const branch = await chat.createBranch({ fromNodeId: root.begin.assistantNode.id });
    const { held } = await ask(chat, branch.id, 'SIDE-Q', { model: 'big' });
    const callsBefore = provider.calls.length;

    const appended = await chat.appendCandidate(held!);
    expect(provider.calls.length).toBe(callsBefore);
    expect(appended.branch.titleSource).toBe('default');

    const titled = await chat.titleCommitted(appended);
    expect(titled).toMatchObject({ id: branch.id, title: 'Scripted Title', titleSource: 'auto' });
  });

  it('ends with one error when cancelled or when the provider fails', async () => {
    const { chat, provider } = setupCompare();
    const { tree } = await chat.createTree({});
    const aborted = new AbortController();
    aborted.abort();
    const cancelled = await ask(chat, tree.trunkBranchId, 'Q', { model: 'm1' }, aborted.signal);
    expect(cancelled.last).toEqual({ type: 'error', message: 'Cancelled' });
    expect(cancelled.events.filter((e) => e.type === 'error' || e.type === 'done')).toHaveLength(1);

    provider.failNext = 'upstream broke';
    const failed = await ask(chat, tree.trunkBranchId, 'Q', { model: 'm1' });
    expect(failed.last).toEqual({ type: 'error', message: 'upstream broke' });
    expect((await chat.getTreeDetail(tree.id)).nodes).toEqual([]);
  });
});
