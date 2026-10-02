import { NotFoundError, projectShare, ValidationError, type ChatService } from '@tangent/core';
import { payloadToMarkdown, renderViewerPage, viewerCsp } from '@tangent/render';
import {
  createBranchRequestSchema,
  createShareRequestSchema,
  createTreeRequestSchema,
  exportQuerySchema,
  reviewRequestSchema,
  sendMessageRequestSchema,
  treeBackupSchema,
  updateBranchRequestSchema,
  updateSettingsRequestSchema,
  updateShareRequestSchema,
  updateTreeRequestSchema,
  type MeResponse,
} from '@tangent/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { accountDeletionRoutes } from '../auth/delete-account.js';
import { assertGenerationAllowed, enforceRateLimit, sameOriginOnly } from '../byok/guard.js';
import { assertMember, membershipFor } from '../billing/membership.js';
import { assertCanSpend } from '../billing/service.js';
import { readKeys, requireReadableKeys, type UserKeys } from '../byok/keys.js';
import { accountParams, type SessionSendBody } from '../do/tree-session.js';
import { isMetered, usesUserKeys, type AppBindings, type AppContext, type AppEnv } from '../env.js';
import { validateJson, validateQuery } from '../http/errors.js';
import { sseFrame, sseKeepAliveFrame, sseResponse } from '../http/sse.js';
import { purgeShare } from '../share/cache.js';
import { builtInAvailable, chatService, registryFor, shareService } from '../services.js';
import { keyRoutes } from './key.js';

const REVIEW_KEEPALIVE_MS = 15_000;

