// The open pool end to end on real OpenRouter, through `chatService` exactly as a
// generating pool request builds it (the pool's config of the built-in provider, its
// meter, its pinned model), on a pool of the run's own. What was really sent upstream
// comes from the host (`sentRequests`); what it cost, from OpenRouter's generation
// lookup. The charge is the reported cost plus the fee, within the hold, taken from the
// pool; the token-priced fallback would not have charged less.
import { chargeMicros, costUsdToNanos, type StreamEvent } from '@tangent/shared';
import { describe } from 'vitest';
import { getBalance } from '../../src/billing/ledger.js';
import type { AppEnv, PoolAccount } from '../../src/env.js';
import { replyCeilingMicros, resolvePoolParams, type PoolParams } from '../../src/pool/params.js';
import { poolSettlement } from '../../src/pool/settle-policy.js';
import { chatService } from '../../src/registries.js';
import { newUser, uniq, usageRows, type UsageRow } from '../mocks/billing-helpers.js';
import { fundPool } from '../pool-helpers.js';
import {
  BAD_KEYS,
  env,
  lookUpGeneration,
  reserveBudget,
  scenario,
  sentRequests,
  settleBudget,
  type Outcome,
} from './harness.js';
import { Deferred } from './taps.js';

const POOL_FUNDS_MICROS = 10_000_000;
/** A token-priced settlement may undercut the reported cost by at most this share. */
const TOKENS_FALLBACK_FLOOR = 0.98;

async function poolUser(): Promise<{ account: PoolAccount; params: PoolParams }> {
  const poolId = uniq('pool');
  await fundPool(poolId, POOL_FUNDS_MICROS);
  const userId = await newUser(env);
  const params = { ...(await resolvePoolParams(env, null)), accountId: poolId };
  return {
    params,
    account: {
      id: `u_${userId}`,
      mode: 'simple',
      userId,
      billingAccountId: `u_${userId}`,
      payer: 'pool',
      pool: params,
    },
  };
}

/** One pool send on a new tree, its background work done; budgeted at twice the reply ceiling. */
async function poolSend(
  e: AppEnv,
  account: PoolAccount,
  content: string,
): Promise<{ events: StreamEvent[]; rows: UsageRow[] }> {
  const { pool } = account;
  if (!pool.price) throw new Error(`the pool model ${pool.model} has no price`);
  const ticket = await reserveBudget((2 * replyCeilingMicros(pool, pool.price)) / 1e6);
  const deferred = new Deferred();
  const service = chatService(e, account, { generating: true, defer: deferred.defer });
  const tree = await service.createTree({ title: 'Live pool' });
  const begin = await service.beginSend(tree.branches[0]!.id, content);
  const events: StreamEvent[] = [];
  try {
    for await (const event of service.runGeneration(begin, new AbortController().signal))
      events.push(event);
    await deferred.settle();
  } finally {
    const rows = await usageRows(env, pool.accountId);
    await settleBudget(ticket, rows.reduce((sum, r) => sum + (r.charge_micros ?? 0), 0) / 1e6);
  }
  return { events, rows: await usageRows(env, pool.accountId) };
}

