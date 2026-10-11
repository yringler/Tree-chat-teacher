import type { ShareSummary } from '@tangent/shared';
import { API_ROUTES } from '@tangent/shared';
import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../env.js';
import { validateJson } from '../http/errors.js';
import { shareService } from '../registries.js';
import { recordAudit, type ShareAuditEvent } from '../share/audit.js';
import { purgeShare } from '../share/cache.js';
import { assertMayPublish } from '../share/gate.js';

/** Records the owner's change to `share` in the audit log. */
function audit(
  c: Context<AppBindings>,
  kind: ShareAuditEvent['kind'],
  share: ShareSummary,
): Promise<void> {
  const { userId } = c.var.identity;
  return recordAudit(c.env.DB, {
    kind,
    actor: 'user',
    actorUserId: userId,
    subjectUserId: userId,
    shareId: share.id,
    data: { version: share.version, scope: share.scope },
  });
}

/**
 * The owner's share links (the public pages are routes/share.ts). Only users
 * `assertMayPublish` admits create, edit and republish (`SHARING`, the
 * allowlist, a sharing suspension, the account's age, and a daily limit on
 * new links). Listing, revoking and deleting stay open so owners can take
 * old links down. Every change is recorded in the audit log.
 */
export function shareLinkRoutes(): Hono<AppBindings> {
  const api = new Hono<AppBindings>();

  const publishing = (creating: boolean) =>
    createMiddleware<AppBindings>(async (c, next) => {
      await assertMayPublish(c.env, c.var.identity.userId, { creating });
      await next();
    });
  api.get('/shares', async (c) =>
    c.json(await shareService(c.env, c.req.url, c.var.accountId).list()),
  );
  api.post('/shares', publishing(true), validateJson(API_ROUTES.createShare), async (c) => {
    const s = await shareService(c.env, c.req.url, c.var.accountId).create(c.req.valid('json'));
    await audit(c, 'share_created', s);
    return c.json(s, 201);
  });
  api.patch(
    '/shares/:shareId',
    publishing(false),
    validateJson(API_ROUTES.updateShare),
    async (c) => {
      const s = await shareService(c.env, c.req.url, c.var.accountId).update(
        c.req.param('shareId'),
        c.req.valid('json'),
      );
      await audit(c, 'share_updated', s);
      return c.json(s);
    },
  );
  api.post('/shares/:shareId/republish', publishing(false), async (c) => {
    const s = await shareService(c.env, c.req.url, c.var.accountId).republish(
      c.req.param('shareId'),
    );
    await audit(c, 'share_republished', s);
    c.executionCtx.waitUntil(purgeShare(s.token, [s.version - 1]));
    return c.json(s);
  });
  api.post('/shares/:shareId/revoke', async (c) => {
    const s = await shareService(c.env, c.req.url, c.var.accountId).revoke(c.req.param('shareId'));
    await audit(c, 'share_revoked', s);
    c.executionCtx.waitUntil(purgeShare(s.token, [s.version - 1, s.version]));
    return c.json(s);
  });
  api.delete('/shares/:shareId', async (c) => {
    const s = await shareService(c.env, c.req.url, c.var.accountId).delete(c.req.param('shareId'));
    await audit(c, 'share_deleted', s);
    c.executionCtx.waitUntil(purgeShare(s.token, [s.version]));
    return c.body(null, 204);
  });

  return api;
}
