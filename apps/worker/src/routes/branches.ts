import {
  contextLimitsQuerySchema,
  createBranchRequestSchema,
  updateBranchRequestSchema,
} from '@tangent/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { assertCanGenerate } from '../billing/gate.js';
import { sameOriginOnly } from '../byok/guard.js';
import { treeSession } from '../do/tree-session-client.js';
import type { AppBindings } from '../env.js';
import { validateJson, validateQuery } from '../http/errors.js';
import { generationLimits, inputBudgetResponse } from '../input-limit.js';
import { chatOf, keysOf } from './request-chat.js';

/** The preview plans like a send with power's limits (`contextLimitsQuerySchema`) when given. */
const contextQuerySchema = contextLimitsQuerySchema.extend({
  nodeId: z.string().min(1).max(64).optional(),
  resolve: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

/**
 * Branches: creating, editing and deleting them, and what a send on one
 * would see (its context and input budget). Only `context?resolve=true`
 * generates (missing summaries), so only it passes the gate.
 */
export function branchRoutes(): Hono<AppBindings> {
  const api = new Hono<AppBindings>();

  // The service resolves the node and the branch through the caller's account (404 otherwise).
  api.post('/branches', validateJson(createBranchRequestSchema), async (c) =>
    c.json(await chatOf(c).createBranch(c.req.valid('json')), 201),
  );
  api.patch('/branches/:branchId', validateJson(updateBranchRequestSchema), async (c) =>
    c.json(await chatOf(c).updateBranch(c.req.param('branchId'), c.req.valid('json'))),
  );
  api.delete('/branches/:branchId', async (c) => {
    const branch = await chatOf(c).getOwnedBranch(c.req.param('branchId'));
    // Through the tree's Durable Object: it owns the generations it has to stop first.
    return treeSession(c.env, branch.treeId).deleteBranch(branch.id, c.var.account);
  });
  api.get(
    '/branches/:branchId/context',
    sameOriginOnly,
    validateQuery(contextQuerySchema),
    async (c) => {
      const q = c.req.valid('query');
      const keys = await keysOf(c);
      let chat = chatOf(c, keys);
      const branch = await chat.getOwnedBranch(c.req.param('branchId'));
      // resolve=true may generate summaries (billed on the built-in provider, which
      // summarizes its own branches, or on the pool); a plain plan only counts tokens.
      if (q.resolve) {
        await assertCanGenerate(c, {
          purpose: 'resolve',
          providerId: branch.providerId,
          funding: branch.funding,
          model: null,
          keys,
        });
        chat = chatOf(c, keys, true);
      }
      const res = await chat.planContext(branch.id, q.nodeId ?? null, {
        resolveSummaries: q.resolve,
        signal: c.req.raw.signal,
        limits: generationLimits(c.env, c.var.account, branch.funding, q),
      });
      return c.json(res);
    },
  );
  // What bounds a message's input on the branch, for power's input limit setting.
  api.get('/branches/:branchId/input-budget', async (c) => {
    const chat = chatOf(c, await keysOf(c));
    return c.json(await inputBudgetResponse(c.env, c.var.account, chat, c.req.param('branchId')));
  });

  return api;
}
