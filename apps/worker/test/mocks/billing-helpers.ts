// Test-side helpers for the billing tests (imported by test files, which run
// in workerd; not by vitest.config.ts). Ids are unique per call, so files and
// tests sharing a D1 database or the Node-side mocks never collide.
import type { AppEnv, AccountContext } from '../../src/env.js';
import type { MockPaymentIntent, MockStripeCall } from './stripe.js';
import type { ScriptedGeneration } from './openrouter.js';

let seq = 0;
export function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq}_${Math.random().toString(36).slice(2, 10)}`;
}

/** A simple (Learn) account `u_<userId>` on credit (the built-in provider), with a fresh user id. */
export function simpleAccount(userId = uniq('user')): AccountContext {
  const id = `u_${userId}`;
  return {
    id,
    mode: 'simple',
    userId,
    billingAccountId: id,
    builtIn: true,
    operatorKeys: false,
    funding: 'personal',
  };
}

/** The same user's power account `p_<userId>`, on the same ledger, with the built-in provider. */
export function powerAccount(userId = uniq('user')): AccountContext {
  return {
    id: `p_${userId}`,
    mode: 'power',
    userId,
    billingAccountId: `u_${userId}`,
    builtIn: true,
    operatorKeys: false,
    funding: 'personal',
  };
}

/** The dev bypass's power account (`default`, ledger `default_simple`), server keys allowed. */
export function devPowerAccount(overrides: Partial<AccountContext> = {}): AccountContext {
  return {
    id: 'default',
    mode: 'power',
    userId: null,
    billingAccountId: 'default_simple',
    builtIn: true,
    operatorKeys: true,
    funding: 'personal',
    ...overrides,
  };
}

export async function insertUser(
  env: AppEnv,
  user: { id: string; email?: string; name?: string; stripeCustomerId?: string | null },
): Promise<{ id: string; email: string; name: string }> {
  const email = user.email ?? `${user.id}@example.com`;
  const name = user.name ?? 'Test User';
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO auth_users (id, name, email, email_verified, created_at, updated_at, stripe_customer_id)
     VALUES (?, ?, ?, 1, ?, ?, ?)`,
  )
    .bind(user.id, name, email, now, now, user.stripeCustomerId ?? null)
    .run();
  return { id: user.id, email, name };
}

/** A Better Auth Stripe plugin subscription row (plan `membership` unless given); returns its id. */
export async function insertSubscription(
  env: AppEnv,
  userId: string,
  status: string,
  extra: {
    plan?: string;
    periodEnd?: number | null;
    cancelAtPeriodEnd?: boolean;
    stripeSubscriptionId?: string | null;
  } = {},
): Promise<string> {
  const id = uniq('sub');
  await env.DB.prepare(
    `INSERT INTO auth_subscriptions
       (id, plan, reference_id, status, period_end, cancel_at_period_end, stripe_subscription_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      extra.plan ?? 'membership',
      userId,
      status,
      extra.periodEnd ?? null,
      extra.cancelAtPeriodEnd ? 1 : 0,
      extra.stripeSubscriptionId ?? null,
    )
    .run();
  return id;
}

export interface UsageRowInput {
  accountId: string;
  status?: 'pending' | 'settled' | 'unresolved';
  createdAt?: string;
  generationId?: string | null;
  holdMicros?: number;
  markupBps?: number;
  feeBps?: number;
  chargeMicros?: number | null;
  purpose?: string;
  model?: string;
  treeId?: string | null;
}

export async function insertUsage(env: AppEnv, row: UsageRowInput): Promise<string> {
  const id = uniq('use');
  await env.DB.prepare(
    `INSERT INTO usage_events (id, account_id, tree_id, purpose, provider_id, model, generation_id, status,
       hold_micros, markup_bps, fee_bps, charge_micros, created_at)
     VALUES (?, ?, ?, ?, 'tangent', ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      row.accountId,
      row.treeId ?? null,
      row.purpose ?? 'reply',
      row.model ?? 'smart',
      row.generationId ?? null,
      row.status ?? 'pending',
      row.holdMicros ?? 20_000,
      row.markupBps ?? 1000,
      row.feeBps ?? 550,
      row.chargeMicros ?? null,
      row.createdAt ?? new Date().toISOString(),
    )
    .run();
  return id;
}

export interface UsageRow {
  id: string;
  account_id: string;
  tree_id: string | null;
  node_id: string | null;
  purpose: string;
  provider_id: string;
  model: string;
  generation_id: string | null;
  status: string;
  hold_micros: number;
  markup_bps: number;
  fee_bps: number;
  cost_nanos: number | null;
  charge_micros: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
  settled_at: string | null;
  branch_id: string | null;
  user_id: string | null;
  funding: 'personal' | 'pool';
  ip_key: string | null;
  tier: 'free' | 'supporter' | null;
  overage_micros: number;
  settle_reason: string | null;
  dispatched_at: string | null;
}

export async function usageRows(env: AppEnv, accountId: string): Promise<UsageRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM usage_events WHERE account_id = ? ORDER BY created_at, id',
  )
    .bind(accountId)
    .all<UsageRow>();
  return results;
}

