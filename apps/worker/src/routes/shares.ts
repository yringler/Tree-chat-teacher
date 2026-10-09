import { DomainError } from '@tangent/core';
import { API_ROUTES } from '@tangent/shared';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { canShare } from '../availability.js';
import type { AppBindings } from '../env.js';
import { validateJson } from '../http/errors.js';
import { shareService } from '../registries.js';
import { purgeShare } from '../share/cache.js';

/**
 * The owner's share links (the public pages are routes/share.ts). With
 * sharing off (no DMCA agent registered) only admins and the users the
 * operator allowed publish (`canShare`): for anyone else create, edit and
 * republish are 403. Listing, revoking and deleting stay open so owners can
 * take old links down.
 */
export function shareLinkRoutes(): Hono<AppBindings> {
  const api = new Hono<AppBindings>();

  const sharingOn = createMiddleware<AppBindings>(async (c, next) => {
    if (!(await canShare(c.env, c.var.identity.userId))) {
      throw new DomainError(
        'forbidden',
        "Public share links aren't enabled for your account. Download the conversation instead.",
      );
    }
    await next();
  });
  api.get('/shares', async (c) =>
    c.json(await shareService(c.env, c.req.url, c.var.accountId).list()),
  );
  api.post('/shares', sharingOn, validateJson(API_ROUTES.createShare), async (c) =>
    c.json(await shareService(c.env, c.req.url, c.var.accountId).create(c.req.valid('json')), 201),
  );
  api.patch('/shares/:shareId', sharingOn, validateJson(API_ROUTES.updateShare), async (c) =>
    c.json(
      await shareService(c.env, c.req.url, c.var.accountId).update(
        c.req.param('shareId'),
        c.req.valid('json'),
      ),
    ),
  );
  api.post('/shares/:shareId/republish', sharingOn, async (c) => {
    const s = await shareService(c.env, c.req.url, c.var.accountId).republish(
      c.req.param('shareId'),
    );
    c.executionCtx.waitUntil(purgeShare(s.token, [s.version - 1]));
    return c.json(s);
  });
  api.post('/shares/:shareId/revoke', async (c) => {
    const s = await shareService(c.env, c.req.url, c.var.accountId).revoke(c.req.param('shareId'));
    c.executionCtx.waitUntil(purgeShare(s.token, [s.version - 1, s.version]));
    return c.json(s);
  });
  api.delete('/shares/:shareId', async (c) => {
    const s = await shareService(c.env, c.req.url, c.var.accountId).delete(c.req.param('shareId'));
    c.executionCtx.waitUntil(purgeShare(s.token, [s.version]));
    return c.body(null, 204);
  });

  return api;
}
