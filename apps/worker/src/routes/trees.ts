import { createTreeRequestSchema, updateTreeRequestSchema } from '@tangent/shared';
import { Hono } from 'hono';
import { readKeys } from '../byok/keys.js';
import { treeSession } from '../do/tree-session-client.js';
import { callPayer, type AppBindings } from '../env.js';
import { validateJson } from '../http/errors.js';
import { chatOf } from './request-chat.js';

/** Trees: listing, creating, reading, renaming and deleting them. Nothing here generates. */
export function treeRoutes(): Hono<AppBindings> {
  const api = new Hono<AppBindings>();

  api.get('/trees', async (c) => c.json(await chatOf(c).listTrees()));
  // Without a system prompt in the request, the tree gets the account's saved
  // default, else the built-in one (defaultSystemPromptFor in registries.ts).
  // A tree that names no provider starts on the default route, whose first choice is a
  // provider the user has a key for: the key cookie is read for it (leniently: an
  // unreadable cookie counts as no keys, since nothing is sent here).
  api.post('/trees', validateJson(createTreeRequestSchema), async (c) => {
    const req = c.req.valid('json');
    const keys =
      req.providerId === undefined && callPayer(c.var.account, 'own-key') === 'own-key'
        ? await readKeys(c)
        : null;
    return c.json(await chatOf(c, keys?.state === 'ok' ? keys : null).createTree(req), 201);
  });
  api.get('/trees/:treeId', async (c) =>
    c.json(await chatOf(c).getTreeDetail(c.req.param('treeId'))),
  );
  api.patch('/trees/:treeId', validateJson(updateTreeRequestSchema), async (c) =>
    c.json(await chatOf(c).updateTree(c.req.param('treeId'), c.req.valid('json'))),
  );
  // Through the tree's Durable Object: it stops the tree's generations first and
  // drops what it holds for the tree (Compare candidates).
  api.delete('/trees/:treeId', async (c) =>
    treeSession(c.env, c.req.param('treeId')).deleteTree(c.var.account),
  );

  return api;
}
