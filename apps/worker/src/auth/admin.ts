import { createMiddleware } from 'hono/factory';
import type { AppBindings, AppEnv, Identity } from '../env.js';
import { apiError } from '../http/errors.js';

/**
 * The operator's own accounts: the Better Auth user ids in the ADMIN_USER_IDS
 * secret (comma-separated; blanks ignored). Admins open the admin app
 * (`/admin/`, http/learn-app.ts) and `/api/admin/*` (routes/admin.ts).
 */
export function adminUserIds(env: AppEnv): ReadonlySet<string> {
  return new Set(
    (env.ADMIN_USER_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

/** True when `userId` is listed in ADMIN_USER_IDS. */
export function isAdminUserId(env: AppEnv, userId: string | null): boolean {
  return !!userId && adminUserIds(env).has(userId);
}

/**
 * True when the caller is an admin: a signed-in user listed in ADMIN_USER_IDS,
 * or the local dev bypass (`wrangler dev` with DEV_ALLOW_NO_AUTH, which has no
 * user to list), so the admin app can be worked on locally.
 */
export function isAdmin(env: AppEnv, identity: Identity): boolean {
  return identity.devMode || isAdminUserId(env, identity.userId);
}

/**
 * Admin routes only. Anyone else gets the same 404 as an unknown route, so the
 * admin API doesn't advertise itself. Runs after the session middleware.
 */
export const adminOnly = createMiddleware<AppBindings>(async (c, next) => {
  if (!isAdmin(c.env, c.var.identity)) return apiError(c, 'not_found', 'Route not found');
  await next();
  c.header('Cache-Control', 'no-store');
});
