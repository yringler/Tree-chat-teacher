// Abuse controls of the open pool: daily caps (the
// same for everyone), per-minute rate limits per user and per network, the
// per-network and global daily ceilings, the account gates (suspension,
// Turnstile, one identity per mailbox, account age), the consumption report,
// and the absence of an OpenAI-compatible endpoint. HTTP end to end, each
// test on a pool of its own (`poolReadyUser`).
import type {
  AdminPoolUsageResponse,
  AdminUser,
  ApiError,
  Payer,
  PoolBlockDetails,
  PoolMeResponse,
  StreamEvent,
  TreeDetail,
} from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { sweepDeletedUsers } from '../src/auth/delete-account.js';
import { getBalance } from '../src/billing/ledger.js';
import { CRON_JOBS } from '../src/cron.js';
import type { SqlRow } from '../src/db/rows.js';
import type { poolIdentities } from '../src/db/schema.js';
import type { AppEnv } from '../src/env.js';
import {
  normaliseEmail,
  POOL_IDENTITY_RETENTION_DAYS,
  poolIdentity,
  purgeReleasedPoolIdentities,
} from '../src/pool/identity.js';
import { poolBank } from '../src/pool/ids.js';
import { POOL_GIVE_UP_MS, replyCeilingMicros, resolvePoolParams } from '../src/pool/params.js';
import { insertSubscription, uniq } from './mocks/billing-helpers.js';
import { failRateChecks, poolAccess, poolReadyUser, rateKeys } from './pool-helpers.js';
import { authEnv, client, type CallInit } from './session-client.js';
import { ok, parseSse } from './http.js';

const env = rawEnv as unknown as AppEnv;
const ECHO = '[echo-request]';
const PARAMS = await resolvePoolParams(env, null);
const PRICE = PARAMS.price!;
/** The reply's ceiling hold on a test pool. */
const CEILING = replyCeilingMicros(PARAMS, PRICE);
/** POOL_REQUESTS_PER_DAY in vitest.config.ts. */
const DAILY_REPLIES = 3;

type User = Awaited<ReturnType<typeof poolReadyUser>>;

let netSeq = 0;
/** An IPv4 address no other test uses. */
function freshIp(): string {
  return `10.${Math.floor(Math.random() * 250)}.${++netSeq % 250}.7`;
}

/** The next 00:00 UTC, ISO. */
function nextUtcMidnight(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
}

/**
 * Rate limits count per fixed UTC minute: a test that must stay inside one
 * minute waits out the last seconds of the current one first (hence the
 * longer timeout of the tests that call it).
 */
async function freshMinute(): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 20_000) await new Promise((r) => setTimeout(r, left + 50));
}

async function newTree(u: User, learn: Payer = 'pool') {
  const detail = await ok<TreeDetail>(
    await u.client.call('/api/trees', { method: 'POST', json: { title: 'T' }, learn }),
    201,
  );
  return { treeId: detail.tree.id, branchId: detail.branches[0]!.id };
}

function send(u: User, branchId: string, content = 'Hi', init: CallInit = {}) {
  return u.client.call(`/api/branches/${branchId}/messages`, {
    method: 'POST',
    json: { content },
    learn: 'pool',
    ...init,
  });
}

/** A pool send that must succeed; returns the streamed events. */
async function sendOk(u: User, branchId: string, content = 'Hi'): Promise<StreamEvent[]> {
  const res = await send(u, branchId, content);
  const text = await res.text();
  expect(res.status, text).toBe(200);
  const events = parseSse(text);
  expect(events.at(-1)?.type).toBe('done');
  return events;
}

/** A refused pool request: its status, code and `error.pool`. */
async function refused(res: Response, status: number, code: string): Promise<PoolBlockDetails> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  const error = (JSON.parse(text) as ApiError).error;
  expect(error.code).toBe(code);
  return error.pool!;
}

async function nodeCount(u: User, treeId: string): Promise<number> {
  const detail = await ok<TreeDetail>(
    await u.client.call(`/api/trees/${treeId}`, { learn: 'pool' }),
  );
  return detail.nodes.length;
}

/** A purchase by `userId` (personal unless `accountId` says the pool), `grossMicros` pre-tax. */
async function purchase(
  userId: string,
  opts: { grossMicros?: number; accountId?: string; createdAt?: string } = {},
): Promise<void> {
  const gross = opts.grossMicros ?? 5_000_000;
  await env.DB.prepare(
    `INSERT INTO credit_grants (id, account_id, kind, amount_micros, gross_micros, user_id, provider_ref, created_at)
     VALUES (?, ?, 'purchase', ?, ?, ?, ?, ?)`,
  )
    .bind(
      uniq('grant'),
      opts.accountId ?? `u_${userId}`,
      gross,
      gross,
      userId,
      uniq('cs'),
      opts.createdAt ?? new Date().toISOString(),
    )
    .run();
}

