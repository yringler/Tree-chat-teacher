import { describe, expect, it } from 'vitest';
import { CHECK_SOURCES_INSTRUCTIONS, GROUNDING_INSTRUCTIONS } from '@tangent/shared';
import { replyInstructions } from '../../src/context/render.js';
import { DEFAULT_GROUNDING_SETTINGS } from '../../src/services/chat-service.js';
import { send, setup } from './helpers.js';

const citations = [{ url: 'https://example.org/a', title: 'A', excerpt: 'an excerpt' }];
const auto = { grounding: { ...DEFAULT_GROUNDING_SETTINGS, policy: 'auto' as const } };

/** Tree with a reply on the trunk, a branch off it, and a branch off that (depth 2). */
async function deepTree(s: ReturnType<typeof setup>) {
  const { tree } = await s.chat.createTree({});
  const r1 = await send(s.chat, tree.trunkBranchId, 'What is entropy?');
  const b1 = await s.chat.createBranch({ fromNodeId: r1.begin.assistantNode.id });
  const r2 = await send(s.chat, b1.id, 'tell me more');
  const b2 = await s.chat.createBranch({ fromNodeId: r2.begin.assistantNode.id });
  return { tree, b1, b2 };
}

describe('ChatService grounding', () => {
  it('offers web search on a deep tangent and stores the sources', async () => {
    const s = setup(auto);
    s.provider.webSearch = true;
    s.provider.citations = citations;
    const { b2 } = await deepTree(s);
    const r = await send(s.chat, b2.id, 'tell me more');
    const call = s.provider.chatCalls().at(-1)!;
    expect(call.webSearch).toEqual({ mode: 'auto', maxResults: 5, maxUses: 1, engine: 'exa' });
    // After the history, never in the system prompt (the cached prefix).
    expect(call.turnInstructions).toBe(replyInstructions(GROUNDING_INSTRUCTIONS));
    expect(call.system ?? '').not.toContain('## Checking facts');
    expect(call.messages.at(-1)).toEqual({ role: 'user', content: 'tell me more' });
    expect(r.events).toContainEqual({ type: 'status', message: 'Checking sources…' });
    expect(r.last).toMatchObject({ type: 'done', node: { sources: citations } });
    const stored = (await s.chat.getTreeDetail(b2.treeId)).nodes.find(
      (n) => n.id === r.begin.assistantNode.id,
    );
    expect(stored?.sources).toEqual(citations);
  });

  it('does not offer search for a conceptual trunk question, and stores no sources', async () => {
    const s = setup(auto);
    s.provider.webSearch = true;
    s.provider.citations = citations;
    const { tree } = await s.chat.createTree({});
    const r = await send(s.chat, tree.trunkBranchId, 'Why does ice float?');
    const call = s.provider.chatCalls().at(-1)!;
    expect(call.webSearch).toBeUndefined();
    expect(call.turnInstructions).toBeUndefined();
    expect(call.system ?? '').not.toContain('## Checking facts');
    expect(r.last).toMatchObject({ type: 'done', node: { sources: null } });
  });

  it('requires a search for Check sources, with the check instructions', async () => {
    const s = setup(auto);
    s.provider.webSearch = true;
    const { tree } = await s.chat.createTree({});
    await send(s.chat, tree.trunkBranchId, 'Why does ice float?');
    const r = await send(s.chat, tree.trunkBranchId, 'Check your last answer against sources', {
      ground: 'required',
    });
    const call = s.provider.chatCalls().at(-1)!;
    expect(call.webSearch?.mode).toBe('required');
    expect(call.turnInstructions).toBe(replyInstructions(CHECK_SOURCES_INSTRUCTIONS));
    expect(call.system ?? '').not.toContain('## Checking facts');
    // Searched but cited nothing: an empty list, not null.
    expect(r.last).toMatchObject({ type: 'done', node: { sources: [] } });
  });

  it('keeps the system prompt and history the same on turns with and without search', async () => {
    const s = setup(auto);
    s.provider.webSearch = true;
    const { tree } = await s.chat.createTree({ systemPrompt: 'Be a kind tutor.' });
    await send(s.chat, tree.trunkBranchId, 'Why does ice float?');
    await send(s.chat, tree.trunkBranchId, 'Who discovered it in 1850?');
    await send(s.chat, tree.trunkBranchId, 'Why is that?');
    await send(s.chat, tree.trunkBranchId, 'Check your last answer against sources', {
      ground: 'required',
    });
    const calls = s.provider.chatCalls();
    expect(calls.map((c) => c.webSearch?.mode ?? 'none')).toEqual([
      'none',
      'auto',
      'none',
      'required',
    ]);
    // Every turn's system prompt is the same, and each turn's messages start
    // with the previous turn's: only the tail differs, so the cached prefix holds.
    for (const call of calls) expect(call.system).toBe(calls[0]!.system);
    for (let i = 1; i < calls.length; i++) {
      const previous = calls[i - 1]!.messages;
      expect(calls[i]!.messages.slice(0, previous.length)).toEqual(previous);
    }
    expect(calls.map((c) => c.turnInstructions !== undefined)).toEqual([false, true, false, true]);
  });

  it('never sends webSearch to a provider that cannot search, or with the policy off', async () => {
    const s = setup(auto);
    const { b2 } = await deepTree(s);
    await send(s.chat, b2.id, 'Who invented it?', { ground: 'required' });
    expect(s.provider.chatCalls().every((c) => c.webSearch === undefined)).toBe(true);
    expect(s.provider.chatCalls().every((c) => c.turnInstructions === undefined)).toBe(true);

    const off = setup();
    off.provider.webSearch = true;
    const t = await deepTree(off);
    await send(off.chat, t.b2.id, 'Who invented it in 1850?');
    expect(off.provider.chatCalls().every((c) => c.webSearch === undefined)).toBe(true);
  });

  it('retries once without search when the provider rejects the tool', async () => {
    const s = setup(auto);
    s.provider.webSearch = true;
    s.provider.rejectSearch = true;
    const { b2 } = await deepTree(s);
    const r = await send(s.chat, b2.id, 'Who invented it?');
    const calls = s.provider.chatCalls().slice(-2);
    expect(calls[0]!.webSearch).toBeDefined();
    expect(calls[1]!.webSearch).toBeUndefined();
    expect(calls[0]!.turnInstructions).toBeDefined();
    expect(calls[1]!.turnInstructions).toBeUndefined();
    expect(calls[1]!.system).toBe(calls[0]!.system);
    expect(calls[1]!.messages).toEqual(calls[0]!.messages);
    expect(r.last).toMatchObject({ type: 'done', node: { status: 'complete', sources: null } });
  });

  it('stops automatic searches when the allowance says so, but not explicit checks', async () => {
    const s = setup(auto, { groundingAllowance: async () => false });
    s.provider.webSearch = true;
    const { b2 } = await deepTree(s);
    await send(s.chat, b2.id, 'Who invented it?');
    expect(s.provider.chatCalls().at(-1)!.webSearch).toBeUndefined();
    await send(s.chat, b2.id, 'Check', { ground: 'required' });
    expect(s.provider.chatCalls().at(-1)!.webSearch?.mode).toBe('required');
  });

  it('treats an allowance that threw as refused, and logs it', async () => {
    const lines: [string, Record<string, unknown>][] = [];
    const s = setup(auto, {
      groundingAllowance: () => Promise.reject(new Error('D1 down')),
      log: (event, fields) => lines.push([event, fields]),
    });
    s.provider.webSearch = true;
    const { b2 } = await deepTree(s);
    await send(s.chat, b2.id, 'Who invented it?');
    expect(s.provider.chatCalls().at(-1)!.webSearch).toBeUndefined();
    expect(lines).toContainEqual([
      'grounding_allowance_failed',
      { providerId: 'scripted', funding: 'own-key', error: 'D1 down' },
    ]);
  });

  it('honors the branch setting, inherited by child branches', async () => {
    const s = setup(auto);
    s.provider.webSearch = true;
    const { tree } = await s.chat.createTree({});
    const r1 = await send(s.chat, tree.trunkBranchId, 'q');
    const b1 = await s.chat.createBranch({
      fromNodeId: r1.begin.assistantNode.id,
      grounding: 'off',
    });
    const r2 = await send(s.chat, b1.id, 'Who invented it in 1850?');
    expect(s.provider.chatCalls().at(-1)!.webSearch).toBeUndefined();
    const b2 = await s.chat.createBranch({ fromNodeId: r2.begin.assistantNode.id });
    expect(b2.grounding).toBe('off');
    const updated = await s.chat.updateBranch(b2.id, { grounding: 'always' });
    expect(updated.grounding).toBe('always');
    await send(s.chat, b2.id, 'Why?');
    expect(s.provider.chatCalls().at(-1)!.webSearch?.mode).toBe('auto');
  });

  it('ignores the branch setting when configured to (Learn)', async () => {
    const s = setup({ grounding: { ...auto.grounding, ignoreBranchSetting: true } });
    s.provider.webSearch = true;
    const { tree } = await s.chat.createTree({});
    const r1 = await send(s.chat, tree.trunkBranchId, 'q');
    const b1 = await s.chat.createBranch({
      fromNodeId: r1.begin.assistantNode.id,
      grounding: 'off',
    });
    await send(s.chat, b1.id, 'Who invented it in 1850?');
    expect(s.provider.chatCalls().at(-1)!.webSearch?.mode).toBe('auto');
  });

  it('never searches for summaries or titles', async () => {
    const s = setup({ ...auto, autoTitle: true });
    s.provider.webSearch = true;
    s.provider.citations = citations;
    const { tree } = await s.chat.createTree({});
    const r1 = await send(s.chat, tree.trunkBranchId, 'q');
    const b1 = await s.chat.createBranch({
      fromNodeId: r1.begin.assistantNode.id,
      contextMode: 'summary',
    });
    await send(s.chat, b1.id, 'Who invented it in 1850?');
    expect(s.provider.summaryCalls().length).toBeGreaterThan(0);
    const nonChat = s.provider.calls.filter((c) => s.provider.kindOf(c) !== 'chat');
    expect(nonChat.every((c) => c.webSearch === undefined)).toBe(true);
  });
});