describe('the open pool, end to end', () => {
  scenario('pool: a reply is charged its cost plus the fee', 'openrouter', async () => {
    const { account, params } = await poolUser();
    const price = params.price!;
    await sentRequests();
    const { events, rows } = await poolSend(env, account, 'What is a prime number? One sentence.');
    const sent = await sentRequests();
    const failures: string[] = [];
    const warnings: string[] = [];
    const notes: string[] = [];
    if (events.at(-1)?.type !== 'done')
      failures.push(`the reply ended with ${events.at(-1)?.type}`);

    for (const shape of sent) {
      if (shape.model !== params.model)
        failures.push(`a call went to ${shape.model}, not the pool model ${params.model}`);
      if (shape.tools.length > 0) failures.push(`a call offered tools: ${shape.tools.join(', ')}`);
      if (shape.maxTokens === null || shape.maxTokens > params.maxOutputTokens)
        failures.push(`a call asked for ${shape.maxTokens} tokens, over ${params.maxOutputTokens}`);
    }
    if (sent.length === 0) failures.push('nothing was sent upstream');

    const { balanceMicros } = await getBalance(env.DB, params.accountId);
    let charged = 0;
    for (const row of rows) {
      const label = `${row.purpose} row`;
      charged += row.charge_micros ?? 0;
      if (row.status !== 'settled' || row.settle_reason !== 'cost') {
        failures.push(`${label} is ${row.status} by ${row.settle_reason}`);
        continue;
      }
      if (row.markup_bps !== 0) failures.push(`${label} has a markup of ${row.markup_bps} bps`);
      if (row.fee_bps !== price.feeBps)
        failures.push(`${label} has a fee of ${row.fee_bps} bps, the price says ${price.feeBps}`);
      const charge = chargeMicros(row.cost_nanos ?? 0, 0, row.fee_bps);
      if (row.charge_micros !== charge)
        failures.push(`${label} charged ${row.charge_micros} µ$, its cost and fee make ${charge}`);
      if ((row.charge_micros ?? 0) > row.hold_micros || row.overage_micros > 0)
        failures.push(`${label} ran over its ${row.hold_micros} µ$ hold`);
      if (!row.generation_id) {
        failures.push(`${label} has no generation id`);
        continue;
      }
      const lookup = await lookUpGeneration(row.generation_id);
      if (!lookup.cost) {
        failures.push(`${label}: OpenRouter has no generation ${row.generation_id}`);
        continue;
      }
      const settled = poolSettlement({ dispatched: true, costUsd: lookup.cost.costUsd });
      if (settled.costNanos !== row.cost_nanos)
        failures.push(
          `${label}: settled at ${row.cost_nanos} n$, the generation's cost is ${costUsdToNanos(lookup.cost.costUsd)}`,
        );
      const byTokens = poolSettlement({
        dispatched: true,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        price,
      });
      if (
        byTokens.costNanos !== null &&
        byTokens.costNanos < (row.cost_nanos ?? 0) * TOKENS_FALLBACK_FLOOR
      )
        failures.push(
          `${label}: priced by its tokens it would cost ${byTokens.costNanos} n$, under the reported ${row.cost_nanos}`,
        );
      notes.push(
        `${label}: ${row.charge_micros} µ$ of a ${row.hold_micros} µ$ hold; by tokens ${byTokens.costNanos} n$ against ${row.cost_nanos} n$`,
      );
    }
    if (!rows.some((r) => r.purpose === 'reply')) failures.push('no reply row');
    if (POOL_FUNDS_MICROS - balanceMicros !== charged)
      failures.push(
        `the pool fell by ${POOL_FUNDS_MICROS - balanceMicros} µ$, the rows charged ${charged}`,
      );
    return { model: params.model, failures, warnings, notes } satisfies Outcome;
  });

  scenario('pool: a refused call is released at no charge', 'openrouter', async () => {
    const { account, params } = await poolUser();
    const bad = { ...env, BUILT_IN_API_KEY: BAD_KEYS.openrouter };
    const { events, rows } = await poolSend(bad, account, 'What is a prime number?');
    const failures: string[] = [];
    if (events.at(-1)?.type !== 'error')
      failures.push(`the reply ended with ${events.at(-1)?.type}`);
    for (const row of rows)
      if (row.settle_reason !== 'released' || row.charge_micros !== 0)
        failures.push(
          `${row.purpose} row settled by ${row.settle_reason} at ${row.charge_micros} µ$`,
        );
    if (rows.length === 0) failures.push('no row was reserved');
    const { balanceMicros, heldMicros } = await getBalance(env.DB, params.accountId);
    if (balanceMicros !== POOL_FUNDS_MICROS || heldMicros !== 0)
      failures.push(`the pool holds ${heldMicros} µ$ and has ${balanceMicros} µ$ left`);
    return { model: params.model, failures, warnings: [] } satisfies Outcome;
  });
});