describe('daily caps', () => {
  it('a learner stops at POOL_REQUESTS_PER_DAY: 429 `pool_cap_reached`, reset at 00:00 UTC', async () => {
    const u = await poolReadyUser();
    const { treeId, branchId } = await newTree(u);
    for (let i = 0; i < DAILY_REPLIES; i++) await sendOk(u, branchId, `Q${i}`);
    const pool = await refused(await send(u, branchId, 'One more'), 429, 'pool_cap_reached');
    expect(pool).toEqual({
      reason: 'cap_requests',
      limit: DAILY_REPLIES,
      resetAt: nextUtcMidnight(),
    });
    expect(await nodeCount(u, treeId)).toBe(2 * DAILY_REPLIES);
  });

  it('the daily spend cap counts settled charges and pending holds', async () => {
    // Room for one reply's ceiling hold; the reply's charge then leaves less than another.
    const u = await poolReadyUser({
      env: { POOL_SPEND_MICROS_PER_DAY: String(CEILING + 1_000) },
    });
    const { branchId } = await newTree(u);
    await sendOk(u, branchId);
    const pool = await refused(await send(u, branchId, 'Again'), 429, 'pool_cap_reached');
    expect(pool).toMatchObject({
      reason: 'cap_spend',
      limit: CEILING + 1_000,
      resetAt: nextUtcMidnight(),
    });
  });
});

describe('the same caps for everyone', () => {
  const FEE = { ANNUAL_FEE_ENABLED: 'true' };

  /** Uses up `u`'s replies for the day, then returns the refusal of one more. */
  async function capped(u: User): Promise<PoolBlockDetails> {
    const { branchId } = await newTree(u);
    for (let i = 0; i < DAILY_REPLIES; i++) await sendOk(u, branchId, `Q${i}`);
    return refused(await send(u, branchId), 429, 'pool_cap_reached');
  }

  it('a member gets exactly the caps a non-member gets', async () => {
    const member = await poolReadyUser({ env: FEE });
    await insertSubscription(env, member.userId, 'active');
    const other = await poolReadyUser({ env: FEE, poolId: member.poolId });
    const expected = { reason: 'cap_requests', limit: DAILY_REPLIES, resetAt: nextUtcMidnight() };
    expect(await capped(member)).toEqual(expected);
    expect(await capped(other)).toEqual(expected);
    // /api/pool/me says the same.
    const caps = async (u: User) =>
      (await ok<PoolMeResponse>(await u.client.call('/api/pool/me', { learn: 'pool' }))).caps;
    expect(await caps(member)).toEqual(await caps(other));
  });

  it('a credit buyer keeps the same caps', async () => {
    const u = await poolReadyUser({ env: FEE });
    const { branchId } = await newTree(u);
    for (let i = 0; i < DAILY_REPLIES; i++) await sendOk(u, branchId, `Q${i}`);
    await purchase(u.userId, { grossMicros: 10_000_000, accountId: u.poolId });
    expect(await refused(await send(u, branchId), 429, 'pool_cap_reached')).toEqual({
      reason: 'cap_requests',
      limit: DAILY_REPLIES,
      resetAt: nextUtcMidnight(),
    });
  });
});

describe('rate limits', { timeout: 40_000 }, () => {
  it('per user per minute: 429 `rate` with the next minute as the reset', async () => {
    await freshMinute();
    const u = await poolReadyUser({ env: { POOL_USER_PER_MINUTE: '2' } });
    const { treeId, branchId } = await newTree(u);
    await sendOk(u, branchId, 'One');
    await sendOk(u, branchId, 'Two');
    const pool = await refused(await send(u, branchId, 'Three'), 429, 'pool_cap_reached');
    expect(pool).toMatchObject({ reason: 'rate', limit: 2 });
    const reset = Date.parse(pool.resetAt!);
    expect(reset % 60_000).toBe(0);
    expect(reset - Date.now()).toBeLessThanOrEqual(60_000);
    expect(await nodeCount(u, treeId)).toBe(4);
  });

  it('per network: two users on one IPv4 address share a bucket', async () => {
    await freshMinute();
    const ip = freshIp();
    const limits = { POOL_IP_PER_MINUTE: '2' };
    const a = await poolReadyUser({ ip, env: limits });
    const b = await poolReadyUser({ ip, env: limits, poolId: a.poolId });
    const c = await poolReadyUser({ ip: freshIp(), env: limits, poolId: a.poolId });
    await sendOk(a, (await newTree(a)).branchId);
    const bTree = await newTree(b);
    await sendOk(b, bTree.branchId);
    expect(await refused(await send(b, bTree.branchId), 429, 'pool_cap_reached')).toMatchObject({
      reason: 'rate',
      limit: 2,
    });
    // Another network is untouched.
    await sendOk(c, (await newTree(c)).branchId);
  });

  it('IPv6: one /64 is one bucket; another /64 is independent', async () => {
    await freshMinute();
    const net = (++netSeq).toString(16);
    const limits = { POOL_IP_PER_MINUTE: '1' };
    const a = await poolReadyUser({ ip: `2001:db8:${net}:1::1`, env: limits });
    const b = await poolReadyUser({
      ip: `2001:db8:${net}:1:ffff:ffff:ffff:fffe`,
      env: limits,
      poolId: a.poolId,
    });
    const c = await poolReadyUser({ ip: `2001:db8:${net}:2::1`, env: limits, poolId: a.poolId });
    await sendOk(a, (await newTree(a)).branchId);
    expect(
      await refused(await send(b, (await newTree(b)).branchId), 429, 'pool_cap_reached'),
    ).toMatchObject({ reason: 'rate', limit: 1 });
    await sendOk(c, (await newTree(c)).branchId);
  });

  it('fails closed: a PoolBank storage error refuses, with nothing written', async () => {
    const u = await poolReadyUser();
    const { treeId, branchId } = await newTree(u);
    await failRateChecks(poolBank(env, u.poolId), 1);
    const pool = await refused(await send(u, branchId), 429, 'pool_cap_reached');
    expect(pool.reason).toBe('rate');
    expect(await nodeCount(u, treeId)).toBe(0);
    await sendOk(u, branchId);
  });

  it('a context resolve on the pool counts too (PoolBank.admit)', async () => {
    await freshMinute();
    const u = await poolReadyUser({ env: { POOL_USER_PER_MINUTE: '1' } });
    const { branchId } = await newTree(u);
    const resolve = () =>
      u.client.call(`/api/branches/${branchId}/context?resolve=true`, { learn: 'pool' });
    expect((await resolve()).status).toBe(200);
    expect(await refused(await resolve(), 429, 'pool_cap_reached')).toMatchObject({
      reason: 'rate',
      limit: 1,
    });
    expect(await refused(await send(u, branchId), 429, 'pool_cap_reached')).toMatchObject({
      reason: 'rate',
    });
  });
});

