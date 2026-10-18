// The live suite's side in workerd: the providers as production builds them, one call
// at a time against the run's budget, and a report row per scenario. The host side
// (host.ts) keeps the budget and the report, so they hold across files.
import {
  checkContract,
  foldStream,
  type ContractExpectation,
  type ContractResult,
  type StreamSummary,
} from '@tangent/providers/contract';
import { fetchOpenRouterGeneration, type GenerationCost } from '@tangent/providers';
import type { GenerateRequest, LlmProvider, ProviderEvent, ProviderUsage } from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { RECONCILE_RETRY_DELAYS_MS } from '../../src/billing/reconcile.js';
import { namedSecrets, type ModelPrice } from '../../src/config.js';
import type { AppEnv } from '../../src/env.js';
import { creditPrice } from '../../src/pool/model-prices.js';
import { chargeFromTokensMicros, costFromTokensNanos } from '../../src/pool/pricing.js';
import { creditRegistryFor, registryFor } from '../../src/registries.js';
import { devPowerAccount, powerAccount, simpleAccount } from '../mocks/billing-helpers.js';
import { LIVE_CONTROL } from './bindings.js';
import type { RequestShape } from './host.js';
import type { ReportFooter, ReportRow, ScenarioStatus } from './report.js';

export const env: AppEnv = rawEnv;

// ---- The host's control origin

async function control<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${LIVE_CONTROL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json: unknown = await res.json();
  if (!res.ok) throw new Error(`live host ${path}: ${JSON.stringify(json)}`);
  return json as T;
}

export interface LiveSettings {
  budgetUsd: number;
  allowUnlimitedKey: boolean;
  record: boolean;
}

export const liveSettings = (): Promise<LiveSettings> => control('/__settings');
/** Opens the budget: only a passed preflight may spend. */
export const arm = (): Promise<unknown> => control('/__arm', {});
/** The shapes of the chat requests sent upstream since the last call (host.ts `RequestShape`). */
export const sentRequests = (): Promise<RequestShape[]> => control('/__requests');
export const postFooter = (footer: Partial<ReportFooter>): Promise<unknown> =>
  control('/__footer', footer);

/**
 * Reserves `worstUsd` of the run's budget for one call; throws, and nothing is sent,
 * when that would pass the budget or the preflight hasn't passed.
 */
export async function reserveBudget(worstUsd: number): Promise<number> {
  return (await control<{ id: number }>('/__budget/reserve', { usd: worstUsd })).id;
}

export const settleBudget = (id: number, usd: number): Promise<unknown> =>
  control('/__budget/settle', { id, usd });

// ---- Keys and registries, as production builds them

/** A key the run holds, under its production secret name (null when the run has none). */
export function liveKey(name: 'BUILT_IN_API_KEY' | 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY') {
  return namedSecrets(env, new Set([name]))[name] ?? null;
}

