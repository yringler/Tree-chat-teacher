import { parseReview, type ReviewEvent } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError } from '../../src/errors.js';
import { ChatService, DEFAULT_CHAT_SETTINGS } from '../../src/services/chat-service.js';
import { createMemoryRepositories } from '../../src/testing/memory-repositories.js';
import { registryOf, ScriptedProvider, send } from './helpers.js';

function setupWithReviewer() {
  const repos = createMemoryRepositories();
  const provider = new ScriptedProvider();
  const reviewer = new ScriptedProvider('reviewer');
  let n = 0;
  const chat = new ChatService({
    repos,
    providers: registryOf(provider, reviewer),
    settings: { ...DEFAULT_CHAT_SETTINGS, autoTitle: false },
    newId: () => `id${(++n).toString().padStart(4, '0')}`,
  });
  return { repos, provider, reviewer, chat };
}

async function collect(events: AsyncIterable<ReviewEvent>): Promise<ReviewEvent[]> {
  const out: ReviewEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('ChatService reviews', () => {
  it('reviews the path up to an assistant reply with the chosen model', async () => {
    const { chat, provider, reviewer } = setupWithReviewer();
    const { tree } = await chat.createTree({ systemPrompt: 'TREE-SYSTEM' });
    const root = await send(chat, tree.trunkBranchId, 'ROOT-QUESTION');
    const branch = await chat.createBranch({ fromNodeId: root.begin.assistantNode.id });
    const side = await send(chat, branch.id, 'SIDE-QUESTION');
    // A later reply in the same branch must not be part of a review of the earlier one.
    await send(chat, branch.id, 'LATER-QUESTION');
    const chatCallsBefore = provider.calls.length;

    const prepared = await chat.prepareReview(side.begin.assistantNode.id, {
      providerId: 'reviewer',
      model: 'm1',
    });
    const events = await collect(chat.runReview(prepared, new AbortController().signal));

    expect(provider.calls).toHaveLength(chatCallsBefore);
    expect(reviewer.calls).toHaveLength(1);
    const call = reviewer.calls[0]!;
    expect(call.system).toContain('ACCURACY: OK | MINOR | MAJOR');
    expect(call.system).toContain('RECOMMENDATION: STAY | UPGRADE');
    expect(call.messages).toHaveLength(1);
    const body = call.messages[0]!.content;
    expect(body).toContain('TREE-SYSTEM');
    expect(body).toContain('User: ROOT-QUESTION');
    expect(body).toContain('User: SIDE-QUESTION');
    expect(body).toContain('Assistant: reply to: SIDE-QUESTION');
    expect(body).not.toContain('LATER-QUESTION');
    expect(body).toContain('"m1"');

    expect(events.at(-1)).toEqual({
      type: 'done',
      providerId: 'reviewer',
      model: 'm1',
      usage: { inputTokens: 10, outputTokens: 3 },
    });
    expect(events.filter((e) => e.type === 'delta').length).toBeGreaterThan(0);
  });

  it('resolves branch summaries before reviewing', async () => {
    const { chat, provider, reviewer } = setupWithReviewer();
    const { tree } = await chat.createTree({});
    const root = await send(chat, tree.trunkBranchId, 'ROOT');
    const branch = await chat.createBranch({
      fromNodeId: root.begin.assistantNode.id,
      contextMode: 'summary',
    });
    const side = await send(chat, branch.id, 'IN-BRANCH');
    const prepared = await chat.prepareReview(side.begin.assistantNode.id, {
      providerId: 'reviewer',
      model: 'm1',
    });
    const summariesBefore = provider.summaryCalls().length;
    await collect(chat.runReview(prepared, new AbortController().signal));
    // The send already cached the summary; the review reuses it.
    expect(provider.summaryCalls()).toHaveLength(summariesBefore);
    expect(reviewer.calls[0]!.messages[0]!.content).toContain('SUMMARY(');
  });

  it('rejects user messages, unfinished replies, unknown nodes and providers', async () => {
    const { chat } = setupWithReviewer();
    const { tree } = await chat.createTree({});
    const done = await send(chat, tree.trunkBranchId, 'hi');
    const req = { providerId: 'reviewer', model: 'm1' };
    await expect(chat.prepareReview(done.begin.userNode.id, req)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(chat.prepareReview('nope', req)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      chat.prepareReview(done.begin.assistantNode.id, { providerId: 'nope', model: 'm1' }),
    ).rejects.toBeInstanceOf(ValidationError);
    const pending = await chat.beginSend(tree.trunkBranchId, 'again');
    await expect(chat.prepareReview(pending.assistantNode.id, req)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('reports provider failures as a terminal error event', async () => {
    const { chat, reviewer } = setupWithReviewer();
    const { tree } = await chat.createTree({});
    const done = await send(chat, tree.trunkBranchId, 'hi');
    reviewer.failNext = 'upstream broke';
    const prepared = await chat.prepareReview(done.begin.assistantNode.id, {
      providerId: 'reviewer',
      model: 'm1',
    });
    const events = await collect(chat.runReview(prepared, new AbortController().signal));
    expect(events.at(-1)).toEqual({ type: 'error', message: 'upstream broke' });
  });
});

describe('parseReview', () => {
  it('splits the verdict trailer from the prose', () => {
    const r = parseReview(
      '## Corrections\n1. Wrong year.\n\nACCURACY: MINOR\nRECOMMENDATION: UPGRADE\n',
    );
    expect(r).toEqual({
      body: '## Corrections\n1. Wrong year.',
      accuracy: 'minor',
      recommendation: 'upgrade',
    });
  });

  it('tolerates markdown decoration and _ISSUES suffixes', () => {
    const r = parseReview('Fine.\n**ACCURACY:** `MAJOR_ISSUES`.\n- Recommendation: stay');
    expect(r.accuracy).toBe('major');
    expect(r.recommendation).toBe('stay');
    expect(r.body).toBe('Fine.');
  });

  it('leaves unknown values unset and keeps partial streams readable', () => {
    expect(parseReview('ACCURACY: MAYBE').accuracy).toBeNull();
    expect(parseReview('Still writing').body).toBe('Still writing');
    expect(parseReview('Still writing').recommendation).toBeNull();
  });
});
