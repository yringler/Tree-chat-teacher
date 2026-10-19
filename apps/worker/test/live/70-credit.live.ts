// Tangent credit end to end on real OpenRouter: Learn's ChatService on credit, with the
// real usage meter (`createUsageMeter`, `meteredRegistry`) over the built-in provider as
// production composes it, and a tap under the meter that sees exactly what it saw. Each
// settled row must be the reported cost, charged at list price (no markup, no fee), held
// for at least what it charged, and the balance must fall by exactly the charges. What
// was really sent upstream comes from the host (`sentRequests`).
//
// The last scenarios run the same meter with the built-in provider on Anthropic's own
// API (an in-process `BUILT_IN_PROVIDER` and `MODEL_PRICES` over the run's env, the one
// place the suite moves off production's provider): Anthropic reports no cost, so each
// row is priced from its tokens plus a fee per search the provider counted.
import { createMemoryRepositories } from '@tangent/core/memory';
import { ChatService } from '@tangent/core';
import {
  BUILT_IN_MAX_OUTPUT_TOKENS,
  chargeMicros,
  costUsdToNanos,
  errorKindOf,
  splitTangents,
  type ChatNode,
  type StreamEvent,
} from '@tangent/shared';
import { describe } from 'vitest';
import { CRON_MIN_AGE_MS, reconcilePendingUsage } from '../../src/billing/reconcile.js';
import { groundingAllowance } from '../../src/billing/grounding.js';
import { getBalance, grantCredit } from '../../src/billing/ledger.js';
import { meteredRegistry } from '../../src/billing/meter.js';
import { createUsageMeter } from '../../src/billing/personal-meter.js';
import {
  DEFAULT_BACKGROUND_EFFORT,
  DEFAULT_BACKGROUND_MODEL,
  type ModelPrice,
} from '../../src/config.js';
import type { AppEnv } from '../../src/env.js';
import { creditPrice } from '../../src/pool/model-prices.js';
import { costFromTokensNanos } from '../../src/pool/pricing.js';
import { chatSettingsFor, defaultSystemPromptFor, registryFor } from '../../src/registries.js';
import { newUser, simpleAccount, usageRows, type UsageRow } from '../mocks/billing-helpers.js';
import {
  ABSOLUTE_SLACK_USD,
  env,
  liveKey,
  lookUpGeneration,
  NORMAL_RATIO_BAND,
  OVER_LIST_TOLERANCE,
  priceOf,
  recompute,
  scenario,
  sentRequests,
  type Outcome,
} from './harness.js';
import type { RequestShape } from './host.js';
import { Deferred, tappedRegistry, type Tap } from './taps.js';

const GRANT_MICROS = 1_000_000;

async function setUp(e: AppEnv = env, price: (model: string) => Promise<ModelPrice> = priceOf) {
  const account = simpleAccount(await newUser(e));
  await grantCredit(e.DB, {
    accountId: account.billingAccountId,
    kind: 'adjustment',
    amountMicros: GRANT_MICROS,
    providerRef: null,
  });
  const taps: Tap[] = [];
  const deferred = new Deferred();
  let abortOnFirstEvent: AbortController | null = null;
  const inner = tappedRegistry(
    registryFor(e, account),
    taps,
    () => {
      abortOnFirstEvent?.abort();
      abortOnFirstEvent = null;
    },
    price,
  );
  const service = new ChatService({
    repos: createMemoryRepositories(),
    accountId: account.id,
    providers: meteredRegistry(inner, createUsageMeter(e, account, deferred.defer), () => true),
    profile: { kind: 'learn', customPrompt: true },
    settings: chatSettingsFor(e, account),
    defaultSystemPrompt: defaultSystemPromptFor(e, account),
    groundingAllowance: groundingAllowance(e, account),
  });
  const tree = await service.createTree({ title: 'Live credit' });
  const branchId = tree.branches[0]!.id;

  /** One send on the trunk; `abort` stops it at the provider's first event. */
  async function send(
    content: string,
    opts: { ground?: 'required'; abort?: boolean } = {},
  ): Promise<StreamEvent[]> {
    const controller = new AbortController();
    if (opts.abort) abortOnFirstEvent = controller;
    const begin = await service.beginSend(branchId, content);
    const events: StreamEvent[] = [];
    for await (const event of service.runGeneration(
      begin,
      controller.signal,
      opts.ground ? { ground: opts.ground } : {},
    ))
      events.push(event);
    await deferred.settle();
    return events;
  }
  return { account, taps, send };
}

