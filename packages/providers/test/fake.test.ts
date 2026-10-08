import { describe, expect, it } from 'vitest';
import type { GenerateRequest, ProviderConfig, ProviderEvent } from '@tangent/shared';
import { createFakeProvider } from '../src/fake.js';
import { collect, withTimeout } from './helpers.js';

const BASE: ProviderConfig = {
  id: 'fake',
  kind: 'fake',
  label: 'Fake',
  defaultModel: 'fake-1',
  models: [],
};

function req(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    model: 'fake-1',
    system: 'sys',
    messages: [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'What is a tangent?' },
    ],
    signal: new AbortController().signal,
    ...overrides,
  };
}

function text(events: ProviderEvent[]): string {
  return events.map((e) => (e.type === 'delta' ? e.text : '')).join('');
}

describe('fake provider', () => {
  it('produces the documented deterministic reply, chunked by 8, then usage and done', async () => {
    const p = createFakeProvider(BASE, { secrets: {} });
    const events = await collect(p.stream(req()));
    const reply = 'Fake reply (fake-1) to 3 message(s): "What is a tangent?"';
    expect(text(events)).toBe(reply);
    const deltas = events.filter((e) => e.type === 'delta');
    expect(deltas).toHaveLength(Math.ceil(reply.length / 8));
    expect(deltas[0]).toEqual({ type: 'delta', text: reply.slice(0, 8) });
    // chars: 3 (system) + 14 + 6 + 18 = 41 → ceil(41/4) = 11
    expect(events.slice(-2)).toEqual([
      { type: 'usage', usage: { inputTokens: 11, outputTokens: Math.ceil(reply.length / 4) } },
      { type: 'done', stopReason: 'end_turn' },
    ]);
    expect(await collect(p.stream(req()))).toEqual(events);
  });

  it('truncates the quoted user message to 80 characters', async () => {
    const p = createFakeProvider(BASE, { secrets: {} });
    const long = 'x'.repeat(200);
    const events = await collect(p.stream(req({ messages: [{ role: 'user', content: long }] })));
    expect(text(events)).toBe(`Fake reply (fake-1) to 1 message(s): "${'x'.repeat(80)}"`);
  });

  it('uses the responses map (first match in insertion order) and chunkSize', async () => {
    const p = createFakeProvider(
      {
        ...BASE,
        options: { responses: { tangent: 'A line touching a curve.', What: 'nope' }, chunkSize: 5 },
      },
      { secrets: {} },
    );
    const events = await collect(p.stream(req()));
    expect(
      events.filter((e) => e.type === 'delta').map((e) => (e.type === 'delta' ? e.text : '')),
    ).toEqual(['A lin', 'e tou', 'ching', ' a cu', 'rve.']);
  });

  it('matches anyMessageResponses against every message, before responses', async () => {
    const p = createFakeProvider(
      {
        ...BASE,
        options: {
          anyMessageResponses: { first: 'from history' },
          responses: { tangent: 'last only' },
        },
      },
      { secrets: {} },
    );
    expect(text(await collect(p.stream(req())))).toBe('from history');
    const lastOnly = req({ messages: [{ role: 'user', content: 'What is a tangent?' }] });
    expect(text(await collect(p.stream(lastOnly)))).toBe('last only');
  });

  it('fails with the configured error after the first delta', async () => {
    const p = createFakeProvider({ ...BASE, options: { failWith: 'overloaded' } }, { secrets: {} });
    const events = await collect(p.stream(req()));
    expect(events).toEqual([
      { type: 'delta', text: 'Fake rep' },
      {
        type: 'error',
        error: { code: 'overloaded', message: 'Fake failure: overloaded', retryable: true },
      },
    ]);
  });

  it('delays between deltas and aborts promptly', async () => {
    const p = createFakeProvider({ ...BASE, options: { delayMs: 1000 } }, { secrets: {} });
    const ac = new AbortController();
    const start = Date.now();
    const run = collect(p.stream(req({ signal: ac.signal })));
    setTimeout(() => ac.abort(), 20);
    expect(await withTimeout(run, 500)).toEqual([
      { type: 'error', error: { code: 'aborted', message: 'Request aborted', retryable: false } },
    ]);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('aborts mid-stream between small delays', async () => {
    const p = createFakeProvider(
      { ...BASE, options: { delayMs: 10, chunkSize: 1 } },
      { secrets: {} },
    );
    const ac = new AbortController();
    const events: ProviderEvent[] = [];
    for await (const ev of p.stream(req({ signal: ac.signal }))) {
      events.push(ev);
      if (events.length === 3) ac.abort();
    }
    expect(events).toHaveLength(4);
    expect(events[3]).toMatchObject({ type: 'error', error: { code: 'aborted' } });
  });

  it('counts tokens with the same figure as usage', async () => {
    const p = createFakeProvider(BASE, { secrets: {} });
    const { signal: _signal, ...rest } = req();
    expect(await p.countTokens!(rest)).toBe(11);
  });

  it('has documented defaults and honours config overrides', () => {
    const p = createFakeProvider(BASE, { secrets: {} });
    expect(p.models()).toEqual([{ id: 'fake-1', label: 'Fake 1' }]);
    expect(p.defaultModel()).toBe('fake-1');
    expect(p.capabilities('fake-1')).toEqual({
      maxContextTokens: 200_000,
      maxOutputTokens: 4096,
      supportsSystemPrompt: true,
      supportsTokenCount: true,
      supportsWebSearch: false,
      reasoning: false,
    });
    const p2 = createFakeProvider(
      {
        ...BASE,
        maxContextTokens: 1000,
        supportsSystemPrompt: false,
        models: [{ id: 'tiny', label: 'Tiny', maxOutputTokens: 50 }],
        defaultModel: 'tiny',
      },
      { secrets: {} },
    );
    expect(p2.capabilities('tiny')).toEqual({
      maxContextTokens: 1000,
      maxOutputTokens: 50,
      supportsSystemPrompt: false,
      supportsTokenCount: true,
      supportsWebSearch: false,
      reasoning: false,
    });
  });

  it('with costUsd: yields the generation id before deltas and the cost before done, unique per stream', async () => {
    const p = createFakeProvider({ ...BASE, options: { costUsd: 0.001234 } }, { secrets: {} });
    const events = await collect(p.stream(req()));
    const first = events[0];
    expect(first).toEqual({
      type: 'billing',
      generationId: expect.stringMatching(/^gen-fake-/) as unknown,
    });
    const id = first?.type === 'billing' ? first.generationId : undefined;
    expect(events[1]?.type).toBe('delta');
    expect(events.slice(-3)).toEqual([
      { type: 'usage', usage: { inputTokens: 11, outputTokens: expect.any(Number) as unknown } },
      { type: 'billing', generationId: id, costUsd: 0.001234 },
      { type: 'done', stopReason: 'end_turn' },
    ]);
    const again = (await collect(p.stream(req()))).filter((e) => e.type === 'billing');
    expect(again).toHaveLength(2);
    const againId = again[0]?.generationId;
    expect(againId).toMatch(/^gen-fake-/);
    expect(againId).not.toBe(id);
    expect(again[1]).toEqual({ type: 'billing', generationId: againId, costUsd: 0.001234 });
    // A second provider instance (another registry, isolate or restart) never reuses an id.
    const other = createFakeProvider({ ...BASE, options: { costUsd: 0.001234 } }, { secrets: {} });
    const otherFirst = (await collect(other.stream(req())))[0];
    expect(otherFirst?.type === 'billing' && otherFirst.generationId).not.toBe(id);
  });

  it('with costUsd and failWith: yields the id but no cost', async () => {
    const p = createFakeProvider(
      { ...BASE, options: { costUsd: 0.5, failWith: 'server' } },
      { secrets: {} },
    );
    const events = await collect(p.stream(req()));
    expect(events[0]).toEqual({
      type: 'billing',
      generationId: expect.stringMatching(/^gen-fake-/) as unknown,
    });
    expect(events.filter((e) => e.type === 'billing')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'server' } });
  });

  it('without costUsd: yields no billing events', async () => {
    const p = createFakeProvider({ ...BASE, options: { costUsd: 'free' } }, { secrets: {} });
    const events = await collect(p.stream(req()));
    expect(events.some((e) => e.type === 'billing')).toBe(false);
  });

  it('with echoRequest: replies with the model, output cap and system prompt it was sent', async () => {
    const always = createFakeProvider({ ...BASE, options: { echoRequest: true } }, { secrets: {} });
    expect(text(await collect(always.stream(req({ model: 'm', maxOutputTokens: 77 }))))).toBe(
      'ECHO model=m maxOutputTokens=77 system="sys"',
    );
    // A string echoes only when the last user message contains it.
    const marked = createFakeProvider(
      { ...BASE, options: { echoRequest: '[echo]' } },
      { secrets: {} },
    );
    expect(text(await collect(marked.stream(req())))).toMatch(/^Fake reply/);
    const echoed = await collect(
      marked.stream(req({ system: null, messages: [{ role: 'user', content: 'hi [echo]' }] })),
    );
    expect(text(echoed)).toBe('ECHO model=fake-1 maxOutputTokens=none system=null');
  });
});

