import { updateSettingsRequestSchema, type MeResponse } from '@tangent/shared';
import { Hono } from 'hono';
import { isAdmin } from '../auth/admin.js';
import { accountDeletionRoutes } from '../auth/delete-account.js';
import { builtInAvailable, canShare } from '../availability.js';
import { membershipFor, membershipNeededFor } from '../billing/membership.js';
import { readKeys } from '../byok/keys.js';
import { usesUserKeys, type AppBindings } from '../env.js';
import { validateJson } from '../http/errors.js';
import { providersFor } from '../registries.js';
import { withUsageFactors } from '../tiers.js';
import { branchRoutes } from './branches.js';
import { exportRoutes } from './export.js';
import { generationRoutes } from './generation.js';
import { keyRoutes } from './key.js';
import { linkRoutes } from './links.js';
import { chatOf } from './request-chat.js';
import { shareLinkRoutes } from './shares.js';
import { treeRoutes } from './trees.js';

/**
 * Owner API. Mounted under /api behind the session middleware (auth/session.ts)
 * and the account middleware (auth/account.ts). Every tree, branch, node,
 * link or share id is resolved through the caller's account (ChatService's
 * `getOwned*`, ShareService) before anything else happens, so another
 * account's ids are 404. Routes that generate (routes/generation.ts and
 * `context?resolve=true`) pass `assertCanGenerate` (billing/gate.ts): who pays
 * (a Learn send on spent credit moves to the open pool), the membership for
 * the user's own keys, in Learn or power mode (402 `membership_required`,
 * when one is required; Tangent credit and the pool need none), then the
 * credit (402 `payment_required`) or the pool's rules. Every other route
 * stays open without a membership.
 */
export function apiRoutes(): Hono<AppBindings> {
  const api = new Hono<AppBindings>();

  // The membership rides along so the apps can gate at startup without a second
  // request (one query, none when no membership is required); so does whether
  // the user may share (one query while sharing is off, see canShare).
  api.get('/me', async (c) => {
    const { identity, account } = c.var;
    const [sharing, membership] = await Promise.all([
      canShare(c.env, identity.userId),
      membershipFor(c.env, account),
    ]);
    return c.json({
      email: identity.email,
      userId: identity.userId,
      devMode: identity.devMode,
      accountId: account.id,
      mode: account.mode,
      operatorKeys: account.operatorKeys,
      builtInCredit: builtInAvailable(c.env),
      sharing,
      isAdmin: isAdmin(c.env, identity),
      membership,
      membershipNeededFor: membershipNeededFor(account, membership),
    } satisfies MeResponse);
  });

  // Power lists the built-in endpoint twice: on the user's key and as Tangent credit (`funding`).
  // The Max model of each entry listing both tiers carries its `usageFactor` (tiers.ts).
  api.get('/providers', async (c) => {
    // An unreadable key cookie simply counts as no user keys here; /key/status clears it.
    const keys = usesUserKeys(c.var.account) ? await readKeys(c) : null;
    const apiKeys = keys?.state === 'ok' ? keys.keys : undefined;
    return c.json(await withUsageFactors(c.env, providersFor(c.env, c.var.account, apiKeys)));
  });

  api.route('/key', keyRoutes());
  api.route('/account', accountDeletionRoutes());

  // Account settings (per account, so power and Learn each have their own).
  api.get('/settings', async (c) => c.json(await chatOf(c).getSettings()));
  api.patch('/settings', validateJson(updateSettingsRequestSchema), async (c) =>
    c.json(await chatOf(c).updateSettings(c.req.valid('json'))),
  );

  api.route('/', treeRoutes());
  api.route('/', exportRoutes());
  api.route('/', branchRoutes());
  api.route('/', generationRoutes());
  api.route('/', linkRoutes());
  api.route('/', shareLinkRoutes());

  return api;
}