export async function usageRow(env: AppEnv, id: string): Promise<UsageRow> {
  const row = await env.DB.prepare('SELECT * FROM usage_events WHERE id = ?')
    .bind(id)
    .first<UsageRow>();
  if (!row) throw new Error(`no usage row ${id}`);
  return row;
}

export async function grantsFor(
  env: AppEnv,
  accountId: string,
): Promise<{ kind: string; amount_micros: number; stripe_ref: string | null }[]> {
  const { results } = await env.DB.prepare(
    'SELECT kind, amount_micros, stripe_ref FROM credit_grants WHERE account_id = ? ORDER BY created_at, id',
  )
    .bind(accountId)
    .all<{ kind: string; amount_micros: number; stripe_ref: string | null }>();
  return results;
}

/** Grants with their gross amount and processing fee. */
export async function grantDetailsFor(
  env: AppEnv,
  accountId: string,
): Promise<
  {
    kind: string;
    amount_micros: number;
    gross_micros: number | null;
    fee_micros: number;
    stripe_ref: string | null;
  }[]
> {
  const { results } = await env.DB.prepare(
    `SELECT kind, amount_micros, gross_micros, fee_micros, stripe_ref FROM credit_grants
     WHERE account_id = ? ORDER BY created_at, id`,
  )
    .bind(accountId)
    .all<{
      kind: string;
      amount_micros: number;
      gross_micros: number | null;
      fee_micros: number;
      stripe_ref: string | null;
    }>();
  return results;
}

/**
 * An env whose D1 fails every statement matching `failing` (e.g. /^\s*UPDATE/),
 * to exercise the error paths. Everything else goes to the real database.
 */
export function envWithFailingDb(env: AppEnv, failing: RegExp): AppEnv {
  const db = env.DB;
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (failing.test(sql)) throw new Error('D1_ERROR: simulated failure');
          return target.prepare(sql);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { ...env, DB: proxy } as AppEnv;
}

// ---- Node-side mocks, driven over fetch (vitest.config.ts outboundService)

export async function stripeCalls(path?: string): Promise<MockStripeCall[]> {
  const res = await fetch(
    `https://api.stripe.com/__mock/calls${path ? `?path=${encodeURIComponent(path)}` : ''}`,
  );
  return (await res.json()) as MockStripeCall[];
}

export async function stripeFixtures(objects: {
  checkoutSessions?: Record<string, unknown>[];
  refunds?: Record<string, unknown>[];
  paymentIntents?: MockPaymentIntent[];
  invoicePayments?: Record<string, unknown>[];
}): Promise<void> {
  const res = await fetch('https://api.stripe.com/__mock/objects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(objects),
  });
  if (!res.ok) throw new Error(`stripe mock: ${res.status}`);
}

export async function scriptGeneration(id: string, responses: ScriptedGeneration[]): Promise<void> {
  const res = await fetch('https://openrouter.ai/__mock/generation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, responses }),
  });
  if (!res.ok) throw new Error(`openrouter mock: ${res.status}`);
}

export async function generationCalls(
  id: string,
): Promise<{ count: number; authorizations: string[] }> {
  const res = await fetch(
    `https://openrouter.ai/__mock/generation-calls?id=${encodeURIComponent(id)}`,
  );
  return (await res.json()) as { count: number; authorizations: string[] };
}