describe('daily ceilings beyond the user', () => {
  it('per network: POOL_IP_REQUESTS_PER_DAY across users refuses with `cap_ip`', async () => {
    const ip = freshIp();
    const caps = { POOL_IP_REQUESTS_PER_DAY: '2' };
    const a = await poolReadyUser({ ip, env: caps });
    const b = await poolReadyUser({ ip, env: caps, poolId: a.poolId });
    const aTree = await newTree(a);
    await sendOk(a, aTree.branchId, 'One');
    await sendOk(a, aTree.branchId, 'Two');
    expect(
      await refused(await send(b, (await newTree(b)).branchId), 429, 'pool_cap_reached'),
    ).toMatchObject({ reason: 'cap_ip', limit: 2, resetAt: nextUtcMidnight() });
  });

  it('the global ceiling refuses with `cap_global`, members included', async () => {
    const caps = {
      POOL_DAILY_GLOBAL_MICROS: String(CEILING + 100),
      ANNUAL_FEE_ENABLED: 'true',
    };
    const a = await poolReadyUser({ env: caps });
    const b = await poolReadyUser({ env: caps, poolId: a.poolId });
    const s = await poolReadyUser({ env: caps, poolId: a.poolId });
    await insertSubscription(env, s.userId, 'active');
    await sendOk(a, (await newTree(a)).branchId);
    for (const u of [b, s])
      expect(
        await refused(await send(u, (await newTree(u)).branchId), 429, 'pool_cap_reached'),
      ).toEqual({ reason: 'cap_global', limit: CEILING + 100, resetAt: nextUtcMidnight() });
  });
});

