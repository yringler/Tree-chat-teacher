import { NotFoundError, ValidationError } from '@tangent/core';
import {
  ADMIN_USERS_PAGE,
  adminCreditRequestSchema,
  adminPoolUsageQuerySchema,
  type AdminPoolResponse,
  type AdminCreditResponse,
  adminUsersQuerySchema,
  updateAdminUserRequestSchema,
  type AdminPoolIpKeyRow,
  type AdminPoolUsageResponse,
  type AdminPoolUsageRow,
  type AdminStatusResponse,
  type AdminUser,
  type AdminUsersResponse,
  type ShareSummary,
  centsToMicros,
} from '@tangent/shared';
import { Hono } from 'hono';
import {
  billingAccountIdFor,
  POWER_ACCOUNT_PREFIX,
  SIMPLE_ACCOUNT_PREFIX,
} from '../auth/account.js';
import { adminOnly, adminUserIds } from '../auth/admin.js';
import { getBalance, grantByRef, grantCredit } from '../billing/ledger.js';
import { ACTIVE_STATUSES, membershipRequired } from '../billing/membership.js';
import { MEMBERSHIP_KIND } from '../billing/payments/port.js';
import { fulfilPurchase } from '../billing/purchases.js';
import { appConfig } from '../config.js';
import { createD1Repositories } from '../db/d1-repositories.js';
import type { AppBindings, AppEnv } from '../env.js';
import { apiError, validateJson, validateQuery } from '../http/errors.js';
import { identitySuspensionStatement } from '../pool/identity.js';
import { poolBank } from '../pool/ids.js';
import { POOL_OVERAGE } from '../pool/params.js';
import { poolOverageMicros } from '../pool/pool-bank.js';
import { purgeShare } from '../share/cache.js';
import { poolAvailable, sharingEnabled } from '../availability.js';
import { shareService } from '../registries.js';
import { logEvent } from '../log.js';

interface UserRow {
  id: string;
  email: string;
  name: string;
  created_at: number;
  share_allowed: number;
  pool_suspended: number;
  active_shares: number;
  credit_balance: number;
  membership_waived: number;
  membership_paid: number;
}

/**
 * Columns of an AdminUser row. Active shares: of either of the user's accounts
 * (`p_<id>`, `u_<id>`), neither revoked nor expired at `?1` (an ISO timestamp,
 * compared as text like ShareService does). Credit balance: the user's ledger
 * (`u_<id>`, `billingAccountIdFor`) as ledger.ts sums it, holds not deducted.
 * Paid membership: a membership subscription in a status that counts, as
 * `membershipFor` reads it.
 */
const USER_COLUMNS = `u.id, u.email, u.name, u.created_at, u.share_allowed, u.membership_waived,
  EXISTS (SELECT 1 FROM billing_subscriptions bs
    WHERE bs.user_id = u.id AND bs.kind = '${MEMBERSHIP_KIND}'
      AND bs.status IN (${ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ')})) AS membership_paid,
  (u.pool_suspended OR COALESCE((SELECT pi.suspended FROM pool_identities pi
    WHERE pi.identity = u.pool_identity), 0)) AS pool_suspended,
  (SELECT COUNT(*) FROM shares s
    WHERE s.account_id IN ('${POWER_ACCOUNT_PREFIX}' || u.id, '${SIMPLE_ACCOUNT_PREFIX}' || u.id)
      AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?1)) AS active_shares,
  (SELECT COALESCE(SUM(g.amount_micros), 0) FROM credit_grants g
    WHERE g.account_id = '${SIMPLE_ACCOUNT_PREFIX}' || u.id)
  - (SELECT COALESCE(SUM(e.charge_micros), 0) FROM usage_events e
    WHERE e.account_id = '${SIMPLE_ACCOUNT_PREFIX}' || u.id AND e.status = 'settled') AS credit_balance`;

function toAdminUser(row: UserRow, admins: ReadonlySet<string>): AdminUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: new Date(row.created_at).toISOString(),
    shareAllowed: row.share_allowed === 1,
    isAdmin: admins.has(row.id),
    activeShares: row.active_shares,
    poolSuspended: row.pool_suspended === 1,
    creditBalanceMicros: Number(row.credit_balance),
    membershipWaived: row.membership_waived === 1,
    membershipPaid: row.membership_paid === 1,
  };
}

