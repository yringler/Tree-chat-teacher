import { NotFoundError, projectShare, ValidationError } from '@tangent/core';
import { payloadToMarkdown, renderViewerPage, viewerCsp } from '@tangent/render';
import {
  createBranchRequestSchema,
  createShareRequestSchema,
  createTreeRequestSchema,
  exportQuerySchema,
  sendMessageRequestSchema,
  treeBackupSchema,
  updateBranchRequestSchema,
  updateShareRequestSchema,
  updateTreeRequestSchema,
  type MeResponse,
} from '@tangent/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings, AppEnv } from '../env.js';
import { validateJson, validateQuery } from '../http/errors.js';
import { purgeShare } from '../share/cache.js';
import { chatService, providerRegistry, shareService } from '../services.js';

const contextQuerySchema = z.object({
  nodeId: z.string().min(1).max(64).optional(),
  resolve: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

/** Owner API. Mounted under /api behind the Access middleware. */
export function apiRoutes(): Hono<AppBindings> {
  const api = new Hono<AppBindings>();

  api.get('/me', (c) => {
    const { email, devMode } = c.var.identity;
    return c.json({ email, devMode } satisfies MeResponse);
  });

  api.get('/providers', (c) => c.json(providerRegistry(c.env).list()));

  // ---- trees
  api.get('/trees', async (c) => c.json(await chatService(c.env).listTrees()));
  api.post('/trees', validateJson(createTreeRequestSchema), async (c) =>
    c.json(await chatService(c.env).createTree(c.req.valid('json')), 201),
  );
  api.get('/trees/:treeId', async (c) =>
    c.json(await chatService(c.env).getTreeDetail(c.req.param('treeId'))),
  );
  api.patch('/trees/:treeId', validateJson(updateTreeRequestSchema), async (c) =>
    c.json(await chatService(c.env).updateTree(c.req.param('treeId'), c.req.valid('json'))),
  );
  api.delete('/trees/:treeId', async (c) => {
    await chatService(c.env).deleteTree(c.req.param('treeId'));
    return c.body(null, 204);
  });
  api.get('/trees/:treeId/backup', async (c) => {
    const backup = await chatService(c.env).exportBackup(c.req.param('treeId'));
    return c.json(backup, 200, {
      'Content-Disposition': `attachment; filename="${slug(backup.tree.title)}.tangent.json"`,
    });
  });
  api.post('/import', validateJson(treeBackupSchema), async (c) =>
    c.json(await chatService(c.env).importBackup(c.req.valid('json')), 201),
  );

  // ---- branches
  api.post('/branches', validateJson(createBranchRequestSchema), async (c) =>
    c.json(await chatService(c.env).createBranch(c.req.valid('json')), 201),
  );
  api.patch('/branches/:branchId', validateJson(updateBranchRequestSchema), async (c) =>
    c.json(await chatService(c.env).updateBranch(c.req.param('branchId'), c.req.valid('json'))),
  );
  api.get('/branches/:branchId/context', validateQuery(contextQuerySchema), async (c) => {
    const q = c.req.valid('query');
    const res = await chatService(c.env).planContext(c.req.param('branchId'), q.nodeId ?? null, {
      resolveSummaries: q.resolve,
      signal: c.req.raw.signal,
    });
    return c.json(res);
  });

  // ---- messages (delegated to the tree's Durable Object)
  api.post('/branches/:branchId/messages', validateJson(sendMessageRequestSchema), async (c) => {
    const branchId = c.req.param('branchId');
    const branch = await chatService(c.env).deps.repos.trees.getBranch(branchId);
    if (!branch) throw new NotFoundError('Branch');
    return session(c.env, branch.treeId).fetch(
      sessionUrl('/send', { treeId: branch.treeId, branchId }),
      { method: 'POST', body: JSON.stringify(c.req.valid('json')) },
    );
  });
  api.get('/nodes/:nodeId/stream', async (c) => {
    const node = await nodeOr404(c.env, c.req.param('nodeId'));
    return session(c.env, node.treeId).fetch(
      sessionUrl('/stream', { treeId: node.treeId, nodeId: node.id }),
    );
  });
  api.post('/nodes/:nodeId/cancel', async (c) => {
    const node = await nodeOr404(c.env, c.req.param('nodeId'));
    return session(c.env, node.treeId).fetch(
      sessionUrl('/cancel', { treeId: node.treeId, nodeId: node.id }),
      { method: 'POST' },
    );
  });

  // ---- shares
  api.get('/shares', async (c) => c.json(await shareService(c.env, c.req.url).list()));
  api.post('/shares', validateJson(createShareRequestSchema), async (c) =>
    c.json(await shareService(c.env, c.req.url).create(c.req.valid('json')), 201),
  );
  api.patch('/shares/:shareId', validateJson(updateShareRequestSchema), async (c) =>
    c.json(
      await shareService(c.env, c.req.url).update(c.req.param('shareId'), c.req.valid('json')),
    ),
  );
  api.post('/shares/:shareId/republish', async (c) => {
    const s = await shareService(c.env, c.req.url).republish(c.req.param('shareId'));
    c.executionCtx.waitUntil(purgeShare(s.token, [s.version - 1]));
    return c.json(s);
  });
  api.post('/shares/:shareId/revoke', async (c) => {
    const s = await shareService(c.env, c.req.url).revoke(c.req.param('shareId'));
    c.executionCtx.waitUntil(purgeShare(s.token, [s.version - 1, s.version]));
    return c.json(s);
  });

  // ---- export (Markdown / self-contained HTML, built on the viewer renderer)
  api.get('/export', validateQuery(exportQuerySchema), async (c) => {
    const q = c.req.valid('query');
    const detail = await chatService(c.env).getTreeDetail(q.treeId);
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

async function nodeOr404(env: AppEnv, nodeId: string) {
  const node = await chatService(env).deps.repos.trees.getNode(nodeId);
  if (!node) throw new NotFoundError('Node');
  return node;
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
