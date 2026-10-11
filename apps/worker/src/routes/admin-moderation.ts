import { API_ROUTES, type AdminHold, type AdminHoldsResponse } from '@tangent/shared';
import { Hono } from 'hono';
import type { AppBindings } from '../env.js';
import { validateJson } from '../http/errors.js';
import {
  getHold,
  listHolds,
  placeHold,
  recordHoldReport,
  releaseHold,
} from '../share/legal-hold.js';

/**
 * Legal holds, mounted by `adminRoutes` behind its admins-only check. Every
 * reply is a hold's metadata (`AdminHold`); the held copies never leave D1
 * through the API, so a stolen admin session can't read them.
 */
export function adminModerationRoutes(): Hono<AppBindings> {
  const r = new Hono<AppBindings>();

  r.get('/holds', async (c) =>
    c.json({ holds: await listHolds(c.env.DB) } satisfies AdminHoldsResponse),
  );

  r.post('/shares/:shareId/hold', validateJson(API_ROUTES.adminPlaceHold), async (c) => {
    const { reason, notes } = c.req.valid('json');
    const { holdId } = await placeHold(c.env.DB, {
      reason,
      actor: 'admin',
      createdBy: c.var.identity.userId,
      shareId: c.req.param('shareId'),
      notes: notes || null,
    });
    return c.json((await getHold(c.env.DB, holdId)) satisfies AdminHold);
  });

  r.post('/holds/:holdId/release', validateJson(API_ROUTES.adminReleaseHold), async (c) => {
    const holdId = c.req.param('holdId');
    const { notes } = c.req.valid('json');
    await releaseHold(c.env.DB, holdId, c.var.identity.userId, notes || null);
    return c.json((await getHold(c.env.DB, holdId)) satisfies AdminHold);
  });

  r.post('/holds/:holdId/external-report', validateJson(API_ROUTES.adminReportHold), async (c) => {
    const holdId = c.req.param('holdId');
    await recordHoldReport(c.env.DB, holdId, c.var.identity.userId, c.req.valid('json'));
    return c.json((await getHold(c.env.DB, holdId)) satisfies AdminHold);
  });

  return r;
}
