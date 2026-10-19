// Tangent credit on the hosted backend chain: Anthropic's own API first, OpenRouter
// behind it (an in-process `BUILT_IN_BACKENDS` and `BUILT_IN_ANTHROPIC_API_KEY` over the
// run's env, as a deployment with both sets them). Each call goes through the real
// usage meter on its legs (`hostedLegs`), with a tap under every leg, so a scenario sees
// both what each backend sent and what the client got. Calls go straight to the
// metered provider, not through ChatService, so each makes one row and its output cap
// stays small.
//
// The fallback scenario fakes Anthropic's refusal (an HTTP 529 from a stub of `fetch`,
// the seam hosted-breaker.test.ts uses) and lets the OpenRouter leg run for real.
import {
  OPENROUTER_PROVIDER_ID,
  chargeMicros,
  costUsdToNanos,
  type ChatMessage,
  type GenerateRequest,
  type ProviderEvent,
  type WebSearchRequest,
} from '@tangent/shared';
import { afterEach, describe, vi } from 'vitest';
import { grantCredit } from '../../src/billing/ledger.js';
import { meteredRegistry } from '../../src/billing/meter.js';
import { createUsageMeter } from '../../src/billing/personal-meter.js';
import type { ModelPrice } from '../../src/config.js';
import type { AppEnv } from '../../src/env.js';
import { breakerOpen, resetBreakers } from '../../src/hosted/breaker.js';
import { hostedLegs } from '../../src/hosted/legs.js';
import { costFromTokensNanos } from '../../src/pool/pricing.js';
import { registryFor } from '../../src/registries.js';
import {
  newUser,
  simpleAccount,
  uniq,
  usageRows,
  type UsageRow,
} from '../mocks/billing-helpers.js';
import { cachePrefix, env, liveKey, priceOf, scenario, type Outcome } from './harness.js';
import { Deferred, tappedLegs, type Tap } from './taps.js';

/** The logical model (prices are keyed by it) and Anthropic's id of it. */
const HAIKU = 'anthropic/claude-haiku-5.5';
const HAIKU_ON_ANTHROPIC = 'claude-haiku-5-5';
/** Anthropic's web search fee, $10 per 1,000 searches, billed outside any reported cost. */
const ANTHROPIC_SEARCH_FEE_MICROS = 10_000;
const GRANT_MICROS = 1_000_000;
/** The `retry-after` the faked overload names, and the breaker window it opens. */
const RETRY_AFTER_S = 45;

/** The run's env with Anthropic first and OpenRouter behind it, on `anthropicKey`. */
function chainEnv(anthropicKey: string): AppEnv {
  return {
    ...env,
    BUILT_IN_PROVIDER: '',
    BUILT_IN_BACKENDS: 'anthropic,openrouter',
    BUILT_IN_ANTHROPIC_API_KEY: anthropicKey,
  };
}

/** Every leg is budgeted at the logical model's price, whichever backend's id it asks for. */
const haikuPrice = (): Promise<ModelPrice> => priceOf(HAIKU);

interface ChainCall {
  /** What the client got from the metered provider. */
  events: ProviderEvent[];
  /** The calls each leg made, in order. */
  legs: Tap[];
  /** The rows the call added. */
  rows: UsageRow[];
}

/** A fresh credit account whose built-in calls run on the chain. */
async function setUp() {
  const e = chainEnv(liveKey('ANTHROPIC_API_KEY')!);
  const account = simpleAccount(await newUser(e));
  await grantCredit(e.DB, {
    accountId: account.billingAccountId,
    kind: 'adjustment',
    amountMicros: GRANT_MICROS,
    providerRef: null,
  });
  const taps: Tap[] = [];
  const deferred = new Deferred();
  const provider = meteredRegistry(
    registryFor(e, account),
    createUsageMeter(e, account, deferred.defer),
    () => true,
    tappedLegs(hostedLegs(e), taps, haikuPrice),
  ).get(OPENROUTER_PROVIDER_ID)!;

  /** One call; `stopAfterDeltas` aborts it, as a user's stop does, after that many text deltas. */
  async function call(
    request: Omit<GenerateRequest, 'signal'>,
    opts: { stopAfterDeltas?: number } = {},
  ): Promise<ChainCall> {
    const seen = new Set((await usageRows(e, account.billingAccountId)).map((r) => r.id));
    const before = taps.length;
    const controller = new AbortController();
    const events: ProviderEvent[] = [];
    let deltas = 0;
    for await (const event of provider.stream({ ...request, signal: controller.signal })) {
      events.push(event);
      if (event.type === 'delta' && ++deltas === opts.stopAfterDeltas) controller.abort();
    }
    await deferred.settle();
    const rows = await usageRows(e, account.billingAccountId);
    return { events, legs: taps.slice(before), rows: rows.filter((r) => !seen.has(r.id)) };
  }
  return { call };
}

