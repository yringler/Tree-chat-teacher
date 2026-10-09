import { createLinkRequestSchema, updateLinkRequestSchema } from '@tangent/shared';
import { Hono } from 'hono';
import type { AppBindings } from '../env.js';
import { validateJson } from '../http/errors.js';
import { chatOf } from './request-chat.js';

/**
 * Links: cross-references between two messages of a tree. They never
 * generate, so no gate: read-only power branches can be linked too.
 */
export function linkRoutes(): Hono<AppBindings> {
  const api = new Hono<AppBindings>();

  api.post('/links', validateJson(createLinkRequestSchema), async (c) => {
    const { link, created } = await chatOf(c).createLink(c.req.valid('json'));
    return c.json(link, created ? 201 : 200);
  });
  api.patch('/links/:linkId', validateJson(updateLinkRequestSchema), async (c) =>
    c.json(await chatOf(c).updateLink(c.req.param('linkId'), c.req.valid('json'))),
  );
  api.delete('/links/:linkId', async (c) => {
    await chatOf(c).deleteLink(c.req.param('linkId'));
    return c.body(null, 204);
  });

  return api;
}