describe('account gates', () => {
  it('a suspended user is refused (403 `suspended`) until an admin lifts it', async () => {
    const u = await poolReadyUser();
    const admin = await poolReadyUser({ poolId: u.poolId });
    const asAdmin = (path: string, init: CallInit = {}) =>
      admin.client.call(
        path,
        init,
        authEnv({ TEST_POOL_ACCOUNT_ID: u.poolId, ADMIN_USER_IDS: admin.userId }),
      );
    const { treeId, branchId } = await newTree(u);

    const suspended = await ok<AdminUser>(
      await asAdmin(`/api/admin/users/${u.userId}`, {
        method: 'PATCH',
        json: { poolSuspended: true },
      }),
    );
    expect(suspended).toMatchObject({ id: u.userId, poolSuspended: true, shareAllowed: false });
    expect(await refused(await send(u, branchId), 403, 'pool_unavailable')).toEqual({
      reason: 'suspended',
      limit: null,
      resetAt: null,
    });
    expect(await nodeCount(u, treeId)).toBe(0);
    // Only the pool is off: the same user still has their trees and other funding.
    expect((await u.client.call(`/api/trees/${treeId}`, { learn: 'pool' })).status).toBe(200);

    // Changing the share permission leaves the suspension alone.
    await ok<AdminUser>(
      await asAdmin(`/api/admin/users/${u.userId}`, {
        method: 'PATCH',
        json: { shareAllowed: true },
      }),
    );
    expect((await poolAccess(u.userId))?.pool_suspended).toBe(1);

    await ok<AdminUser>(
      await asAdmin(`/api/admin/users/${u.userId}`, {
        method: 'PATCH',
        json: { poolSuspended: false },
      }),
    );
    await sendOk(u, branchId);

    // Not an admin: 404, and nothing changes. An empty update is a 400.
    const notAdmin = await u.client.call(`/api/admin/users/${u.userId}`, {
      method: 'PATCH',
      json: { poolSuspended: false },
    });
    expect(notAdmin.status).toBe(404);
    expect(
      (await asAdmin(`/api/admin/users/${u.userId}`, { method: 'PATCH', json: {} })).status,
    ).toBe(400);
  });

  it('no Turnstile pass on record: 403 `verify`, until POST /api/pool/verify passes', async () => {
    const u = await poolReadyUser({ verified: false });
    const { treeId, branchId } = await newTree(u);
    expect((await refused(await send(u, branchId), 403, 'pool_unavailable')).reason).toBe('verify');
    expect(await nodeCount(u, treeId)).toBe(0);

    const verify = (token: string) =>
      u.client.call('/api/pool/verify', { method: 'POST', json: { token }, learn: 'pool' });
    expect((await verify('not-a-pass')).status).toBe(400);
    expect((await poolAccess(u.userId))?.pool_verified_at).toBeNull();
    expect(await ok<unknown>(await verify('pass'))).toEqual({ verified: true });
    const access = await poolAccess(u.userId);
    expect(access?.pool_verified_at).toBeTruthy();
    expect(access?.pool_identity).toMatch(/^[0-9a-f]{64}$/);
    await sendOk(u, branchId);
    // Cross-site and malformed requests are refused.
    const cross = await u.client.call('/api/pool/verify', {
      method: 'POST',
      json: { token: 'pass' },
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(cross.status).toBe(403);
    expect((await u.client.call('/api/pool/verify', { method: 'POST', json: {} })).status).toBe(
      400,
    );
  });

  it('fails closed without TURNSTILE_SECRET_KEY', async () => {
    const u = await poolReadyUser({ verified: false });
    const res = await u.client.call(
      '/api/pool/verify',
      { method: 'POST', json: { token: 'pass' } },
      authEnv({ TEST_POOL_ACCOUNT_ID: u.poolId, TURNSTILE_SECRET_KEY: '' }),
    );
    expect(res.status).toBe(400);
    expect((await poolAccess(u.userId))?.pool_verified_at).toBeNull();
  });

  it('one pool identity per mailbox: a Gmail alias of a pool user is refused', async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const first = await poolReadyUser({ email: `ab${tag}@gmail.com` });
    const alias = await poolReadyUser({
      email: `a.b${tag}+pool@googlemail.com`,
      poolId: first.poolId,
    });
    expect(await poolIdentity(`a.b${tag}+pool@googlemail.com`)).toBe(
      (await poolAccess(first.userId))?.pool_identity,
    );
    // Signed in (the Turnstile pass is kept), but the identity stays with the first account.
    expect((await poolAccess(alias.userId))?.pool_identity).toBeNull();
    const { branchId } = await newTree(alias);
    expect((await refused(await send(alias, branchId), 403, 'pool_unavailable')).reason).toBe(
      'duplicate_identity',
    );
    const verify = await alias.client.call('/api/pool/verify', {
      method: 'POST',
      json: { token: 'pass' },
    });
    expect((await refused(verify, 403, 'pool_unavailable')).reason).toBe('duplicate_identity');
    // The first account is unaffected.
    await sendOk(first, (await newTree(first)).branchId);
  });

  it('deleting a suspended account and signing up again keeps the mailbox suspended', async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const first = await poolReadyUser({ email: `ab${tag}@gmail.com` });
    // Suspended before any Turnstile pass, so before the identity was claimed.
    const unverified = await poolReadyUser({
      email: `cd${tag}@example.org`,
      poolId: first.poolId,
      verified: false,
    });
    const admin = await poolReadyUser({ poolId: first.poolId });
    const asAdmin = (path: string, init: CallInit = {}) =>
      admin.client.call(
        path,
        init,
        authEnv({ TEST_POOL_ACCOUNT_ID: first.poolId, ADMIN_USER_IDS: admin.userId }),
      );
    for (const [u, email] of [
      [first, `ab${tag}@gmail.com`],
      [unverified, `cd${tag}@example.org`],
    ] as const) {
      await ok<AdminUser>(
        await asAdmin(`/api/admin/users/${u.userId}`, {
          method: 'PATCH',
          json: { poolSuspended: true },
        }),
      );
      const deleted = await u.client.call('/api/account', {
        method: 'DELETE',
        json: { confirmEmail: email },
      });
      expect(deleted.status).toBe(204);
    }

    // The same mailboxes, on new accounts from other networks: the suspension holds.
    const again = await poolReadyUser({
      email: `a.b${tag}+again@googlemail.com`,
      poolId: first.poolId,
      ip: freshIp(),
    });
    const againToo = await poolReadyUser({
      email: `cd${tag}@example.org`,
      poolId: first.poolId,
      ip: freshIp(),
    });
    expect(again.userId).not.toBe(first.userId);
    for (const u of [again, againToo]) {
      const { treeId, branchId } = await newTree(u);
      expect((await refused(await send(u, branchId), 403, 'pool_unavailable')).reason).toBe(
        'suspended',
      );
      expect(await nodeCount(u, treeId)).toBe(0);
    }
    // The admin page shows it on the new account.
    const shown = await ok<AdminUser>(
      await asAdmin(`/api/admin/users/${again.userId}`, {
        method: 'PATCH',
        json: { shareAllowed: false },
      }),
    );
    expect(shown.poolSuspended).toBe(true);

    // An admin can lift it for the new account.
    await ok<AdminUser>(
      await asAdmin(`/api/admin/users/${again.userId}`, {
        method: 'PATCH',
        json: { poolSuspended: false },
      }),
    );
    await sendOk(again, (await newTree(again)).branchId);
  });

  it("deleting the account and signing up again doesn't reset the day's caps", async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const first = await poolReadyUser({ email: `ab${tag}@gmail.com`, ip: freshIp() });
    const { branchId } = await newTree(first);
    for (let i = 0; i < DAILY_REPLIES; i++) await sendOk(first, branchId, `Q${i}`);
    const deleted = await first.client.call('/api/account', {
      method: 'DELETE',
      json: { confirmEmail: `ab${tag}@gmail.com` },
    });
    expect(deleted.status).toBe(204);

    const again = await poolReadyUser({
      email: `a.b${tag}@gmail.com`,
      poolId: first.poolId,
      ip: freshIp(),
    });
    expect(
      await refused(await send(again, (await newTree(again)).branchId), 429, 'pool_cap_reached'),
    ).toMatchObject({ reason: 'cap_requests', limit: DAILY_REPLIES, resetAt: nextUtcMidnight() });
    // Another mailbox on the same pool is unaffected.
    const other = await poolReadyUser({ poolId: first.poolId, ip: freshIp() });
    await sendOk(other, (await newTree(other)).branchId);
  });

  it('normalises mailboxes: case, +tags, and Gmail dots and domains', () => {
    expect(normaliseEmail(' A.B+x@Gmail.com ')).toBe('ab@gmail.com');
    expect(normaliseEmail('a.b@googlemail.com')).toBe('ab@gmail.com');
    expect(normaliseEmail('First.Last+news@Example.org')).toBe('first.last@example.org');
    expect(normaliseEmail('+only@example.org')).toBe('+only@example.org');
    expect(normaliseEmail('not-an-email')).toBe('not-an-email');
  });

  it('an account newer than POOL_MIN_ACCOUNT_AGE_MS is refused (`too_new`)', async () => {
    const u = await poolReadyUser({ env: { POOL_MIN_ACCOUNT_AGE_MS: String(60 * 60_000) } });
    const { branchId } = await newTree(u);
    expect((await refused(await send(u, branchId), 403, 'pool_unavailable')).reason).toBe(
      'too_new',
    );
  });

  it('the dev bypass (no signed-in user) never reaches the pool', async () => {
    const dev = client(env);
    const created = await ok<TreeDetail>(
      await dev.call('/api/trees', { method: 'POST', json: { title: 'T' }, learn: 'pool' }),
      201,
    );
    const res = await dev.call(`/api/branches/${created.branches[0]!.id}/messages`, {
      method: 'POST',
      json: { content: 'Hi' },
      learn: 'pool',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ApiError).error.code).toBe('pool_unavailable');
  });
});