/** A short reply on Haiku, thinking off, its output capped at `maxOutputTokens`. */
function haikuRequest(
  messages: ChatMessage[],
  opts: { maxOutputTokens: number; system?: string; webSearch?: WebSearchRequest },
): Omit<GenerateRequest, 'signal'> {
  return {
    model: HAIKU,
    system: opts.system ?? null,
    messages,
    maxOutputTokens: opts.maxOutputTokens,
    reasoning: 'none',
    usageTag: { purpose: 'reply', treeId: uniq('tree'), branchId: null, nodeId: uniq('node') },
    ...(opts.webSearch ? { webSearch: opts.webSearch } : {}),
  };
}

const textOf = (events: readonly ProviderEvent[]): string =>
  events.map((e) => (e.type === 'delta' ? e.text : '')).join('');

function ending(events: readonly ProviderEvent[]): string {
  const last = events.at(-1);
  if (last?.type !== 'error') return last?.type ?? 'nothing';
  return `error ${last.error.code}${last.error.status ? ` (HTTP ${last.error.status})` : ''}: ${last.error.message}`;
}

/** The call made one row, settled on `backend` with credit's list price; its failures. */
function oneRow(c: ChainCall, backend: 'anthropic' | 'openrouter', label: string): string[] {
  if (c.rows.length !== 1) return [`${label} made ${c.rows.length} usage rows, not 1`];
  const row = c.rows[0]!;
  const backendModel = backend === 'anthropic' ? HAIKU_ON_ANTHROPIC : HAIKU;
  const failures: string[] = [];
  if (row.status !== 'settled') failures.push(`${label}'s row is ${row.status}`);
  if (row.model !== HAIKU) failures.push(`${label}'s row is on ${row.model}, not ${HAIKU}`);
  if (row.backend !== backend || row.backend_model !== backendModel)
    failures.push(
      `${label}'s row is on ${row.backend}/${row.backend_model}, not ${backend}/${backendModel}`,
    );
  if (row.markup_bps !== 0 || row.fee_bps !== 0)
    failures.push(`${label}: charged at ${row.markup_bps}/${row.fee_bps} bps, not list price`);
  const charge = chargeMicros(row.cost_nanos ?? 0, 0, 0);
  if (row.charge_micros !== charge)
    failures.push(`${label}: charged ${row.charge_micros} µ$, its cost makes ${charge}`);
  if ((row.charge_micros ?? 0) > row.hold_micros)
    failures.push(`${label}: charged ${row.charge_micros} µ$ over its ${row.hold_micros} µ$ hold`);
  return failures;
}

/**
 * An Anthropic leg's row against what the leg reported: its tokens and searches, and
 * its cost, those tokens at the logical model's price plus each search's fee.
 */
async function anthropicCharge(
  row: UsageRow,
  leg: Tap,
  label: string,
): Promise<{ failures: string[]; costNanos: number }> {
  const failures: string[] = [];
  const usage = leg.summary.usage;
  if (row.settle_reason !== 'tokens')
    failures.push(`${label} settled by ${row.settle_reason}, not its tokens`);
  if (row.input_tokens !== usage.inputTokens || row.output_tokens !== usage.outputTokens)
    failures.push(
      `${label}: tokens ${row.input_tokens}/${row.output_tokens}, Anthropic reported ${usage.inputTokens}/${usage.outputTokens}`,
    );
  const searches = leg.summary.billing.webSearches ?? 0;
  if (row.web_searches !== searches)
    failures.push(`${label} records ${row.web_searches} searches, Anthropic reported ${searches}`);
  const costNanos =
    costFromTokensNanos(await priceOf(HAIKU), usage.inputTokens ?? 0, usage.outputTokens ?? 0, {
      readTokens: usage.cacheReadTokens ?? null,
      writeTokens: usage.cacheWriteTokens ?? null,
    }) +
    searches * ANTHROPIC_SEARCH_FEE_MICROS * 1000;
  if (row.cost_nanos !== costNanos)
    failures.push(
      `${label}: cost ${row.cost_nanos} n$, its tokens and ${searches} searches make ${costNanos}`,
    );
  return { failures, costNanos };
}