type Credit = Awaited<ReturnType<typeof setUp>>;
let credit: Credit | null = null;
const ready = async (): Promise<Credit> => (credit ??= await setUp());

/** The tap whose generation is `row`'s. */
function tapOf(taps: readonly Tap[], row: UsageRow): Tap | undefined {
  return taps.find((t) => t.summary.billing.generationId === row.generation_id);
}

/** Every settled row matches what the meter saw, at list price, within its hold. */
function checkRows(rows: readonly UsageRow[], taps: readonly Tap[]): string[] {
  const failures: string[] = [];
  for (const row of rows) {
    const label = `${row.purpose} row ${row.id}`;
    if (row.status !== 'settled') {
      failures.push(`${label} is ${row.status}`);
      continue;
    }
    const tap = tapOf(taps, row);
    const cost = tap?.summary.billing.costUsd;
    if (row.settle_reason === 'cost') {
      if (cost === undefined) failures.push(`${label} settled on a cost no stream reported`);
      else if (row.cost_nanos !== costUsdToNanos(cost))
        failures.push(
          `${label}: cost_nanos ${row.cost_nanos}, the stream said ${costUsdToNanos(cost)}`,
        );
      const usage = tap?.summary.usage;
      if (
        usage &&
        (row.input_tokens !== usage.inputTokens || row.output_tokens !== usage.outputTokens)
      )
        failures.push(
          `${label}: tokens ${row.input_tokens}/${row.output_tokens}, the stream said ${usage.inputTokens}/${usage.outputTokens}`,
        );
    }
    if (row.markup_bps !== 0 || row.fee_bps !== 0)
      failures.push(
        `${label}: credit charged at ${row.markup_bps}/${row.fee_bps} bps, not list price`,
      );
    const charge = chargeMicros(row.cost_nanos ?? 0, 0, 0);
    if (row.charge_micros !== charge)
      failures.push(`${label}: charged ${row.charge_micros} µ$, its cost makes ${charge}`);
    if ((row.charge_micros ?? 0) > row.hold_micros)
      failures.push(
        `${label}: charged ${row.charge_micros} µ$ over its ${row.hold_micros} µ$ hold`,
      );
  }
  return failures;
}

function lastEvent(events: readonly StreamEvent[]): string {
  const last = events.at(-1);
  if (last?.type !== 'error') return last?.type ?? 'nothing';
  const kind = last.node ? errorKindOf(last.node) : null;
  return `error${kind ? ` (${kind})` : ''}: ${last.message}`;
}

