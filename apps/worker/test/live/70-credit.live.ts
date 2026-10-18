// Tangent credit end to end on real OpenRouter: Learn's ChatService on credit, with the
// real usage meter (`createUsageMeter`, `meteredRegistry`) over the built-in provider as
// production composes it, and a tap under the meter that sees exactly what it saw. Each
// settled row must be the reported cost, charged at list price (no markup, no fee), held
// for at least what it charged, and the balance must fall by exactly the charges.
import { createMemoryRepositories } from '@tangent/core/memory';
import { ChatService } from '@tangent/core';
import { chargeMicros, costUsdToNanos, type StreamEvent } from '@tangent/shared';
import { describe } from 'vitest';
import { CRON_MIN_AGE_MS, reconcilePendingUsage } from '../../src/billing/reconcile.js';
import { groundingAllowance } from '../../src/billing/grounding.js';
import { getBalance, grantCredit } from '../../src/billing/ledger.js';
import { meteredRegistry } from '../../src/billing/meter.js';
import { createUsageMeter } from '../../src/billing/personal-meter.js';
import { chatSettingsFor, defaultSystemPromptFor, registryFor } from '../../src/registries.js';
import { newUser, simpleAccount, usageRows, type UsageRow } from '../mocks/billing-helpers.js';
import { env, lookUpGeneration, scenario, type Outcome } from './harness.js';
import { Deferred, tappedRegistry, type Tap } from './taps.js';

const GRANT_MICROS = 1_000_000;

async function setUp() {
  const account = simpleAccount(await newUser(env));
  await grantCredit(env.DB, {
    accountId: account.billingAccountId,
    kind: 'adjustment',
    amountMicros: GRANT_MICROS,
    providerRef: null,
  });
  const taps: Tap[] = [];
  const deferred = new Deferred();
  let abortOnFirstEvent: AbortController | null = null;
  const inner = tappedRegistry(registryFor(env, account), taps, () => {
    abortOnFirstEvent?.abort();
    abortOnFirstEvent = null;
  });
  const service = new ChatService({
    repos: createMemoryRepositories(),
    accountId: account.id,
    providers: meteredRegistry(inner, createUsageMeter(env, account, deferred.defer), () => true),
    profile: { kind: 'learn', customPrompt: true },
    settings: chatSettingsFor(env, account),
    defaultSystemPrompt: defaultSystemPromptFor(env, account),
    groundingAllowance: groundingAllowance(env, account),
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
  return last?.type === 'error' ? `error: ${last.message}` : (last?.type ?? 'nothing');
}

describe('Tangent credit, end to end', () => {
  scenario('credit: a reply settles at its reported cost', 'openrouter', async () => {
    const { account, taps, send } = await ready();
    const events = await send('What is a prime number? One sentence.');
    const rows = await usageRows(env, account.billingAccountId);
    const failures = checkRows(rows, taps);
    if (events.at(-1)?.type !== 'done') failures.push(`the reply ended with ${lastEvent(events)}`);
    if (!rows.some((r) => r.purpose === 'reply')) failures.push('no reply row');
    const { balanceMicros, heldMicros } = await getBalance(env.DB, account.billingAccountId);
    const charged = rows.reduce((sum, r) => sum + (r.charge_micros ?? 0), 0);
    if (GRANT_MICROS - balanceMicros !== charged)
      failures.push(
        `the balance fell by ${GRANT_MICROS - balanceMicros} µ$, the rows charged ${charged}`,
      );
    if (heldMicros !== 0) failures.push(`${heldMicros} µ$ still held`);
    const reply = taps.find((t) => t.request.usageTag?.purpose === 'reply');
    return {
      model: reply?.request.model ?? null,
      ...(reply ? { summary: reply.summary } : {}),
      failures,
      warnings: [],
      notes: rows.map((r) => `${r.purpose} ${r.charge_micros} µ$ (hold ${r.hold_micros})`),
    } satisfies Outcome;
  });

  scenario('credit: the second turn reads the prompt cache', 'openrouter', async () => {
    const { account, taps, send } = await ready();
    const before = taps.length;
    const events = await send('Is 91 a prime number? One sentence.');
    const failures = checkRows(await usageRows(env, account.billingAccountId), taps);
    if (events.at(-1)?.type !== 'done') failures.push(`the reply ended with ${lastEvent(events)}`);
    const reply = taps.slice(before).find((t) => t.request.usageTag?.purpose === 'reply');
    const warnings =
      (reply?.summary.usage.cacheReadTokens ?? 0) === 0
        ? ['the second turn read nothing from the prompt cache']
        : [];
    return {
      model: reply?.request.model ?? null,
      ...(reply ? { summary: reply.summary } : {}),
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
