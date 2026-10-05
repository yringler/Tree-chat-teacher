import { NotFoundError, ValidationError } from '@tangent/core';
import {
  ADMIN_USERS_PAGE,
  adminUsersQuerySchema,
  updateAdminUserRequestSchema,
  type AdminStatusResponse,
  type AdminUser,
  type AdminUsersResponse,
  type ShareSummary,
} from '@tangent/shared';
import { Hono } from 'hono';
import { POWER_ACCOUNT_PREFIX, SIMPLE_ACCOUNT_PREFIX } from '../auth/account.js';
import { adminOnly, adminUserIds } from '../auth/admin.js';
import { sameOriginOnly } from '../byok/guard.js';
import { createD1Repositories } from '../db/d1-repositories.js';
import type { AppBindings, AppEnv } from '../env.js';
import { validateJson, validateQuery } from '../http/errors.js';
import { purgeShare } from '../share/cache.js';
import { shareService, sharingEnabled } from '../services.js';

interface UserRow {
  id: string;
  email: string;
  name: string;
  created_at: number;
  share_allowed: number;
  active_shares: number;
}

/**
 * Columns of an AdminUser row. Active shares: of either of the user's accounts
 * (`p_<id>`, `u_<id>`), neither revoked nor expired at `?1` (an ISO timestamp,
 * compared as text like ShareService does).
 */
const USER_COLUMNS = `u.id, u.email, u.name, u.created_at, u.share_allowed,
  (SELECT COUNT(*) FROM shares s
    WHERE s.account_id IN ('${POWER_ACCOUNT_PREFIX}' || u.id, '${SIMPLE_ACCOUNT_PREFIX}' || u.id)
      AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?1)) AS active_shares`;

function toAdminUser(row: UserRow, admins: ReadonlySet<string>): AdminUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: new Date(row.created_at).toISOString(),
    shareAllowed: row.share_allowed === 1,
    isAdmin: admins.has(row.id),
    activeShares: row.active_shares,
  };
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
 * packages/shared/src/admin.ts and the route list in api.ts.
 *
 * It manages who may publish share links while DMCA_AGENT_REGISTERED is off
 * (`auth_users.share_allowed`, see `canShare`), and takes any share down
 * without its owner (a DMCA notice, docs/LEGAL.md §8).
 */
export function adminRoutes(): Hono<AppBindings> {
  const r = new Hono<AppBindings>();
  r.use('*', adminOnly);

  r.get('/status', (c) =>
    c.json({ dmcaAgentRegistered: sharingEnabled(c.env) } satisfies AdminStatusResponse),
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

  // Revoking the permission takes the user's links down at once: /s/* checks it per request.
  r.patch(
    '/users/:userId',
    sameOriginOnly,
    validateJson(updateAdminUserRequestSchema),
    async (c) => {
      const userId = c.req.param('userId');
      const { shareAllowed } = c.req.valid('json');
      const updated = await c.env.DB.prepare('UPDATE auth_users SET share_allowed = ? WHERE id = ?')
        .bind(shareAllowed ? 1 : 0, userId)
        .run();
      if (!updated.meta.changes) throw new NotFoundError('User');
      return c.json((await getUser(c.env, userId)) satisfies AdminUser);
    },
  );

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
  r.post('/shares/:shareId/revoke', sameOriginOnly, async (c) => {
    const share = await createD1Repositories(c.env.DB).shares.getShare(c.req.param('shareId'));
    if (!share) throw new NotFoundError('Share');
    const s = await shareService(c.env, c.req.url, share.accountId).revoke(share.id);
    c.executionCtx.waitUntil(purgeShare(s.token, [s.version - 1, s.version]));
    return c.json(s satisfies ShareSummary);
  });

  return r;
}
