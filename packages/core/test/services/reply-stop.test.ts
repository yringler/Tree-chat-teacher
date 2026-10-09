import {
  REPLY_CUT_OFF_ERROR,
  REPLY_EMPTY_ERROR,
  REPLY_THINKING_ONLY_ERROR,
  isCutOffReply,
} from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { send, setup } from './helpers.js';

/** A reply that ends at its output cap, or with no text, is never stored as a complete answer. */
describe('replies cut off or empty', () => {
  async function replyWith(stopReason: string, text: string | null = null) {
    const s = setup();
    s.provider.chatStopReason = stopReason;
    s.provider.chatText = text;
    const detail = await s.chat.createTree({ providerId: 'scripted' });
    const branchId = detail.tree.trunkBranchId;
    const result = await send(s.chat, branchId, 'Derive the whole thing');
    const node = (await s.repos.trees.listBranchNodes(branchId)).at(-1)!;
    return { ...s, ...result, node, branchId };
  }

  it.each(['length', 'max_tokens'])(
    'stores a reply stopped by %s as a cut-off error that keeps its text',
    async (stopReason) => {
      const { last, node } = await replyWith(stopReason, 'Half of the deriv');
      expect(last).toMatchObject({ type: 'error', message: REPLY_CUT_OFF_ERROR });
      expect(node).toMatchObject({
        role: 'assistant',
        status: 'error',
        error: REPLY_CUT_OFF_ERROR,
        errorKind: 'cut_off',
        content: 'Half of the deriv',
      });
      expect(node.usage).not.toBeNull();
      expect(isCutOffReply(node)).toBe(true);
    },
  );

  it('keeps the cut-off text in the context, so the tutor can continue it', async () => {
    const s = await replyWith('length', 'Half of the deriv');
    s.provider.chatStopReason = 'end_turn';
    s.provider.chatText = null;
    await send(s.chat, s.branchId, 'Please continue where you left off.');
    const last = s.provider.chatCalls().at(-1)!;
    expect(last.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Derive the whole thing'],
      ['assistant', 'Half of the deriv'],
      ['user', 'Please continue where you left off.'],
    ]);
  });

  it('does not title a branch after a cut-off first reply', async () => {
    const s = await replyWith('length', 'Half of the deriv');
    expect(s.provider.calls.filter((c) => s.provider.kindOf(c) === 'title')).toEqual([]);
  });

  it('tells a reply cut off before any text (all thinking) apart', async () => {
    const { last, node } = await replyWith('length', '');
    expect(last).toMatchObject({ type: 'error', message: REPLY_THINKING_ONLY_ERROR });
    expect(node).toMatchObject({
      status: 'error',
      error: REPLY_THINKING_ONLY_ERROR,
      errorKind: 'thinking_only',
      content: '',
    });
    expect(isCutOffReply(node)).toBe(false);
  });

  it('fails a reply that finished without any text', async () => {
    const { last, node } = await replyWith('stop', '  \n');
    expect(last).toMatchObject({ type: 'error', message: REPLY_EMPTY_ERROR });
    expect(node).toMatchObject({ status: 'error', error: REPLY_EMPTY_ERROR, errorKind: 'empty' });
  });

  it('completes a reply that stopped on its own', async () => {
    const { last, node } = await replyWith('stop', 'All of it.');
    expect(last.type).toBe('done');
    expect(node).toMatchObject({ status: 'complete', error: null, content: 'All of it.' });
  });
});

describe('summary effort', () => {
  it('asks summaries and titles for the configured effort, never replies', async () => {
    const s = setup({ summaryEffort: 'none' });
    const detail = await s.chat.createTree({ providerId: 'scripted' });
    const { begin } = await send(s.chat, detail.tree.trunkBranchId, 'What is a monad?');
    const branch = await s.chat.createBranch({
      fromNodeId: begin.assistantNode.id,
      contextMode: 'summary',
    });
    await send(s.chat, branch.id, 'And a functor?');
    const byKind = (kind: string) =>
      s.provider.calls.filter((c) => s.provider.kindOf(c) === kind).map((c) => c.reasoning);
    // The trunk's title, then the branch's.
    expect(byKind('title')).toEqual(['none', 'none']);
    expect(byKind('summary')).toEqual(['none']);
    expect(byKind('chat')).toEqual([undefined, undefined]);
  });

  it('sends no effort by default (the model’s own)', async () => {
    const s = setup();
    const detail = await s.chat.createTree({ providerId: 'scripted' });
    await send(s.chat, detail.tree.trunkBranchId, 'What is a monad?');
    expect(s.provider.calls.map((c) => c.reasoning)).toEqual([undefined, undefined]);
  });
});

describe('compare candidates cut off', () => {
  it('fails a candidate that stopped at its cap instead of holding it', async () => {
    const s = setup({ autoTitle: false });
    s.provider.chatStopReason = 'length';
    const detail = await s.chat.createTree({ providerId: 'scripted' });
    const prepared = await s.chat.prepareCandidate(detail.tree.trunkBranchId, {
      content: 'Derive it',
      model: 'm1',
    });
    const events = [];
    for await (const e of s.chat.runCandidate(prepared, new AbortController().signal))
      events.push(e);
    expect(events.at(-1)).toEqual({ type: 'error', message: REPLY_CUT_OFF_ERROR });
  });
});