/** What one pool row costs: its charge once settled, its hold while pending. */
const SPENT = `(CASE WHEN e.status = 'pending' THEN e.hold_micros ELSE COALESCE(e.charge_micros, 0) END)`;

/** Pool replies (released ones never reached the model) and spend. */
const POOL_USAGE_COLUMNS = `
  COUNT(CASE WHEN e.purpose = 'reply' AND COALESCE(e.settle_reason, '') <> 'released' THEN 1 END) AS requests,
  COALESCE(SUM(${SPENT}), 0) AS spend`;

interface PoolUserRow {
  user_id: string;
  email: string | null;
  requests: number;
  spend: number;
  last_at: string;
}

interface PoolNetworkRow {
  ip_key: string;
  users: number;
  requests: number;
  spend: number;
}

function encodeCursor(createdAt: number, id: string): string {
  return btoa(`${createdAt}|${id}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(cursor: string): { createdAt: number; id: string } {
  try {
    const b64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const [createdAt, id, ...rest] = atob(b64).split('|');
    const ms = Number(createdAt);
    if (createdAt && Number.isSafeInteger(ms) && id && rest.length === 0)
      return { createdAt: ms, id };
  } catch {
    // fall through
  }
  throw new ValidationError('Invalid cursor');
}

async function getUser(env: AppEnv, userId: string): Promise<AdminUser> {
  const row = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM auth_users u WHERE u.id = ?2`)
    .bind(new Date().toISOString(), userId)
    .first<UserRow>();
  if (!row) throw new NotFoundError('User');
  return toAdminUser(row, adminUserIds(env));
}

/**
 * Admin API, mounted at /api/admin by `createApp` behind the session and
 * account middleware. Every route is admins only (`adminOnly`: 404 to anyone
 * else); the mutating ones are same-origin only. The contract is in
 * packages/shared/src/admin.ts and the route table in api-routes.ts.
 *
 * It manages who may publish share links while DMCA_AGENT_REGISTERED is off
 * (`auth_users.share_allowed`, see `canShare`), takes any share down
 * without its owner (a DMCA notice, docs/LEGAL.md §8), suspends a user's
 * open pool access (`auth_users.pool_suspended` and the user's pool
 * identity, checked by the pool gate on every pool request), waives a user's
 * membership (`auth_users.membership_waived`, as the waiver code does), reports who
 * consumes the pool, and credits a user's ledger or the pool without a payment
 * (`POST /credit`: adjustments, and simulated purchases where
 * DEV_PURCHASES_ENABLED allows them), showing the pool's balance and overage
 * breaker (`GET /pool`).
 */
