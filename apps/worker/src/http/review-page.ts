import { renderViewerPage, viewerCsp } from '@tangent/render';
import type { SharePayload } from '@tangent/shared';
import { Hono } from 'hono';
import { isAdmin } from '../auth/admin.js';
import type { AuthDeps } from '../auth/auth.js';
import { userIdOfAccount } from '../auth/account.js';
import { optionalIdentity } from '../auth/session.js';
import { createD1Repositories } from '../db/d1-repositories.js';
import type { AppBindings } from '../env.js';
import { recordAudit } from '../share/audit.js';
import { heldSnapshot } from '../share/legal-hold.js';
import { notFoundPage } from './learn-app.js';

/**
 * `/admin/review/:shareId`: the conversation a share published, for an admin
 * deciding a report (the admin app links it, in a new tab). It shows the
 * stored snapshot whatever the share's state, or, once the share is revoked
 * or deleted, the snapshot a legal hold kept: the only place a held copy is
 * readable over HTTP. A document rather than an API reply, so the content is
 * rendered by the same escaping viewer as a share page and never handed to
 * script as data. Admins only (`isAdmin`); anyone else, and a share with
 * nothing to show, gets the admin app's plain 404. Every view is audited
 * (`share_reviewed`), so who read reported content is on record. Mounted by
 * `createApp` before the admin app, which would otherwise serve the path.
 */
export function reviewPageRoutes(deps: AuthDeps = {}): Hono<AppBindings> {
  const r = new Hono<AppBindings>();
  r.get('/admin/review/:shareId', async (c) => {
    const identity = await optionalIdentity(c.env, c.req.raw, deps);
    if (!identity || !isAdmin(c.env, identity)) return notFoundPage();
    const shareId = c.req.param('shareId');
    const repos = createD1Repositories(c.env.DB);
    const [share, stored] = await Promise.all([
      repos.shares.getShare(shareId),
      repos.shares.getSnapshot(shareId),
    ]);
    const json = stored ?? (await heldSnapshot(c.env.DB, shareId));
    if (!json) return notFoundPage();
    await recordAudit(c.env.DB, {
      kind: 'share_reviewed',
      actor: 'admin',
      actorUserId: identity.userId,
      subjectUserId: share ? userIdOfAccount(share.accountId) : null,
      shareId,
      data: { source: stored ? 'share' : 'hold' },
    });
    const csp = await viewerCsp();
    const html = renderViewerPage(JSON.parse(json) as SharePayload, { variant: 'share', csp });
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': csp,
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
      },
    });
  });
  return r;
}