/** The reply's node as the send ended: complete, or the error it ended in. */
function replyNode(events: readonly StreamEvent[]): ChatNode | null {
  const last = events.at(-1);
  return last?.type === 'done' || last?.type === 'error' ? last.node : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** What Normal's calls must ask OpenRouter: Anthropic's own endpoint first, fallbacks allowed. */
function routingFailures(shape: RequestShape, label: string): string[] {
  const p = isRecord(shape.provider) ? shape.provider : {};
  const order = p['order'];
  const failures: string[] = [];
  if (!Array.isArray(order) || order.length !== 1 || order[0] !== 'anthropic')
    failures.push(`${label} sent provider.order ${JSON.stringify(order)}, not ["anthropic"]`);
  if (p['allow_fallbacks'] !== true)
    failures.push(`${label} sent provider.allow_fallbacks ${JSON.stringify(p['allow_fallbacks'])}`);
  return failures;
}

const effortOf = (shape: RequestShape): unknown =>
  isRecord(shape.reasoning) ? shape.reasoning['effort'] : shape.reasoning;

/** Summaries and titles run on the background model. */
function backgroundFailures(rows: readonly UsageRow[]): string[] {
  return rows
    .filter((r) => r.purpose !== 'reply' && r.model !== DEFAULT_BACKGROUND_MODEL)
    .map((r) => `${r.purpose} row ${r.id} ran on ${r.model}, not ${DEFAULT_BACKGROUND_MODEL}`);
}

describe('Tangent credit, end to end', () => {
  scenario(
    'credit: a long high-effort reply settles at its reported cost',
    'openrouter',
    async () => {
      const { account, taps, send } = await ready();
      await sentRequests();
      const events = await send(
        'Explain how public-key cryptography lets two strangers agree on a secret over an open channel. Teach it in three or four short paragraphs.',
      );
      const sent = await sentRequests();
      const rows = await usageRows(env, account.billingAccountId);
      const failures = [...checkRows(rows, taps), ...backgroundFailures(rows)];
      const warnings: string[] = [];
      const notes: string[] = [];
      const node = replyNode(events);
      if (events.at(-1)?.type !== 'done')
        failures.push(`the reply ended with ${lastEvent(events)}`);
      else if (node && splitTangents(node.content).tangents.length === 0)
        warnings.push('the reply has no tangents block (the tutor prompt asks for one)');
      if (!rows.some((r) => r.purpose === 'reply')) failures.push('no reply row');
      const { balanceMicros, heldMicros } = await getBalance(env.DB, account.billingAccountId);
      const charged = rows.reduce((sum, r) => sum + (r.charge_micros ?? 0), 0);
      if (GRANT_MICROS - balanceMicros !== charged)
        failures.push(
          `the balance fell by ${GRANT_MICROS - balanceMicros} µ$, the rows charged ${charged}`,
        );
      if (heldMicros !== 0) failures.push(`${heldMicros} µ$ still held`);
      const reply = taps.find((t) => t.request.usageTag?.purpose === 'reply');

      // What OpenRouter was asked: Normal's evaluated settings (`DEFAULT_TIER_REQUESTS.normal`),
      // and the background effort on summaries and titles, which share Normal's listing.
      const cap = reply?.request.maxOutputTokens;
      const replyShape = sent.find((s) => s.model === reply?.request.model && s.maxTokens === cap);
      if (!replyShape) failures.push('no upstream request matches the reply');
      else {
        if (effortOf(replyShape) !== 'high')
          failures.push(
            `the reply sent reasoning ${JSON.stringify(replyShape.reasoning)}, not effort high`,
          );
        if (replyShape.maxTokens === null || replyShape.maxTokens > BUILT_IN_MAX_OUTPUT_TOKENS)
          failures.push(
            `the reply asked for ${replyShape.maxTokens} tokens, over ${BUILT_IN_MAX_OUTPUT_TOKENS}`,
          );
      }
      for (const shape of sent) {
        const label = shape === replyShape ? 'the reply' : `a ${shape.model} background call`;
        failures.push(...routingFailures(shape, label));
        if (shape !== replyShape && effortOf(shape) !== DEFAULT_BACKGROUND_EFFORT.effort)
          warnings.push(
            `${label} sent reasoning ${JSON.stringify(shape.reasoning)}, not effort ${DEFAULT_BACKGROUND_EFFORT.effort}`,
          );
      }

      const usage = reply?.summary.usage;
      if (usage?.outputTokens !== undefined) {
        if (cap !== undefined && usage.outputTokens >= cap)
          failures.push(`${usage.outputTokens} output tokens reached the ${cap} cap`);
        const thinking = usage.reasoningTokens;
        notes.push(
          thinking === undefined
            ? `${usage.outputTokens} output tokens, no reasoning count reported (cap ${cap ?? '?'})`
            : `reasoning ${thinking} + answer ${usage.outputTokens - thinking} = ${usage.outputTokens} output tokens, ${Math.round((100 * thinking) / Math.max(1, usage.outputTokens))}% thinking (cap ${cap ?? '?'})`,
        );
      }
      notes.push(
        ...rows.map((r) => `${r.purpose} ${r.model} ${r.charge_micros} µ$ (hold ${r.hold_micros})`),
      );
      return {
        model: reply?.request.model ?? null,
        ...(reply ? { summary: reply.summary } : {}),
        failures,
        warnings,
        notes,
      } satisfies Outcome;
    },
  );

  scenario('credit: the second turn reads the prompt cache', 'openrouter', async () => {
    const { account, taps, send } = await ready();
    const before = taps.length;
    const events = await send('Is 91 a prime number? One sentence.');
    const rows = await usageRows(env, account.billingAccountId);
    const failures = [...checkRows(rows, taps), ...backgroundFailures(rows)];
    if (events.at(-1)?.type !== 'done') failures.push(`the reply ended with ${lastEvent(events)}`);
    const reply = taps.slice(before).find((t) => t.request.usageTag?.purpose === 'reply');
    const warnings =
      (reply?.summary.usage.cacheReadTokens ?? 0) === 0
        ? ['the second turn read nothing from the prompt cache']
        : [];
    if (!rows.some((r) => r.purpose !== 'reply'))
      warnings.push('two turns on credit ran no summary or title');
    let recomputedUsd: number | null = null;
    const reported = reply?.summary.billing.costUsd;
    if (reply && reported !== undefined) {
      recomputedUsd = recompute(await priceOf(reply.request.model), reply.summary.usage);
      if (recomputedUsd !== null) {
        if (reported > recomputedUsd * OVER_LIST_TOLERANCE + ABSOLUTE_SLACK_USD)
          failures.push(
            `reported $${reported} is over the price table's $${recomputedUsd}: a hold priced from it can fall short`,
          );
        const ratio = recomputedUsd > 0 ? reported / recomputedUsd : 1;
        if (ratio < NORMAL_RATIO_BAND.min || ratio > NORMAL_RATIO_BAND.max)
          warnings.push(
            `ratio ${ratio.toFixed(3)} outside ${NORMAL_RATIO_BAND.min}–${NORMAL_RATIO_BAND.max} (${NORMAL_RATIO_BAND.why})`,
          );
      }
    }
    return {
      model: reply?.request.model ?? null,
      ...(reply ? { summary: reply.summary } : {}),
      recomputedUsd,
      failures,
      warnings,
    } satisfies Outcome;
  });

  scenario('credit: a checked reply records its search', 'openrouter', async () => {
    const { account, taps, send } = await ready();
    const before = taps.length;
    const events = await send('What is the latest stable release of Node.js? Cite a source.', {
      ground: 'required',
    });
    const rows = await usageRows(env, account.billingAccountId);
    const failures = checkRows(rows, taps);
    if (events.at(-1)?.type !== 'done') failures.push(`the reply ended with ${lastEvent(events)}`);
    const reply = taps.slice(before).find((t) => t.request.usageTag?.purpose === 'reply');
    const row = rows.find((r) => reply && r.generation_id === reply.summary.billing.generationId);
    const warnings: string[] = [];
    if (!reply?.request.webSearch) failures.push('the reply was sent without a web search');
    else if (!row) failures.push('no row for the searched reply');
    else {
      const reported = reply.summary.billing.webSearches;
      if (row.web_searches !== reported)
        failures.push(
          `the row records ${row.web_searches} searches, the stream reported ${reported}`,
        );
      if (row.web_searches < 1) failures.push('the row records no search');
      if (row.web_searches > reply.request.webSearch.maxUses)
        warnings.push(
          `${row.web_searches} searches on a reply allowed ${reply.request.webSearch.maxUses}: each is charged`,
        );
    }
    return {
      model: reply?.request.model ?? null,
      ...(reply ? { summary: reply.summary } : {}),
      failures,
      warnings,
    } satisfies Outcome;
  });

  scenario('credit: an aborted reply settles by its generation', 'openrouter', async () => {
    const { account, taps, send } = await ready();
    const before = taps.length;
    await send('Name three prime numbers.', { abort: true });
    const reply = taps.slice(before).find((t) => t.request.usageTag?.purpose === 'reply');
    const id = reply?.summary.billing.generationId;
    const warnings: string[] = [];
    const failures: string[] = [];
    if (!id) failures.push('the abort came before a generation id');
    const pending = async () =>
      (await usageRows(env, account.billingAccountId)).find(
        (r) => r.generation_id === id && r.status === 'pending',
      );
    if (id && (await pending())) {
      // The meter's lookups gave up: the cron's turn, once OpenRouter has the generation.
      const lookup = await lookUpGeneration(id);
      if (!lookup.cost)
        failures.push(
          'OpenRouter never returned the aborted generation: the row would end unresolved at $0',
        );
      else {
        warnings.push(
          `the generation appeared after ${Math.round(lookup.afterMs / 1000)} s, past the meter's lookups; settled by the cron`,
        );
        await reconcilePendingUsage(env, new Date(Date.now() + CRON_MIN_AGE_MS));
      }
    }
    const rows = await usageRows(env, account.billingAccountId);
    const row = rows.find((r) => id !== undefined && r.generation_id === id);
    failures.push(...checkRows(rows, taps));
    if (id && !row) failures.push('no row for the aborted reply');
    else if (row && row.settle_reason !== 'generation')
      failures.push(`the aborted reply settled by ${row.settle_reason}, not its generation lookup`);
    const { balanceMicros, heldMicros } = await getBalance(env.DB, account.billingAccountId);
    const charged = rows.reduce((sum, r) => sum + (r.charge_micros ?? 0), 0);
    if (GRANT_MICROS - balanceMicros !== charged)
      failures.push(
        `the balance fell by ${GRANT_MICROS - balanceMicros} µ$, the rows charged ${charged}`,
      );
    if (heldMicros !== 0) failures.push(`${heldMicros} µ$ still held`);
    return {
      model: reply?.request.model ?? null,
      failures,
      warnings,
      notes: row
        ? [`charged ${row.charge_micros} µ$ for ${row.output_tokens ?? '?'} output tokens`]
        : [],
    } satisfies Outcome;
  });
});

// ---- Credit on Anthropic's own API

/** The model the Anthropic scenarios run, and the price they give it. */
const ANTHROPIC_MODEL = 'claude-haiku-5-5';
const ANTHROPIC_PRICE = { in: 100_000, out: 500_000, context: 1_000_000, cacheRead: 10_000 };
/** Anthropic's web search fee, $10 per 1,000 searches, billed outside any reported cost. */
const ANTHROPIC_SEARCH_FEE_MICROS = 10_000;

/**
 * The run's env with the built-in provider on Anthropic's own API (Normal only, search
 * on) and its model priced in `MODEL_PRICES` next to the deployed entries.
 */
function anthropicEnv(): AppEnv {
  const deployed = JSON.parse(env.MODEL_PRICES || '{}') as Record<string, unknown>;
  return {
    ...env,
    BUILT_IN_PROVIDER: JSON.stringify({
      id: 'openrouter',
      kind: 'anthropic',
      label: 'Tangent',
      apiKeySecret: 'ANTHROPIC_API_KEY',
      defaultModel: ANTHROPIC_MODEL,
      options: { webSearch: true },
      models: [{ id: ANTHROPIC_MODEL, label: 'Normal', tier: 'normal' }],
    }),
    MODEL_PRICES: JSON.stringify({ ...deployed, [ANTHROPIC_MODEL]: ANTHROPIC_PRICE }),
  };
}

function pricedIn(e: AppEnv): (model: string) => Promise<ModelPrice> {
  return async (model) => {
    const price = await creditPrice(e, model);
    if (!price) throw new Error(`${model} has no price`);
    return price;
  };
}

interface AnthropicCredit {
  run: Credit;
  price: (model: string) => Promise<ModelPrice>;
}
let anthropicCredit: AnthropicCredit | null = null;
async function readyAnthropic(): Promise<AnthropicCredit> {
  if (anthropicCredit) return anthropicCredit;
  const e = anthropicEnv();
  const price = pricedIn(e);
  anthropicCredit = { run: await setUp(e, price), price };
  return anthropicCredit;
}

/**
 * A send's new rows, each checked against what the provider reported: its search count,
 * and its charge recomputed from its tokens at the model's price plus each search's fee.
 */
async function anthropicSend(
  content: string,
  opts: { ground?: 'required' } = {},
): Promise<{ reply: Tap | undefined; row: UsageRow | undefined; outcome: Outcome }> {
  const { run, price } = await readyAnthropic();
  const seen = new Set((await usageRows(env, run.account.billingAccountId)).map((r) => r.id));
  const before = run.taps.length;
  const events = await run.send(content, opts);
  const rows = await usageRows(env, run.account.billingAccountId);
  const added = rows.filter((r) => !seen.has(r.id));
  const taps = run.taps.slice(before);
  const failures = checkRows(rows, run.taps);
  const notes: string[] = [];
  if (events.at(-1)?.type !== 'done') failures.push(`the reply ended with ${lastEvent(events)}`);
  let replyRow: UsageRow | undefined;
  let replyTap: Tap | undefined;
  let recomputedUsd: number | null = null;
  for (const row of added) {
    const label = `${row.purpose} row`;
    // Anthropic has no generation id: a row is its call's by purpose and tokens.
    const tap = taps.find(
      (t) =>
        t.request.usageTag?.purpose === row.purpose &&
        t.summary.usage.inputTokens === row.input_tokens &&
        t.summary.usage.outputTokens === row.output_tokens,
    );
    if (!tap) {
      failures.push(
        `${label}: no call reported its ${row.input_tokens}/${row.output_tokens} tokens`,
      );
      continue;
    }
    if (row.purpose === 'reply') [replyRow, replyTap] = [row, tap];
    const reported = tap.summary.billing.webSearches ?? 0;
    if (row.web_searches !== reported)
      failures.push(
        `${label} records ${row.web_searches} searches, Anthropic reported ${reported}`,
      );
    if (row.settle_reason !== 'tokens') {
      failures.push(`${label} settled by ${row.settle_reason}, not its tokens`);
      continue;
    }
    const usage = tap.summary.usage;
    const costNanos =
      costFromTokensNanos(await price(row.model), row.input_tokens, row.output_tokens, {
        readTokens: usage.cacheReadTokens ?? null,
        writeTokens: usage.cacheWriteTokens ?? null,
      }) +
      reported * ANTHROPIC_SEARCH_FEE_MICROS * 1000;
    if (row.cost_nanos !== costNanos)
      failures.push(
        `${label}: cost ${row.cost_nanos} n$, its tokens and ${reported} searches make ${costNanos}`,
      );
    const charge = chargeMicros(costNanos, 0, 0);
    if (row.charge_micros !== charge)
      failures.push(`${label}: charged ${row.charge_micros} µ$, recomputed ${charge}`);
    if (row.purpose === 'reply') recomputedUsd = costNanos / 1e9;
    notes.push(
      `${label}: ${row.charge_micros} µ$ of a ${row.hold_micros} µ$ hold, ${reported} searches; compare with Anthropic's Console by hand (the API reports no cost)`,
    );
  }
  if (!replyRow) failures.push('no reply row');
  return {
    reply: replyTap,
    row: replyRow,
    outcome: {
      model: ANTHROPIC_MODEL,
      ...(replyTap ? { summary: replyTap.summary } : {}),
      recomputedUsd,
      failures,
      warnings: [],
      notes,
    },
  };
}

describe("Tangent credit on Anthropic's own API", () => {
  const skip = liveKey('ANTHROPIC_API_KEY') ? null : 'no TANGENT_LIVE_ANTHROPIC_KEY';

  scenario(
    'credit (anthropic): a searched reply adds each search fee',
    'anthropic',
    async () => {
      const { reply, row, outcome } = await anthropicSend(
        'What is the latest stable release of Node.js? Answer in two sentences and cite your source.',
        { ground: 'required' },
      );
      if (!reply?.request.webSearch) outcome.failures.push('the reply was sent without a search');
      else if (row && row.web_searches === 0)
        outcome.warnings.push('the model did not search: the search fee went untested');
      return outcome;
    },
    { skip },
  );

  scenario(
    'credit (anthropic): a plain reply adds no search fee',
    'anthropic',
    async () => {
      const { row, outcome } = await anthropicSend('What is 7 times 8? Answer with the number.');
      if (row && row.web_searches > 0)
        outcome.warnings.push(
          `the plain reply searched ${row.web_searches} times: it was charged for them`,
        );
      return outcome;
    },
    { skip },
  );
});