const contextQuerySchema = z.object({
  nodeId: z.string().min(1).max(64).optional(),
  resolve: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

/**
 * The caller's ChatService. `keys` are the user's own provider keys (unused
 * by Learn on credit); the usage meter of the built-in provider defers its
 * work to the request's `waitUntil`.
 */
function chatOf(
  c: AppContext,
  keys: Extract<UserKeys, { state: 'ok' }> | null = null,
): ChatService {
  return chatService(c.env, c.var.account, {
    ...(keys ? { apiKeys: keys.keys } : {}),
    defer: (p) => c.executionCtx.waitUntil(p),
  });
}

/**
 * The user's key cookie for routes that call a provider. Learn on credit
 * never uses the user's own keys, so the cookie (if any) is not even read;
 * power always reads it, for its other providers.
 */
async function keysOf(c: AppContext): Promise<Extract<UserKeys, { state: 'ok' }> | null> {
  return usesUserKeys(c.var.account) ? requireReadableKeys(c) : null;
}

/**
 * Owner API. Mounted under /api behind the session middleware (auth/session.ts)
 * and the account middleware (auth/account.ts). Every branch or node id is
 * resolved through the caller's account (`getOwnedBranch`/`getOwnedNode`)
 * before anything else happens, so another account's ids are 404. Routes that
 * generate check the membership (402 `membership_required`, when one is
 * required), then, for a call on the built-in provider, the credit (402
 * `payment_required`). Every other route stays open without a membership.
 */
export function apiRoutes(): Hono<AppBindings> {
  const api = new Hono<AppBindings>();

  // The membership rides along so the apps can gate at startup without a second
  // request (one query, none when no membership is required).
  api.get('/me', async (c) => {
    const { email, devMode } = c.var.identity;
    const { account } = c.var;
    return c.json({
      email,
      devMode,
      accountId: account.id,
      mode: account.mode,
      operatorKeys: account.operatorKeys,
      builtInCredit: builtInAvailable(c.env),
      membership: await membershipFor(c.env, account),
    } satisfies MeResponse);
  });

  api.get('/providers', async (c) => {
    if (!usesUserKeys(c.var.account)) return c.json(registryFor(c.env, c.var.account).list());
    // An unreadable key cookie simply counts as no user keys here; /key/status clears it.
    const keys = await readKeys(c);
    return c.json(
      registryFor(c.env, c.var.account, keys.state === 'ok' ? keys.keys : undefined).list(),
    );
  });

  api.route('/key', keyRoutes());
  api.route('/account', accountDeletionRoutes());

  // ---- account settings (per account, so power and Learn each have their own)
  api.get('/settings', async (c) => c.json(await chatOf(c).getSettings()));
  api.patch('/settings', validateJson(updateSettingsRequestSchema), async (c) =>
    c.json(await chatOf(c).updateSettings(c.req.valid('json'))),
  );

  // ---- trees
  api.get('/trees', async (c) => c.json(await chatOf(c).listTrees()));
  // Without a system prompt in the request, the tree gets the account's saved
  // default, else the built-in one (defaultSystemPromptFor in services.ts).
  api.post('/trees', validateJson(createTreeRequestSchema), async (c) =>
    c.json(await chatOf(c).createTree(c.req.valid('json')), 201),
  );
  api.get('/trees/:treeId', async (c) =>
    c.json(await chatOf(c).getTreeDetail(c.req.param('treeId'))),
  );
  api.patch('/trees/:treeId', validateJson(updateTreeRequestSchema), async (c) =>
    c.json(await chatOf(c).updateTree(c.req.param('treeId'), c.req.valid('json'))),
  );
  api.delete('/trees/:treeId', async (c) => {
    await chatOf(c).deleteTree(c.req.param('treeId'));
    return c.body(null, 204);
  });
  api.get('/trees/:treeId/backup', async (c) => {
    const backup = await chatOf(c).exportBackup(c.req.param('treeId'));
    return c.json(backup, 200, {
      'Content-Disposition': `attachment; filename="${slug(backup.tree.title)}.tangent.json"`,
    });
  });
  api.post('/import', validateJson(treeBackupSchema), async (c) =>
    c.json(await chatOf(c).importBackup(c.req.valid('json')), 201),
  );

  // ---- branches
  api.post('/branches', validateJson(createBranchRequestSchema), async (c) => {
    const req = c.req.valid('json');
    const chat = chatOf(c);
    await chat.getOwnedNode(req.fromNodeId);
    return c.json(await chat.createBranch(req), 201);
  });
  api.patch('/branches/:branchId', validateJson(updateBranchRequestSchema), async (c) => {
    const chat = chatOf(c);
    const branch = await chat.getOwnedBranch(c.req.param('branchId'));
    return c.json(await chat.updateBranch(branch.id, c.req.valid('json')));
  });
  api.delete('/branches/:branchId', async (c) => {
    const branch = await chatOf(c).getOwnedBranch(c.req.param('branchId'));
    // Through the tree's Durable Object: it owns the generations it has to stop first.
    return session(c.env, branch.treeId).fetch(
      sessionUrl('/delete-branch', {
        treeId: branch.treeId,
        branchId: branch.id,
        ...accountParams(c.var.account),
      }),
      { method: 'POST' },
    );
  });
  api.get(
    '/branches/:branchId/context',
    sameOriginOnly,
    validateQuery(contextQuerySchema),
    async (c) => {
      const q = c.req.valid('query');
      const keys = await keysOf(c);
      const chat = chatOf(c, keys);
      const branch = await chat.getOwnedBranch(c.req.param('branchId'));
      // resolve=true may generate summaries (billed on the built-in provider, which
      // summarizes its own branches); a plain plan only counts tokens.
      if (q.resolve) {
        await assertMember(c.env, c.var.account);
        await assertCanSpend(c.env, c.var.account, branch.providerId);
        await enforceRateLimit(c, keys, 'chat', branch.providerId);
      }
      const res = await chat.planContext(branch.id, q.nodeId ?? null, {
        resolveSummaries: q.resolve,
        signal: c.req.raw.signal,
      });
      return c.json(res);
    },
  );

  // ---- messages (delegated to the tree's Durable Object)
  api.post(
    '/branches/:branchId/messages',
    sameOriginOnly,
    validateJson(sendMessageRequestSchema),
    async (c) => {
      const keys = await keysOf(c);
      const { account } = c.var;
      const chat = chatOf(c, keys);
      const branch = await chat.getOwnedBranch(c.req.param('branchId'));
      // The route is the Durable Object's only way in, so this gate covers it.
      await assertMember(c.env, account);
      assertGenerationAllowed(chat.deps.providers, branch.providerId, branch.model, {
        userKeys: !isMetered(account, branch.providerId),
      });
      await assertCanSpend(c.env, account, branch.providerId);
      await enforceRateLimit(c, keys, 'chat', branch.providerId);
      // The Durable Object gets the still-sealed cookie value in the body (never
      // a header, which request logs may capture) and opens it itself.
      const body: SessionSendBody = {
        ...c.req.valid('json'),
        account,
        ...(keys ? { sealedKeys: keys.sealed } : {}),
      };
      return session(c.env, branch.treeId).fetch(
        sessionUrl('/send', { treeId: branch.treeId, branchId: branch.id }),
        { method: 'POST', body: JSON.stringify(body) },
      );
    },
  );
  api.get('/nodes/:nodeId/stream', async (c) => {
    const node = await chatOf(c).getOwnedNode(c.req.param('nodeId'));
    return session(c.env, node.treeId).fetch(
      sessionUrl('/stream', {
        treeId: node.treeId,
        nodeId: node.id,
        ...accountParams(c.var.account),
      }),
    );
  });
  api.post('/nodes/:nodeId/cancel', async (c) => {
    const node = await chatOf(c).getOwnedNode(c.req.param('nodeId'));
    return session(c.env, node.treeId).fetch(
      sessionUrl('/cancel', {
        treeId: node.treeId,
        nodeId: node.id,
        ...accountParams(c.var.account),
      }),
      { method: 'POST' },
    );
  });

  // ---- reviews: streamed straight from the Worker. Nothing is persisted, so
  // there is no Durable Object run to reconnect to; a dropped client aborts
  // the upstream request (stops billing) through the request signal.
  api.post(
    '/nodes/:nodeId/review',
    sameOriginOnly,
    validateJson(reviewRequestSchema),
    async (c) => {
      const req = c.req.valid('json');
      const keys = await keysOf(c);
      const chat = chatOf(c, keys);
      const node = await chat.getOwnedNode(c.req.param('nodeId'));
      await assertMember(c.env, c.var.account);
      // The client picks the reviewer model here, so the allowlist is what bounds it.
      // The review is metered iff the reviewer is the built-in provider.
      assertGenerationAllowed(chat.deps.providers, req.providerId, req.model, {
        userKeys: !isMetered(c.var.account, req.providerId),
      });
      await assertCanSpend(c.env, c.var.account, req.providerId);
      const prepared = await chat.prepareReview(node.id, req);
      await enforceRateLimit(c, keys, 'chat', req.providerId);

      const encoder = new TextEncoder();
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      const signal = c.req.raw.signal;
      const write = (frame: string) => writer.write(encoder.encode(frame)).catch(() => undefined);
      const pump = async () => {
        const keepalive = setInterval(() => void write(sseKeepAliveFrame()), REVIEW_KEEPALIVE_MS);
        try {
          for await (const event of chat.runReview(prepared, signal)) await write(sseFrame(event));
        } finally {
          clearInterval(keepalive);
          await writer.close().catch(() => undefined);
        }
      };
      c.executionCtx.waitUntil(pump());
      return sseResponse(readable);
    },
  );

  // ---- shares
  api.get('/shares', async (c) =>
    c.json(await shareService(c.env, c.req.url, c.var.accountId).list()),
  );
  api.post('/shares', validateJson(createShareRequestSchema), async (c) =>
    c.json(await shareService(c.env, c.req.url, c.var.accountId).create(c.req.valid('json')), 201),
  );
  api.patch('/shares/:shareId', validateJson(updateShareRequestSchema), async (c) =>
    c.json(
      await shareService(c.env, c.req.url, c.var.accountId).update(
        c.req.param('shareId'),
        c.req.valid('json'),
      ),
    ),
  );
  api.post('/shares/:shareId/republish', async (c) => {
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

  // ---- export (Markdown / self-contained HTML, built on the viewer renderer)
  api.get('/export', validateQuery(exportQuerySchema), async (c) => {
    const q = c.req.valid('query');
    const detail = await chatOf(c).getTreeDetail(q.treeId);
    const result = projectShare({
      tree: detail.tree,
      branches: detail.branches,
      nodes: detail.nodes,
      scope: q.scope,
      targetNodeId: q.scope === 'tree' ? null : (q.nodeId ?? null),
      includeAncestors: q.includeAncestors,
      title: null,
      now: new Date().toISOString(),
      includePrivate: q.includePrivate,
    });
    if (!result.ok) {
      if (result.reason === 'target_not_found') throw new NotFoundError('Node');
      throw new ValidationError(
        result.reason === 'target_private'
          ? 'That message is inside a private branch (pass includePrivate=true)'
          : 'Nothing to export',
      );
    }
    const name = slug(result.payload.title);
    if (q.format === 'md') {
      return c.body(payloadToMarkdown(result.payload), 200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}.md"`,
      });
    }
    const html = renderViewerPage(result.payload, { variant: 'export', csp: await viewerCsp() });
    return c.body(html, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}.html"`,
    });
  });

  return api;
}

function session(env: AppEnv, treeId: string) {
  return env.TREE_SESSION.get(env.TREE_SESSION.idFromName(treeId));
}

function sessionUrl(path: string, params: Record<string, string>): string {
  return `https://tree-session${path}?${new URLSearchParams(params).toString()}`;
}

export function slug(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
    .slice(0, 60);
  return s || 'tangent-export';
}