describe('account deletion', () => {
  /** What a deletion must keep of the pool's rows: everything but who and from where. */
  const LEDGER_COLUMNS =
    'id, status, hold_micros, charge_micros, cost_nanos, overage_micros, model, input_tokens, output_tokens, created_at';

  async function poolRows(poolId: string) {
    const { results } = await env.DB.prepare(
      `SELECT ${LEDGER_COLUMNS}, user_id, ip_key FROM usage_events WHERE account_id = ? ORDER BY id`,
    )
      .bind(poolId)
      .all<Record<string, unknown>>();
    return results;
  }

  /** The pool's rows once none is pending (a reply settles after its stream ends). */
  async function settledRows(poolId: string) {
    for (let i = 0; i < 50; i++) {
      const rows = await poolRows(poolId);
      if (rows.every((r) => r.status !== 'pending')) return rows;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('pool rows still pending');
  }

  async function dayTotal(poolId: string): Promise<number> {
    const day = new Date(nextUtcMidnight()).getTime() - 86_400_000;
    const row = await env.DB.prepare(
      `SELECT COALESCE(SUM(CASE WHEN status = 'pending' THEN hold_micros ELSE COALESCE(charge_micros, 0) END), 0) AS spend
       FROM usage_events WHERE account_id = ? AND created_at >= ?`,
    )
      .bind(poolId, new Date(day).toISOString())
      .first<{ spend: number }>();
    return Number(row?.spend ?? 0);
  }

  async function identityRow(identity: string) {
    return env.DB.prepare(
      'SELECT suspended, deleted_at, deleted_day_requests FROM pool_identities WHERE identity = ?',
    )
      .bind(identity)
      .first<
        Pick<SqlRow<typeof poolIdentities>, 'suspended' | 'deleted_at' | 'deleted_day_requests'>
      >();
  }

  async function deleteAccount(u: User, email: string): Promise<void> {
    const res = await u.client.call('/api/account', {
      method: 'DELETE',
      json: { confirmEmail: email },
    });
    expect(res.status).toBe(204);
  }

  /** Moves the identity's deletion `days` into the past, as if that much time had gone by. */
  async function ageDeletion(identity: string, days: number): Promise<void> {
    await env.DB.prepare('UPDATE pool_identities SET deleted_at = ? WHERE identity = ?')
      .bind(new Date(Date.now() - days * 86_400_000).toISOString(), identity)
      .run();
  }

  it('strips the user id from the pool rows, the network key once the day is over, and leaves the pool’s sums alone', async () => {
    const ip = freshIp();
    const email = `gone-${Math.random().toString(36).slice(2, 8)}@example.org`;
    const stays = await poolReadyUser({ ip });
    const gone = await poolReadyUser({ ip, email, poolId: stays.poolId });
    const admin = await poolReadyUser({ poolId: stays.poolId, ip: freshIp() });
    const adminEnv = authEnv({ TEST_POOL_ACCOUNT_ID: stays.poolId, ADMIN_USER_IDS: admin.userId });
    const poolId = stays.poolId;
    await sendOk(stays, (await newTree(stays)).branchId);
    const { branchId } = await newTree(gone);
    await sendOk(gone, branchId, 'One');
    await sendOk(gone, branchId, 'Two');
    const bank = poolBank(env, poolId);
    expect(await rateKeys(bank)).toContain(`u:${gone.userId}`);
    // The network has its 3 replies of the day.
    const neighbour = await poolReadyUser({
      ip,
      poolId,
      env: { POOL_IP_REQUESTS_PER_DAY: '3' },
    });
    const neighbourTree = await newTree(neighbour);
    expect(
      (await refused(await send(neighbour, neighbourTree.branchId), 429, 'pool_cap_reached'))
        .reason,
    ).toBe('cap_ip');

    const before = await settledRows(poolId);
    expect(before.filter((r) => r.user_id === gone.userId)).toHaveLength(2);
    const balance = await getBalance(env.DB, poolId);
    const total = await dayTotal(poolId);

    await deleteAccount(gone, email);

    const after = await poolRows(poolId);
    const ledger = (rows: Record<string, unknown>[]) =>
      rows.map(({ user_id: _u, ip_key: _i, ...kept }) => kept);
    expect(ledger(after)).toEqual(ledger(before));
    expect(after.filter((r) => r.user_id === gone.userId)).toEqual([]);
    const stripped = after.filter((r) => r.user_id === null);
    expect(stripped).toHaveLength(2);
    // Today's rows keep the network key: without the user id it links nothing within the day.
    const networkKey = before.find((r) => r.user_id === stays.userId)!.ip_key;
    expect(stripped.every((r) => r.ip_key === networkKey)).toBe(true);
    // The account that stays keeps its rows as they were.
    expect(after.filter((r) => r.user_id === stays.userId)).toEqual(
      before.filter((r) => r.user_id === stays.userId),
    );
    expect(await getBalance(env.DB, poolId)).toEqual(balance);
    expect(await dayTotal(poolId)).toBe(total);
    expect(await bank.maintain({ poolId, giveUpMs: POOL_GIVE_UP_MS })).toMatchObject({
      mismatchMicros: 0,
    });
    expect(await rateKeys(bank)).not.toContain(`u:${gone.userId}`);

    // The report lists who remains; the network keeps its day's replies, from one known user.
    const report = await ok<AdminPoolUsageResponse>(
      await admin.client.call('/api/admin/pool/usage?days=1&limit=10', {}, adminEnv),
    );
    expect(report.rows.map((r) => [r.userId, r.requests])).toEqual([[stays.userId, 1]]);
    expect(report.ipKeys).toEqual([expect.objectContaining({ users: 1, requests: 3 })]);
    // Deleting the account didn't reset the network's cap: another mailbox on it is still refused.
    expect(
      (await refused(await send(neighbour, neighbourTree.branchId), 429, 'pool_cap_reached'))
        .reason,
    ).toBe('cap_ip');

    // Once the day is over, the daily sweep takes the network key off the deleted account's rows.
    const tomorrow = new Date(nextUtcMidnight());
    await sweepDeletedUsers(env.DB, tomorrow);
    const swept = await poolRows(poolId);
    expect(swept.filter((r) => r.user_id === null).map((r) => r.ip_key)).toEqual([null, null]);
    expect(swept.filter((r) => r.user_id === stays.userId)).toEqual(
      before.filter((r) => r.user_id === stays.userId),
    );
    expect(ledger(swept)).toEqual(ledger(before));
  });

  it('the daily sweep catches up on a deletion it didn’t see (an older Worker’s)', async () => {
    const email = `missed-${Math.random().toString(36).slice(2, 8)}@example.org`;
    const missed = await poolReadyUser({ email, ip: freshIp() });
    const admin = await poolReadyUser({ poolId: missed.poolId });
    const poolId = missed.poolId;
    const identity = await poolIdentity(email);
    await sendOk(missed, (await newTree(missed)).branchId);
    // A suspension writes the identity row, as the older Worker did.
    await ok<AdminUser>(
      await admin.client.call(
        `/api/admin/users/${missed.userId}`,
        { method: 'PATCH', json: { poolSuspended: true } },
        authEnv({ TEST_POOL_ACCOUNT_ID: poolId, ADMIN_USER_IDS: admin.userId }),
      ),
    );
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO credit_grants (id, account_id, kind, amount_micros, user_id, provider_ref, created_at)
         VALUES (?, ?, 'adjustment', 1, ?, NULL, ?)`,
      ).bind(uniq('grant'), poolId, missed.userId, new Date().toISOString()),
      env.DB.prepare(
        `INSERT INTO pool_identity_holders (user_id, identity, claimed_at) VALUES (?, ?, ?)`,
      ).bind(missed.userId, identity, new Date().toISOString()),
      // The older Worker's deletion: the user row goes, everything the pool keeps stays as it was.
      env.DB.prepare('DELETE FROM auth_users WHERE id = ?').bind(missed.userId),
    ]);
    const rows = await settledRows(poolId);
    expect(rows.map((r) => r.user_id)).toEqual([missed.userId]);
    const networkKey = rows[0]!.ip_key;
    expect(networkKey).not.toBeNull();
    expect(await identityRow(identity)).toMatchObject({ suspended: 1, deleted_at: null });

    const now = new Date();
    for (let run = 0; run < 2; run++) {
      await CRON_JOBS.deletedAccounts(env, now);
      expect((await poolRows(poolId)).map((r) => [r.user_id, r.ip_key])).toEqual([
        [null, networkKey],
      ]);
      const grant = await env.DB.prepare(
        "SELECT user_id FROM credit_grants WHERE account_id = ? AND kind = 'adjustment' AND amount_micros = 1",
      )
        .bind(poolId)
        .first<{ user_id: string | null }>();
      expect(grant).toEqual({ user_id: null });
      const holder = await env.DB.prepare('SELECT 1 FROM pool_identity_holders WHERE user_id = ?')
        .bind(missed.userId)
        .first();
      expect(holder).toBeNull();
      // Its retention starts now, and a second run doesn't move it.
      expect(await identityRow(identity)).toMatchObject({
        suspended: 1,
        deleted_at: now.toISOString(),
      });
    }
    await sweepDeletedUsers(env.DB, new Date(nextUtcMidnight()));
    expect((await poolRows(poolId)).map((r) => [r.user_id, r.ip_key])).toEqual([[null, null]]);
  });

  it('a new account on the mailbox within the retention is the same identity, suspension and day', async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const first = await poolReadyUser({ email: `ab${tag}@gmail.com`, ip: freshIp() });
    const admin = await poolReadyUser({ poolId: first.poolId });
    const identity = await poolIdentity(`ab${tag}@gmail.com`);
    await sendOk(first, (await newTree(first)).branchId);
    await ok<AdminUser>(
      await admin.client.call(
        `/api/admin/users/${first.userId}`,
        { method: 'PATCH', json: { poolSuspended: true } },
        authEnv({ TEST_POOL_ACCOUNT_ID: first.poolId, ADMIN_USER_IDS: admin.userId }),
      ),
    );
    await deleteAccount(first, `ab${tag}@gmail.com`);
    const kept = await identityRow(identity);
    expect(kept).toMatchObject({ suspended: 1, deleted_day_requests: 1 });
    expect(Date.now() - Date.parse(kept!.deleted_at!)).toBeLessThan(60_000);

    // A day short of the retention, the cron keeps it.
    await ageDeletion(identity, POOL_IDENTITY_RETENTION_DAYS - 1);
    await CRON_JOBS.deletedAccounts(env, new Date());
    expect(await identityRow(identity)).toMatchObject({ suspended: 1 });

    const again = await poolReadyUser({
      email: `a.b${tag}@gmail.com`,
      poolId: first.poolId,
      ip: freshIp(),
    });
    expect((await poolAccess(again.userId))?.pool_identity).toBe(identity);
    expect(
      (await refused(await send(again, (await newTree(again)).branchId), 403, 'pool_unavailable'))
        .reason,
    ).toBe('suspended');
    // Held again, it outlasts the retention: only an identity nobody holds is purged.
    await ageDeletion(identity, POOL_IDENTITY_RETENTION_DAYS + 1);
    expect(await purgeReleasedPoolIdentities(env.DB)).toBe(0);
    expect(await identityRow(identity)).toMatchObject({ suspended: 1 });
  });

  it('two deletions on one mailbox in a day add up toward the next account’s caps', async () => {
    const email = `twice-${Math.random().toString(36).slice(2, 8)}@example.org`;
    const first = await poolReadyUser({ email, ip: freshIp() });
    const firstTree = await newTree(first);
    await sendOk(first, firstTree.branchId, 'One');
    await sendOk(first, firstTree.branchId, 'Two');
    await deleteAccount(first, email);
    const second = await poolReadyUser({ email, poolId: first.poolId, ip: freshIp() });
    await sendOk(second, (await newTree(second)).branchId);
    await deleteAccount(second, email);
    expect(await identityRow(await poolIdentity(email))).toMatchObject({
      deleted_day_requests: DAILY_REPLIES,
    });
    const third = await poolReadyUser({ email, poolId: first.poolId, ip: freshIp() });
    expect(
      (await refused(await send(third, (await newTree(third)).branchId), 429, 'pool_cap_reached'))
        .reason,
    ).toBe('cap_requests');
  });

  it('the daily cron purges an identity past the retention; the mailbox then starts afresh', async () => {
    const email = `fresh-${Math.random().toString(36).slice(2, 8)}@example.org`;
    const first = await poolReadyUser({ email, ip: freshIp() });
    const admin = await poolReadyUser({ poolId: first.poolId });
    const identity = await poolIdentity(email);
    const { branchId } = await newTree(first);
    for (let i = 0; i < DAILY_REPLIES; i++) await sendOk(first, branchId, `Q${i}`);
    await ok<AdminUser>(
      await admin.client.call(
        `/api/admin/users/${first.userId}`,
        { method: 'PATCH', json: { poolSuspended: true } },
        authEnv({ TEST_POOL_ACCOUNT_ID: first.poolId, ADMIN_USER_IDS: admin.userId }),
      ),
    );
    await deleteAccount(first, email);
    expect(await identityRow(identity)).toMatchObject({ suspended: 1 });

    await ageDeletion(identity, POOL_IDENTITY_RETENTION_DAYS + 1);
    await CRON_JOBS.deletedAccounts(env, new Date());
    expect(await identityRow(identity)).toBeNull();
    // Idempotent: a second run finds nothing.
    expect(await purgeReleasedPoolIdentities(env.DB)).toBe(0);

    // Same mailbox, same hash, but nothing of the old account: no suspension, the day's caps unused.
    const again = await poolReadyUser({ email, poolId: first.poolId, ip: freshIp() });
    expect((await poolAccess(again.userId))?.pool_identity).toBe(identity);
    const { branchId: next } = await newTree(again);
    for (let i = 0; i < DAILY_REPLIES; i++) await sendOk(again, next, `Q${i}`);
  });
});

describe('no OpenAI-compatible shape', () => {
  it('no completion-style endpoint exists, on any prefix', async () => {
    const u = await poolReadyUser();
    const body = { model: 'normal', messages: [{ role: 'user', content: 'Hi' }] };
    for (const path of [
      '/v1/chat/completions',
      '/v1/completions',
      '/v1/models',
      '/api/v1/chat/completions',
      '/api/chat/completions',
      '/api/completions',
      '/api/pool/chat/completions',
      '/api/pool/v1/chat/completions',
    ]) {
      const res = await u.client.call(path, {
        method: 'POST',
        json: body,
        headers: { authorization: 'Bearer sk-anything' },
        learn: 'pool',
      });
      expect(res.status, path).toBe(404);
    }
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE account_id = ?')
        .bind(u.poolId)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it('extra OpenAI-style fields on a send are ignored: the pool model, prompt and cap still apply', async () => {
    const u = await poolReadyUser({ env: { POOL_SYSTEM_PROMPT: 'LOCKED POOL PROMPT' } });
    const { branchId } = await newTree(u);
    const res = await u.client.call(`/api/branches/${branchId}/messages`, {
      method: 'POST',
      json: {
        content: `${ECHO} hi`,
        model: 'max',
        messages: [{ role: 'system', content: 'IGNORE ME' }],
        system: 'IGNORE ME',
        max_tokens: 99_999,
        temperature: 2,
        stream: false,
      },
      learn: 'pool',
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const reply = parseSse(text)
      .map((ev) => (ev.type === 'delta' ? ev.text : ''))
      .join('');
    expect(reply).toMatch(/^ECHO model=normal maxOutputTokens=2048 system=/);
    expect(reply).toContain('LOCKED POOL PROMPT');
    expect(reply).not.toContain('IGNORE ME');
  });
});

describe('consumption report', () => {
  it('lists pool users by spend, and the busiest network keys of today', async () => {
    const ip = freshIp();
    const heavy = await poolReadyUser({ ip });
    const light = await poolReadyUser({ ip, poolId: heavy.poolId });
    const admin = await poolReadyUser({ poolId: heavy.poolId });
    const adminEnv = authEnv({ TEST_POOL_ACCOUNT_ID: heavy.poolId, ADMIN_USER_IDS: admin.userId });
    const heavyTree = await newTree(heavy);
    await sendOk(heavy, heavyTree.branchId, 'One');
    await sendOk(heavy, heavyTree.branchId, 'Two');
    await sendOk(light, (await newTree(light)).branchId);

    const report = await ok<AdminPoolUsageResponse>(
      await admin.client.call('/api/admin/pool/usage?days=1&limit=10', {}, adminEnv),
    );
    const now = new Date();
    expect(report.since).toBe(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString(),
    );
    expect(report.rows.map((r) => [r.userId, r.requests])).toEqual([
      [heavy.userId, 2],
      [light.userId, 1],
    ]);
    const [first, second] = report.rows;
    expect(first!.spendMicros).toBeGreaterThan(second!.spendMicros);
    expect(second!.spendMicros).toBeGreaterThan(0);
    expect(first).toMatchObject({ lastAt: expect.any(String) as unknown });
    expect(first!.email).toMatch(/@example\.org$/);
    expect(report.ipKeys).toHaveLength(1);
    expect(report.ipKeys[0]).toMatchObject({ users: 2, requests: 3 });
    expect(report.ipKeys[0]!.ipKey).toMatch(/^[0-9a-f]{16}$/);
    // No address is ever stored or reported.
    expect(JSON.stringify(report)).not.toContain(ip);

    const limited = await ok<AdminPoolUsageResponse>(
      await admin.client.call('/api/admin/pool/usage?limit=1', {}, adminEnv),
    );
    expect(limited.rows.map((r) => r.userId)).toEqual([heavy.userId]);
    expect((await admin.client.call('/api/admin/pool/usage?days=0', {}, adminEnv)).status).toBe(
      400,
    );
    expect((await heavy.client.call('/api/admin/pool/usage')).status).toBe(404);
  });
});