/** The legs a call ran on, by the model each asked for. */
const legModels = (c: ChainCall): string => c.legs.map((l) => l.request.model).join(' → ');

/** The structured log lines written on `console.warn` while `work` runs. */
async function warnLines<T>(
  work: () => Promise<T>,
): Promise<{ result: T; lines: Record<string, unknown>[] }> {
  const lines: Record<string, unknown>[] = [];
  const warn = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
    try {
      const parsed: unknown = JSON.parse(String(line));
      if (typeof parsed === 'object' && parsed !== null)
        lines.push(parsed as Record<string, unknown>);
    } catch {
      // Not a structured line.
    }
  });
  try {
    return { result: await work(), lines };
  } finally {
    warn.mockRestore();
  }
}

/** The URL `fetch` was called with. */
function urlOf(input: RequestInfo | URL): URL {
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
}

/**
 * Stubs `fetch` so every message call to Anthropic's API answers HTTP 529 with
 * `retry-after` and an overloaded_error, as Anthropic does when overloaded; every other
 * request goes out as usual. Returns the count of calls it refused.
 */
function overloadAnthropic(): { refused: () => number } {
  const realFetch = globalThis.fetch.bind(globalThis);
  let refused = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = urlOf(input);
    if (url.origin === 'https://api.anthropic.com' && url.pathname === '/v1/messages') {
      refused++;
      const body = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 529,
          headers: { 'content-type': 'application/json', 'retry-after': String(RETRY_AFTER_S) },
        }),
      );
    }
    return realFetch(input, init);
  });
  return { refused: () => refused };
}