/** Every key the run holds: none may appear in an error message. */
export function liveSecrets(): string[] {
  return (['BUILT_IN_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const)
    .map(liveKey)
    .filter((k): k is string => k !== null);
}

/** A key of the right shape that no account has. */
export const BAD_KEYS = {
  openrouter: `sk-or-v1-${'0'.repeat(64)}`,
  anthropic: `sk-ant-api03-${'0'.repeat(90)}AA`,
  openai: `sk-proj-${'0'.repeat(120)}`,
} as const;

/** The built-in provider as Learn on credit gets it: the operator's key, Normal's settings. */
export function builtInProvider(e: AppEnv = env): LlmProvider {
  return registryFor(e, simpleAccount()).get('openrouter')!;
}

/** The built-in provider as power's Tangent credit gets it: any OpenRouter model. */
export function creditProvider(e: AppEnv = env): LlmProvider {
  return creditRegistryFor(e, powerAccount())!.get('openrouter')!;
}

/** Power's own-key providers (`PROVIDERS`, else the defaults) on the server's keys. */
export function powerProvider(id: 'anthropic' | 'openai', e: AppEnv = env): LlmProvider {
  return registryFor(e, devPowerAccount()).get(id)!;
}

// ---- Prices

/** The price credit holds `model` at (`creditPrice`: MODEL_PRICES, else the synced list). */
export async function priceOf(model: string): Promise<ModelPrice> {
  const price = await creditPrice(env, model);
  if (!price) throw new Error(`${model} has no price`);
  return price;
}

/** `usage` at `price`, before fees, USD; null without both counts. */
export function recompute(price: ModelPrice, usage: Partial<ProviderUsage>): number | null {
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) return null;
  return (
    costFromTokensNanos(price, usage.inputTokens, usage.outputTokens, {
      readTokens: usage.cacheReadTokens ?? null,
      writeTokens: usage.cacheWriteTokens ?? null,
    }) / 1e9
  );
}

/** A call's worst case at `price`, USD, with room for a route dearer than the list. */
export function worstUsd(price: ModelPrice, inputTokens: number, maxOutputTokens: number): number {
  return (2 * chargeFromTokensMicros(price, inputTokens, maxOutputTokens, 0, 0)) / 1e6;
}

/** What one web search can add to a call's worst case (OpenRouter's engines bill per result). */
export const SEARCH_ALLOWANCE_USD = 0.05;

// ---- Calls

export interface LiveCall {
  provider: LlmProvider;
  request: Omit<GenerateRequest, 'signal'>;
  /** Reserved from the budget before the call. */
  worstUsd: number;
  /**
   * Aborts the call at its first event: OpenRouter's generation id, sent before any text
   * (a reasoning model streams nothing the adapter yields while it thinks).
   */
  abortEarly?: boolean;
}

export interface LiveResult {
  summary: StreamSummary;
  events: ProviderEvent[];
  /** Attempts it took (rate limits and overloads are retried). */
  attempts: number;
}

const RETRYABLE: ReadonlySet<string> = new Set(['rate_limit', 'overloaded', 'server', 'network']);
const MAX_RETRIES = 2;

async function streamOnce(
  call: LiveCall,
): Promise<{ summary: StreamSummary; events: ProviderEvent[] }> {
  const ticket = await reserveBudget(call.worstUsd);
  const controller = new AbortController();
  const events: ProviderEvent[] = [];
  try {
    for await (const event of call.provider.stream({
      ...call.request,
      signal: controller.signal,
    })) {
      events.push(event);
      if (call.abortEarly) controller.abort();
    }
  } finally {
    const summary = foldStream(events);
    const t = summary.terminal;
    const unbilled =
      t?.type === 'error' && (t.error.upstream === 'rejected' || t.error.upstream === 'not_sent');
    // An unreported cost (a direct provider, an aborted call) stays at its worst case.
    await settleBudget(ticket, unbilled ? 0 : (summary.billing.costUsd ?? call.worstUsd));
  }
  return { summary: foldStream(events), events };
}

/**
 * One call, retried at most twice when it fails as rate-limited, overloaded, a server
 * error or a network failure (each attempt is budgeted). Any other outcome is the result.
 */
export async function callWithRetry(call: LiveCall): Promise<LiveResult> {
  for (let attempt = 1; ; attempt++) {
    const result = await streamOnce(call);
    const t = result.summary.terminal;
    if (t?.type !== 'error' || !RETRYABLE.has(t.error.code) || attempt > MAX_RETRIES)
      return { ...result, attempts: attempt };
    await new Promise((r) => setTimeout(r, 2_000 * attempt));
  }
}

// ---- Generation lookups

/** How long past production's lookups a scenario keeps asking, to tell late from never. */
const LOOKUP_GRACE_MS = 4 * 60_000;
const LOOKUP_GRACE_STEP_MS = 30_000;

export interface GenerationLookup {
  cost: GenerationCost | null;
  /** Since the first lookup's wait began. */
  afterMs: number;
  /** Found within the meter's own lookups (RECONCILE_RETRY_DELAYS_MS). */
  inTime: boolean;
}

/**
 * Looks `id` up as the meter does (`RECONCILE_RETRY_DELAYS_MS`), then every 30 s for
 * four more minutes, the cron's job: whether OpenRouter has it, and how soon.
 */
export async function lookUpGeneration(id: string): Promise<GenerationLookup> {
  const key = liveKey('BUILT_IN_API_KEY')!;
  const started = Date.now();
  const delays = [
    ...RECONCILE_RETRY_DELAYS_MS,
    ...Array.from({ length: LOOKUP_GRACE_MS / LOOKUP_GRACE_STEP_MS }, () => LOOKUP_GRACE_STEP_MS),
  ];
  for (const [i, delay] of delays.entries()) {
    await new Promise((r) => setTimeout(r, delay));
    const cost = await fetchOpenRouterGeneration(id, key);
    if (cost)
      return { cost, afterMs: Date.now() - started, inTime: i < RECONCILE_RETRY_DELAYS_MS.length };
  }
  return { cost: null, afterMs: Date.now() - started, inTime: false };
}

// ---- The prompt cache

/**
 * A prompt prefix of about `tokens` tokens, the same on every call, so a second call
 * can read what the first wrote to the prompt cache.
 */
export function cachePrefix(tokens: number): string {
  const facts: string[] = [];
  for (let i = 1; facts.length * 12 < tokens; i++)
    facts.push(`Fact ${i}: ${i} times ${i} is ${i * i}, and ${i} plus ${i} is ${i + i}.`);
  return `You are a concise tutor. Reference table:\n${facts.join('\n')}`;
}

/** A soft check: the second of two identical calls read from the prompt cache. */
export function cacheWarnings(first: Outcome, second: Outcome, explicit: boolean): string[] {
  const warnings: string[] = [];
  if (explicit && (first.summary?.usage.cacheWriteTokens ?? 0) === 0)
    warnings.push('the first call reported no cache write');
  if ((second.summary?.usage.cacheReadTokens ?? 0) === 0)
    warnings.push('the second call read nothing from the prompt cache');
  return warnings;
}

// ---- Scenarios and the report

export function tokensOf(usage: Partial<ProviderUsage>): string | null {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return null;
  return `${usage.inputTokens ?? '?'}/${usage.outputTokens ?? '?'} (${usage.cacheReadTokens ?? '–'}/${usage.cacheWriteTokens ?? '–'}, ${usage.reasoningTokens ?? '–'})`;
}

/** What a scenario found: its contract result and anything else it checked. */
export interface Outcome {
  model: string | null;
  summary?: StreamSummary;
  recomputedUsd?: number | null;
  failures: string[];
  warnings: string[];
  notes?: string[];
}

export function outcomeOf(
  model: string,
  summary: StreamSummary,
  expected: ContractExpectation,
  secrets: readonly string[] = liveSecrets(),
): Outcome & ContractResult {
  return { model, summary, ...checkContract(summary, expected, secrets) };
}

export const observe = (row: ReportRow): Promise<unknown> => control('/__observe', row);

/**
 * A test that posts its report row, PASS, WARN (soft checks only) or FAIL, and fails
 * on any hard failure. `skip` (a reason) posts SKIPPED and skips it.
 */
export function scenario(
  name: string,
  adapter: string,
  run: () => Promise<Outcome>,
  opts: { skip?: string | null } = {},
): void {
  it(name, async (ctx) => {
    const base = { scenario: name, adapter, servedBy: null, tokens: null };
    if (opts.skip) {
      await observe({
        ...base,
        model: null,
        reportedUsd: null,
        recomputedUsd: null,
        status: 'SKIPPED',
        notes: [opts.skip],
      });
      ctx.skip(opts.skip);
      return;
    }
    let outcome: Outcome;
    try {
      outcome = await run();
    } catch (e) {
      await observe({
        ...base,
        model: null,
        reportedUsd: null,
        recomputedUsd: null,
        status: 'FAIL',
        notes: [e instanceof Error ? e.message : String(e)],
      });
      throw e;
    }
    const status: ScenarioStatus =
      outcome.failures.length > 0 ? 'FAIL' : outcome.warnings.length > 0 ? 'WARN' : 'PASS';
    const s = outcome.summary;
    await observe({
      ...base,
      model: outcome.model,
      servedBy: s?.billing.servedBy ?? null,
      tokens: s ? tokensOf(s.usage) : null,
      reportedUsd: s?.billing.costUsd ?? null,
      recomputedUsd: outcome.recomputedUsd ?? null,
      status,
      notes: [
        ...outcome.failures,
        ...outcome.warnings.map((w) => `warn: ${w}`),
        ...(outcome.notes ?? []),
      ],
    });
    expect(outcome.failures).toEqual([]);
  });
}

// ---- Record mode

/**
 * Records the next chat call's response as `<adapter>/<name>.json` under
 * packages/providers/test/fixtures/live when the run records (TANGENT_LIVE_RECORD=1).
 */
export async function recorded<T>(
  fixture: { adapter: string; name: string; model: string; expectation: ContractExpectation },
  run: () => Promise<T>,
): Promise<T> {
  await control('/__record/start', {
    adapter: fixture.adapter,
    scenario: fixture.name,
    model: fixture.model,
    expectation: fixture.expectation,
  });
  try {
    return await run();
  } finally {
    await control('/__record/stop', {});
  }
}