describe('fake provider web search', () => {
  const webSearch = { mode: 'auto', maxResults: 5, maxUses: 1, engine: 'exa' } as const;
  const citations = [{ url: 'https://example.org/a', title: 'A', excerpt: 'x' }];

  it('scripts activity, citations and the search cost when offered and it has citations', async () => {
    const p = createFakeProvider(
      { ...BASE, options: { webSearch: true, citations, costUsd: 0.001, webSearchCostUsd: 0.007 } },
      { secrets: {} },
    );
    expect(p.capabilities('fake-1').supportsWebSearch).toBe(true);
    const events = await collect(p.stream(req({ webSearch })));
    expect(events[1]).toEqual({ type: 'activity', kind: 'web_search' });
    expect(events).toContainEqual({ type: 'citations', citations });
    const bill = events.filter((e) => e.type === 'billing').at(-1);
    expect(bill).toMatchObject({ costUsd: 0.008, webSearches: 1 });
  });

  it('does not search when not offered, or in auto mode without scripted citations', async () => {
    const withCites = createFakeProvider(
      { ...BASE, options: { webSearch: true, citations } },
      { secrets: {} },
    );
    expect((await collect(withCites.stream(req()))).some((e) => e.type === 'citations')).toBe(
      false,
    );
    const none = createFakeProvider({ ...BASE, options: { webSearch: true } }, { secrets: {} });
    expect(
      (await collect(none.stream(req({ webSearch })))).some((e) => e.type === 'activity'),
    ).toBe(false);
    const required = await collect(
      none.stream(req({ webSearch: { ...webSearch, mode: 'required' } })),
    );
    expect(required).toContainEqual({ type: 'citations', citations: [] });
  });
});

describe('fake provider stopReasons', () => {
  it('ends with the scripted stop reason when the last user message has its key', async () => {
    const provider = createFakeProvider(
      {
        id: 'f',
        kind: 'fake',
        label: 'F',
        defaultModel: 'f1',
        models: [],
        options: { stopReasons: { CUTOFF: 'length' } },
      },
      { secrets: {} },
    );
    const stopOf = async (content: string) =>
      (
        await collect(
          provider.stream({
            model: 'f1',
            system: null,
            messages: [{ role: 'user', content }],
            signal: new AbortController().signal,
          }),
        )
      ).at(-1);
    expect(await stopOf('please CUTOFF here')).toEqual({ type: 'done', stopReason: 'length' });
    expect(await stopOf('a normal question')).toEqual({ type: 'done', stopReason: 'end_turn' });
  });
});
