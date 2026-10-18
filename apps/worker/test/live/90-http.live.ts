// One Learn reply per funding through the whole Worker: a signed-in browser's request,
// the gate, the tree's Durable Object, its reservation, the meter and settlement, on
// real OpenRouter. The other files check the parts; these check they are wired up.
import type { MeResponse, Payer, StreamEvent, TreeDetail } from '@tangent/shared';
import { describe } from 'vitest';
import { getBalance, grantCredit } from '../../src/billing/ledger.js';
import { usageRows, type UsageRow } from '../mocks/billing-helpers.js';
import { poolReadyUser } from '../pool-helpers.js';
import { authEnv, client } from '../session-client.js';
import { parseSse } from '../http.js';
import { env, reserveBudget, scenario, settleBudget, type Outcome } from './harness.js';

const GRANT_MICROS = 1_000_000;
/** What one smoke may spend: a reply, its title and a summary on Normal. */
const SMOKE_WORST_USD = 0.05;
const SETTLE_WAIT_MS = 90_000;

type Client = ReturnType<typeof client>;

/** A tree and one reply on it, as Learn sends them with `payer`. */
async function reply(c: Client, payer: Payer): Promise<StreamEvent[]> {
  const res = await c.call('/api/trees', { method: 'POST', json: { title: 'Live' }, learn: payer });
  if (res.status !== 201)
    throw new Error(`creating a tree: HTTP ${res.status} ${await res.text()}`);
  const tree = (await res.json()) as TreeDetail;
  const sent = await c.call(`/api/branches/${tree.branches[0]!.id}/messages`, {
    method: 'POST',
    json: { content: 'What is a prime number? One sentence.' },
    learn: payer,
  });
  if (sent.status !== 200) throw new Error(`sending: HTTP ${sent.status} ${await sent.text()}`);
  return parseSse(await sent.text());
}

/** `accountId`'s rows once none is pending (background settles finish after the response). */
async function settledRows(accountId: string): Promise<UsageRow[]> {
  const until = Date.now() + SETTLE_WAIT_MS;
  for (;;) {
    const rows = await usageRows(env, accountId);
    if (!rows.some((r) => r.status === 'pending') || Date.now() > until) return rows;
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

/** The smoke's checks on its events and rows; the account's balance fell by the charges. */
async function check(
  events: StreamEvent[],
  payer: Payer,
  rows: UsageRow[],
  accountId: string,
  funded: number,
): Promise<Outcome> {
  const failures: string[] = [];
  const start = events[0];
  const last = events.at(-1);
  if (start?.type !== 'start' || start.funding !== payer)
    failures.push(`the reply did not start on ${payer}`);
  if (last?.type !== 'done')
    failures.push(`the reply ended with ${last?.type === 'error' ? last.message : last?.type}`);
  const charged = rows.reduce((sum, r) => sum + (r.charge_micros ?? 0), 0);
  for (const row of rows) {
    if (row.status !== 'settled' || row.settle_reason !== 'cost')
      failures.push(`${row.purpose} row is ${row.status} by ${row.settle_reason}`);
    if ((row.charge_micros ?? 0) > row.hold_micros)
      failures.push(
        `${row.purpose} row charged ${row.charge_micros} µ$ over its ${row.hold_micros} µ$ hold`,
      );
  }
  if (!rows.some((r) => r.purpose === 'reply')) failures.push('no reply row');
  const { balanceMicros, heldMicros } = await getBalance(env.DB, accountId);
  if (funded - balanceMicros !== charged)
    failures.push(`the balance fell by ${funded - balanceMicros} µ$, the rows charged ${charged}`);
  if (heldMicros !== 0) failures.push(`${heldMicros} µ$ still held`);
  return {
    model: start?.type === 'start' ? start.assistantNode.model : null,
    failures,
    warnings: [],
    notes: rows.map((r) => `${r.purpose} ${r.charge_micros} µ$ (hold ${r.hold_micros})`),
  };
}

describe('through the Worker', () => {
  scenario('http: Learn on Tangent credit', 'openrouter', async () => {
    const ticket = await reserveBudget(SMOKE_WORST_USD);
    let charged = 0;
    try {
      const c = client(authEnv());
      await c.signIn(`live-credit-${Date.now()}@example.org`);
      const me = (await (await c.call('/api/me')).json()) as MeResponse;
      const accountId = `u_${me.userId}`;
      await grantCredit(env.DB, {
        accountId,
        kind: 'adjustment',
        amountMicros: GRANT_MICROS,
        providerRef: null,
      });
      const events = await reply(c, 'credit');
      const rows = await settledRows(accountId);
      charged = rows.reduce((sum, r) => sum + (r.charge_micros ?? 0), 0);
      return await check(events, 'credit', rows, accountId, GRANT_MICROS);
    } finally {
      await settleBudget(ticket, charged / 1e6);
    }
  });

  scenario('http: Learn on the open pool', 'openrouter', async () => {
    const ticket = await reserveBudget(SMOKE_WORST_USD);
    let charged = 0;
    try {
      const funds = 10_000_000;
      const u = await poolReadyUser({ funds });
      const events = await reply(u.client, 'pool');
      const rows = await settledRows(u.poolId);
      charged = rows.reduce((sum, r) => sum + (r.charge_micros ?? 0), 0);
      return await check(events, 'pool', rows, u.poolId, funds);
    } finally {
      await settleBudget(ticket, charged / 1e6);
    }
  });
});