describe('Tangent credit on the hosted backend chain (Anthropic, then OpenRouter)', () => {
  const skip = liveKey('ANTHROPIC_API_KEY') ? null : 'no TANGENT_LIVE_ANTHROPIC_KEY';

  afterEach(() => {
    vi.restoreAllMocks();
    resetBreakers();
  });

  scenario(
    'chain: a searched reply on Anthropic settles by its tokens, and its second turn reads the cache',
    'anthropic',
    async () => {
      resetBreakers();
      const { call } = await setUp();
      // Long enough to be cached on Haiku, the same on both turns.
      const system = cachePrefix(5_000);
      const webSearch: WebSearchRequest = { mode: 'required', maxUses: 1 };
      const question = 'What is the latest stable release of Node.js? One sentence, cite a source.';
      const first = await call(
        haikuRequest([{ role: 'user', content: question }], {
          system,
          webSearch,
          maxOutputTokens: 300,
        }),
      );
      const second = await call(
        haikuRequest(
          [
            { role: 'user', content: question },
            { role: 'assistant', content: textOf(first.events) || '(no answer)' },
            { role: 'user', content: 'And the one before it? One sentence.' },
          ],
          { system, webSearch, maxOutputTokens: 300 },
        ),
      );
      const failures: string[] = [];
      const warnings: string[] = [];
      const notes: string[] = [];
      let recomputedUsd: number | null = null;
      for (const [label, c] of [
        ['the first turn', first],
        ['the second turn', second],
      ] as const) {
        if (c.events.at(-1)?.type !== 'done')
          failures.push(`${label} ended with ${ending(c.events)}`);
        if (c.legs.length !== 1 || c.legs[0]!.request.model !== HAIKU_ON_ANTHROPIC)
          failures.push(
            `${label} ran on ${legModels(c)}, not Anthropic's ${HAIKU_ON_ANTHROPIC} alone`,
          );
        failures.push(...oneRow(c, 'anthropic', label));
        const row = c.rows[0];
        const leg = c.legs[0];
        if (!row || !leg) continue;
        const priced = await anthropicCharge(row, leg, label);
        failures.push(...priced.failures);
        if (c === second) recomputedUsd = priced.costNanos / 1e9;
        if (row.web_searches === 0)
          warnings.push(`${label} did not search: the search fee went untested there`);
        notes.push(
          `${label}: ${row.charge_micros} µ$ of a ${row.hold_micros} µ$ hold, ${row.input_tokens}/${row.output_tokens} tokens (cache read ${leg.summary.usage.cacheReadTokens ?? '–'}, write ${leg.summary.usage.cacheWriteTokens ?? '–'}), ${row.web_searches} searches`,
        );
      }
      if ((second.legs[0]?.summary.usage.cacheReadTokens ?? 0) === 0)
        warnings.push('the second turn read nothing from the prompt cache');
      notes.push(
        "compare these charges with the Anthropic Console's usage for the run by hand (the API reports no cost)",
      );
      const reply = second.legs[0];
      return {
        model: HAIKU,
        ...(reply ? { summary: reply.summary } : {}),
        recomputedUsd,
        failures,
        warnings,
        notes,
      } satisfies Outcome;
    },
    { skip },
  );

  scenario(
    'chain: a reply the user stops on Anthropic is charged its input alone',
    'anthropic',
    async () => {
      resetBreakers();
      const { call } = await setUp();
      const STOP_AFTER = 50;
      const c = await call(
        haikuRequest(
          [
            {
              role: 'user',
              content: 'Count from one to two hundred in words, separated by commas. Nothing else.',
            },
          ],
          { maxOutputTokens: 1_500 },
        ),
        { stopAfterDeltas: STOP_AFTER },
      );
      const failures: string[] = [];
      const warnings: string[] = [];
      const deltas = c.events.filter((e) => e.type === 'delta').length;
      const notes = [
        `stopped after ${deltas} text deltas, ${textOf(c.events).length} characters streamed; the call ended with ${ending(c.events)}`,
      ];
      if (deltas < STOP_AFTER)
        failures.push(
          `the reply ended after ${deltas} deltas, before the stop: nothing was stopped`,
        );
      if (c.legs.length !== 1 || c.legs[0]!.request.model !== HAIKU_ON_ANTHROPIC)
        failures.push(
          `the call ran on ${legModels(c)}, not Anthropic's ${HAIKU_ON_ANTHROPIC} alone`,
        );
      failures.push(...oneRow(c, 'anthropic', 'the stopped reply'));
      const row = c.rows[0];
      let recomputedUsd: number | null = null;
      if (row) {
        if (row.settle_reason !== 'tokens')
          failures.push(`the stopped reply settled by ${row.settle_reason}, not its input tokens`);
        if (row.output_tokens === 1)
          failures.push(
            "the stopped reply recorded 1 output token: message_start's placeholder count was charged",
          );
        else if ((row.output_tokens ?? 0) !== 0)
          failures.push(
            `the stopped reply recorded ${row.output_tokens} output tokens before its final usage`,
          );
        const input = row.input_tokens ?? row.held_input_tokens;
        if (input === null) failures.push('the stopped reply has no input count');
        else {
          const costNanos = costFromTokensNanos(await priceOf(HAIKU), input, 0, {
            readTokens: 0,
            writeTokens: 0,
          });
          recomputedUsd = costNanos / 1e9;
          if (row.cost_nanos !== costNanos)
            failures.push(
              `the stopped reply cost ${row.cost_nanos} n$, its ${input} input tokens alone make ${costNanos}`,
            );
        }
        notes.push(
          `charged ${row.charge_micros} µ$ of a ${row.hold_micros} µ$ hold for ${row.input_tokens ?? '?'} input tokens; output recorded as ${row.output_tokens ?? 'null'}`,
        );
      }
      return {
        model: HAIKU,
        ...(c.legs[0] ? { summary: c.legs[0].summary } : {}),
        recomputedUsd,
        failures,
        warnings,
        notes,
      } satisfies Outcome;
    },
    { skip },
  );

  scenario(
    'chain: an overloaded Anthropic falls back to OpenRouter, and the next call starts there',
    'openrouter',
    async () => {
      resetBreakers();
      const { call } = await setUp();
      const anthropic = overloadAnthropic();
      const ask = () =>
        call(
          haikuRequest([{ role: 'user', content: 'Name one primary colour. One word.' }], {
            maxOutputTokens: 50,
          }),
        );
      const failures: string[] = [];
      const notes: string[] = [];

      const { result: first, lines } = await warnLines(ask);
      if (anthropic.refused() !== 1)
        failures.push(`Anthropic was asked ${anthropic.refused()} times, not once`);
      if (first.legs.length !== 2)
        failures.push(`the call ran on ${legModels(first)}, not Anthropic then OpenRouter`);
      const [refusedLeg, servedLeg] = first.legs;
      if (refusedLeg) {
        const t = refusedLeg.summary.terminal;
        if (refusedLeg.request.model !== HAIKU_ON_ANTHROPIC)
          failures.push(`the first leg asked for ${refusedLeg.request.model}`);
        if (
          t?.type !== 'error' ||
          t.error.code !== 'overloaded' ||
          t.error.status !== 529 ||
          t.error.retryAfterMs !== RETRY_AFTER_S * 1000 ||
          t.error.upstream !== 'rejected'
        )
          failures.push(
            `Anthropic's leg ended with ${ending(refusedLeg.events)}, not a rejected 529 overload with its retry-after`,
          );
        if (refusedLeg.events.length !== 1)
          failures.push(
            `Anthropic's leg yielded ${refusedLeg.events.length} events, not its error alone`,
          );
      }
      if (servedLeg) {
        if (servedLeg.request.model !== HAIKU)
          failures.push(`the fallback leg asked for ${servedLeg.request.model}, not ${HAIKU}`);
        // The client got the OpenRouter leg's stream and nothing of Anthropic's.
        if (JSON.stringify(first.events) !== JSON.stringify(servedLeg.events))
          failures.push(
            `the client got ${first.events.length} events (ending ${ending(first.events)}), not the OpenRouter leg's ${servedLeg.events.length}`,
          );
      }
      if (first.events.at(-1)?.type !== 'done')
        failures.push(`the call ended with ${ending(first.events)}`);
      failures.push(...oneRow(first, 'openrouter', 'the fallen-back call'));
      const row = first.rows[0];
      const reported = servedLeg?.summary.billing.costUsd;
      if (row) {
        if (row.settle_reason !== 'cost')
          failures.push(
            `the fallen-back call settled by ${row.settle_reason}, not its reported cost`,
          );
        else if (reported === undefined || row.cost_nanos !== costUsdToNanos(reported))
          failures.push(
            `the fallen-back call's cost is ${row.cost_nanos} n$, OpenRouter reported ${reported === undefined ? 'none' : costUsdToNanos(reported)}`,
          );
        notes.push(`charged ${row.charge_micros} µ$ of a ${row.hold_micros} µ$ hold`);
      }
      const fallback = lines.find((l) => l['event'] === 'backend_fallback');
      if (!fallback) failures.push('no backend_fallback log line');
      else {
        const expected = {
          usageId: row?.id,
          from: 'anthropic',
          to: 'openrouter',
          model: HAIKU,
          code: 'overloaded',
          status: 529,
          retryAfterMs: RETRY_AFTER_S * 1000,
        };
        for (const [field, value] of Object.entries(expected))
          if (fallback[field] !== value)
            failures.push(
              `backend_fallback logged ${field} ${JSON.stringify(fallback[field])}, not ${JSON.stringify(value)}`,
            );
      }
      if (!lines.some((l) => l['event'] === 'backend_circuit_open' && l['backend'] === 'anthropic'))
        failures.push("no backend_circuit_open log line for Anthropic's breaker");
      if (!breakerOpen('anthropic', HAIKU_ON_ANTHROPIC, Date.now()))
        failures.push("Anthropic's breaker for Haiku is not open after its 529");

      // The breaker is open: the next call starts on OpenRouter, without asking Anthropic.
      const { result: next, lines: nextLines } = await warnLines(ask);
      if (anthropic.refused() !== 1)
        failures.push(
          'the call after the overload asked Anthropic again while its breaker was open',
        );
      if (next.legs.length !== 1 || next.legs[0]!.request.model !== HAIKU)
        failures.push(
          `the call after the overload ran on ${legModels(next)}, not OpenRouter alone`,
        );
      if (next.events.at(-1)?.type !== 'done')
        failures.push(`the call after the overload ended with ${ending(next.events)}`);
      if (nextLines.some((l) => l['event'] === 'backend_fallback'))
        failures.push('the call after the overload fell back');
      failures.push(...oneRow(next, 'openrouter', 'the call after the overload'));

      return {
        model: HAIKU,
        ...(servedLeg ? { summary: servedLeg.summary } : {}),
        failures,
        warnings: [],
        notes,
      } satisfies Outcome;
    },
    { skip },
  );
});