export function adminRoutes(): Hono<AppBindings> {
  const r = new Hono<AppBindings>();
  r.use('*', adminOnly);

  r.get('/status', (c) =>
    c.json({
      dmcaAgentRegistered: sharingEnabled(c.env),
      membershipRequired: membershipRequired(c.env),
    } satisfies AdminStatusResponse),
  );

  r.get('/users', validateQuery(adminUsersQuerySchema), async (c) => {
    const { q, cursor } = c.req.valid('query');
    const after = cursor ? decodeCursor(cursor) : null;
    const where: string[] = [];
    const params: (string | number)[] = [new Date().toISOString()];
    if (q) {
      params.push(q.toLowerCase());
      where.push(`instr(lower(u.email), ?${params.length}) > 0`);
    }
    if (after) {
      params.push(after.createdAt, after.id);
      const [at, id] = [params.length - 1, params.length];
      where.push(`(u.created_at < ?${at} OR (u.created_at = ?${at} AND u.id < ?${id}))`);
    }
    params.push(ADMIN_USERS_PAGE + 1);
    const { results } = await c.env.DB.prepare(
      `SELECT ${USER_COLUMNS} FROM auth_users u
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY u.created_at DESC, u.id DESC LIMIT ?${params.length}`,
    )
      .bind(...params)
      .all<UserRow>();
    const page = results.slice(0, ADMIN_USERS_PAGE);
    const last = page.at(-1);
    const admins = adminUserIds(c.env);
    return c.json({
      users: page.map((row) => toAdminUser(row, admins)),
      nextCursor:
        results.length > ADMIN_USERS_PAGE && last ? encodeCursor(last.created_at, last.id) : null,
    } satisfies AdminUsersResponse);
  });

  // Revoking the share permission takes the user's links down at once: /s/* checks it per
  // request. A pool suspension applies from the user's next pool request (the gate reads it), and
  // a membership waiver from the user's next request (membershipFor reads it each time).
  r.patch('/users/:userId', validateJson(updateAdminUserRequestSchema), async (c) => {
    const userId = c.req.param('userId');
    const { shareAllowed, poolSuspended, membershipWaived } = c.req.valid('json');
    const sets: string[] = [];
    const params: (number | string)[] = [];
    if (shareAllowed !== undefined) {
      sets.push('share_allowed = ?');
      params.push(shareAllowed ? 1 : 0);
    }
    if (poolSuspended !== undefined) {
      sets.push('pool_suspended = ?');
      params.push(poolSuspended ? 1 : 0);
    }
    if (membershipWaived !== undefined) {
      // Keeps the time it was first waived, like redeeming the code (billing/membership.ts).
      if (membershipWaived) {
        sets.push(
          'membership_waived_at = CASE WHEN membership_waived = 1 THEN membership_waived_at ELSE ? END',
        );
        params.push(new Date().toISOString());
      }
      sets.push('membership_waived = ?');
      params.push(membershipWaived ? 1 : 0);
    }
    const db = c.env.DB;
    const [updated] = await db.batch([
      db.prepare(`UPDATE auth_users SET ${sets.join(', ')} WHERE id = ?`).bind(...params, userId),
      // On the pool identity too, so deleting the account doesn't lift it.
      ...(poolSuspended !== undefined
        ? [identitySuspensionStatement(db, userId, poolSuspended)]
        : []),
    ]);
    if (!updated!.meta.changes) throw new NotFoundError('User');
    if (poolSuspended !== undefined)
      logEvent('info', 'pool_suspension_set', { userId, poolSuspended });
    if (membershipWaived !== undefined)
      logEvent('info', 'membership_waiver_set', {
        adminId: c.var.identity.userId,
        userId,
        membershipWaived,
      });
    return c.json((await getUser(c.env, userId)) satisfies AdminUser);
  });

  // The pool's ledger and overage breaker, for the admin pool panel (top-ups: POST /credit).
  r.get('/pool', async (c) => {
    const poolId = appConfig(c.env).pool.accountId;
    const overage = POOL_OVERAGE;
    const [balance, overageMicros] = await Promise.all([
      getBalance(c.env.DB, poolId),
      poolOverageMicros(c.env.DB, poolId, overage.windowMs, new Date()),
    ]);
    return c.json({
      enabled: poolAvailable(c.env),
      accountId: poolId,
      ...balance,
      availableMicros: Math.max(0, balance.balanceMicros - balance.heldMicros),
      breaker: {
        overageMicros,
        maxMicros: overage.maxMicros,
        windowMs: overage.windowMs,
        tripped: overageMicros > overage.maxMicros,
      },
    } satisfies AdminPoolResponse);
  });

  // Who consumes the open pool, to spot outliers and account farms.
  r.get('/pool/usage', validateQuery(adminPoolUsageQuerySchema), async (c) => {
    const { days, limit } = c.req.valid('query');
    const poolId = appConfig(c.env).pool.accountId;
    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const since = new Date(today - (days - 1) * 86_400_000).toISOString();
    const [users, networks] = await c.env.DB.batch<Record<string, unknown>>([
      c.env.DB.prepare(
        `SELECT e.user_id, u.email, ${POOL_USAGE_COLUMNS}, MAX(e.created_at) AS last_at
         FROM usage_events e LEFT JOIN auth_users u ON u.id = e.user_id
         WHERE e.account_id = ?1 AND e.created_at >= ?2 AND e.user_id IS NOT NULL
         GROUP BY e.user_id
         ORDER BY spend DESC, requests DESC, e.user_id
         LIMIT ?3`,
      ).bind(poolId, since, limit),
      c.env.DB.prepare(
        `SELECT e.ip_key, COUNT(DISTINCT e.user_id) AS users, ${POOL_USAGE_COLUMNS}
         FROM usage_events e
         WHERE e.account_id = ?1 AND e.created_at >= ?2 AND e.ip_key IS NOT NULL
         GROUP BY e.ip_key
         ORDER BY users DESC, spend DESC, e.ip_key
         LIMIT ?3`,
      ).bind(poolId, new Date(today).toISOString(), limit),
    ]);
    return c.json({
      since,
      rows: (users!.results as unknown as PoolUserRow[]).map((r): AdminPoolUsageRow => ({
        userId: r.user_id,
        email: r.email,
        requests: Number(r.requests),
        spendMicros: Number(r.spend),
        lastAt: r.last_at,
      })),
      ipKeys: (networks!.results as unknown as PoolNetworkRow[]).map((r): AdminPoolIpKeyRow => ({
        ipKey: r.ip_key,
        users: Number(r.users),
        requests: Number(r.requests),
        spendMicros: Number(r.spend),
      })),
    } satisfies AdminPoolUsageResponse);
  });

  // Credit without a payment: a signed adjustment of a user's ledger or the pool (a negative pool
  // adjustment is clamped to what the pool has available, under PoolBank's lock), or a simulated
  // purchase, fulfilled exactly as the webhook would. Idempotent on the key.
  r.post('/credit', validateJson(adminCreditRequestSchema), async (c) => {
    const req = c.req.valid('json');
    const config = appConfig(c.env);
    // Like an unknown route: a production deployment doesn't advertise the dev tool.
    if (req.mode === 'simulated_purchase' && !config.flags.devPurchasesEnabled)
      return apiError(c, 'not_found', 'Route not found');
    const db = c.env.DB;
    if (req.userId !== null) {
      const user = await db
        .prepare('SELECT id FROM auth_users WHERE id = ?')
        .bind(req.userId)
        .first<{ id: string }>();
      if (!user) throw new NotFoundError('User');
    }
    const accountId =
      req.target === 'pool' ? config.pool.accountId : billingAccountIdFor(req.userId);
    const amountMicros = centsToMicros(req.amountCents);
    let ref: string;
    let credited: boolean;
    if (req.mode === 'simulated_purchase') {
      // The schema gives a simulated purchase a personal target, so a user.
      if (req.userId === null) throw new ValidationError('A simulated purchase needs a user');
      ref = `dev:${req.idempotencyKey}`;
      credited = await fulfilPurchase(c.env, {
        userId: req.userId,
        grossCents: req.amountCents,
        processorFeeCents: 0,
        ref,
        note: req.note ?? 'Simulated purchase',
      });
    } else {
      ref = `admin:${req.idempotencyKey}`;
      const note = req.note ?? 'Admin adjustment';
      if (req.target === 'pool' && amountMicros < 0) {
        const debit = await poolBank(c.env, accountId).debit({
          poolId: accountId,
          refId: ref,
          requestedMicros: -amountMicros,
          userId: req.userId,
          note,
        });
        credited = debit.debited;
      } else {
        credited = await grantCredit(db, {
          accountId,
          kind: 'adjustment',
          amountMicros,
          grossMicros: null,
          userId: req.userId,
          providerRef: ref,
          note,
        });
      }
    }
    // The row as written (now, or by the first request with this key).
    const row = await grantByRef(db, ref);
    const { balanceMicros } = await getBalance(db, row?.account_id ?? accountId);
    logEvent('info', 'admin_credit', {
      adminId: c.var.identity.userId,
      target: req.target,
      userId: req.userId,
      mode: req.mode,
      ref,
      credited,
      amountMicros: row?.amount_micros ?? 0,
    });
    return c.json({
      credited,
      amountMicros: row?.amount_micros ?? 0,
      balanceMicros,
    } satisfies AdminCreditResponse);
  });

  r.get('/users/:userId/shares', async (c) => {
    const { id } = await getUser(c.env, c.req.param('userId'));
    const lists = await Promise.all(
      [POWER_ACCOUNT_PREFIX, SIMPLE_ACCOUNT_PREFIX].map((prefix) =>
        shareService(c.env, c.req.url, prefix + id).list(),
      ),
    );
    const shares = lists.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return c.json(shares satisfies ShareSummary[]);
  });

  // A takedown: revokes any owner's share and purges its cached copies, like the owner's revoke.
  r.post('/shares/:shareId/revoke', async (c) => {
    const share = await createD1Repositories(c.env.DB).shares.getShare(c.req.param('shareId'));
    if (!share) throw new NotFoundError('Share');
    const s = await shareService(c.env, c.req.url, share.accountId).revoke(share.id);
    c.executionCtx.waitUntil(purgeShare(s.token, [s.version - 1, s.version]));
    return c.json(s satisfies ShareSummary);
  });

  return r;
}
