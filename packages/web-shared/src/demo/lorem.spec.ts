import type { GenerateRequest, ProviderEvent } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import {
  createLoremProvider,
  DEMO_SIMPLE_MODEL,
  DEMO_SMART_MODEL,
  loremQuestion,
  loremReply,
  loremTitle,
  seededRandom as seeded,
} from './lorem';

function request(over: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    model: DEMO_SMART_MODEL,
    system: 'You are a tutor.',
    messages: [{ role: 'user', content: 'Why is the sky blue?' }],
    signal: new AbortController().signal,
    usageTag: { purpose: 'reply', treeId: 't1', nodeId: 'n1' },
    ...over,
  };
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const noWait = async () => undefined;

describe('lorem text', () => {
  it('is deterministic for a given RNG', () => {
    expect(loremReply(DEMO_SMART_MODEL, seeded(7))).toBe(loremReply(DEMO_SMART_MODEL, seeded(7)));
    expect(loremReply(DEMO_SMART_MODEL, seeded(7))).not.toBe(
      loremReply(DEMO_SMART_MODEL, seeded(8)),
    );
  });

  it('always ends with a question in its own paragraph', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const reply = loremReply(seed % 2 ? DEMO_SMART_MODEL : DEMO_SIMPLE_MODEL, seeded(seed));
      const last = reply.split('\n\n').at(-1)!;
      expect(last).toMatch(/^[A-Z][^\n]*\?$/);
      expect(reply).not.toContain('{{');
      expect(reply).not.toContain('undefined');
    }
    expect(loremQuestion(seeded(3))).toMatch(/\?$/);
  });

  it('writes longer replies for Smart than for Simple', () => {
    let smart = 0;
    let simple = 0;
    for (let seed = 1; seed <= 30; seed++) {
      smart += loremReply(DEMO_SMART_MODEL, seeded(seed)).length;
      simple += loremReply(DEMO_SIMPLE_MODEL, seeded(seed)).length;
    }
    expect(smart).toBeGreaterThan(simple * 1.3);
  });

  it('makes short one-line titles', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const title = loremTitle(seeded(seed));
      expect(title).not.toContain('\n');
      expect(title.length).toBeGreaterThan(3);
      expect(title.length).toBeLessThan(60);
    }
  });
});

describe('createLoremProvider', () => {
  it('streams word by word, then usage, billing and done', async () => {
    const delays: number[] = [];
    const provider = createLoremProvider({
      random: seeded(1),
      sleep: async (ms) => void delays.push(ms),
    });
    const events = await collect(provider.stream(request()));
    const deltas = events.filter((e) => e.type === 'delta');
    expect(deltas.length).toBeGreaterThan(10);
    for (const d of deltas) expect(d.text).toMatch(/^\S+\s*$/);
    const text = deltas.map((d) => d.text).join('');
    expect(text).toBe(loremReply(DEMO_SMART_MODEL, seeded(1)));
    expect(text.trimEnd()).toMatch(/\?$/);
    expect(events.slice(-3).map((e) => e.type)).toEqual(['usage', 'billing', 'done']);
    const billing = events.find((e) => e.type === 'billing');
    expect(billing?.type === 'billing' && billing.costUsd).toBeGreaterThan(0.001);
    expect(billing?.type === 'billing' && billing.costUsd).toBeLessThan(0.05);
    expect(delays.length).toBe(deltas.length);
    for (const ms of delays) expect(ms >= 20 && ms <= 40).toBe(true);
  });

  it('answers title and summary calls without pausing', async () => {
    const delays: number[] = [];
    const provider = createLoremProvider({
      random: seeded(2),
      sleep: async (ms) => void delays.push(ms),
    });
    const title = await collect(
      provider.stream(request({ usageTag: { purpose: 'title', treeId: 't1', nodeId: null } })),
    );
    const text = title.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('');
    expect(text).toBe(loremTitle(seeded(2)));
    expect(title.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
    expect(delays).toEqual([]);
  });

  it('stops with an aborted error when the signal fires', async () => {
    const ctrl = new AbortController();
    const provider = createLoremProvider({ random: seeded(3), sleep: noWait });
    const events: ProviderEvent[] = [];
    for await (const e of provider.stream(request({ signal: ctrl.signal }))) {
      events.push(e);
      if (events.length === 3) ctrl.abort();
    }
    expect(events.filter((e) => e.type === 'delta')).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'aborted' } });
    expect(events.some((e) => e.type === 'done' || e.type === 'billing')).toBe(false);
  });

  it('really waits between words by default, and stops waiting on abort', async () => {
    const ctrl = new AbortController();
    const provider = createLoremProvider({ random: seeded(4) });
    const started = Date.now();
    const events: ProviderEvent[] = [];
    setTimeout(() => ctrl.abort(), 120);
    for await (const e of provider.stream(request({ signal: ctrl.signal }))) events.push(e);
    const elapsed = Date.now() - started;
    const deltas = events.filter((e) => e.type === 'delta').length;
    expect(deltas).toBeGreaterThan(1);
    expect(deltas).toBeLessThan(10);
    expect(elapsed).toBeLessThan(400);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'aborted' } });
  });

  it('describes itself as the tangent provider with Smart and Simple', () => {
    const p = createLoremProvider();
    expect(p.id).toBe('tangent');
    expect(p.models().map((m) => m.label)).toEqual(['Smart', 'Simple']);
    expect(p.defaultModel()).toBe(DEMO_SMART_MODEL);
    expect(p.kind).not.toBe('fake'); // the ChatService only auto-titles with real kinds
  });
});
