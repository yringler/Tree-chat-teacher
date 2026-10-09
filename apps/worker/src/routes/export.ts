import { DomainError, NotFoundError, projectShare, ValidationError } from '@tangent/core';
import { payloadToMarkdown, renderViewerPage, viewerCsp } from '@tangent/render';
import {
  API_ROUTES,
  backupFileName,
  exportFileStem,
  MAX_BACKUP_BYTES,
  type CopyToLearnResponse,
} from '@tangent/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import { resolveAccount } from '../auth/account.js';
import { enforceRateLimit } from '../byok/guard.js';
import type { AppBindings } from '../env.js';
import { validateJson, validateQuery } from '../http/errors.js';
import { chatService } from '../registries.js';
import { chatOf } from './request-chat.js';

/**
 * A tree out of and into the account: its JSON backup and import, the copy
 * of a power tree into Learn, and the Markdown or HTML export. None generates.
 */
export function exportRoutes(): Hono<AppBindings> {
  const api = new Hono<AppBindings>();

  api.get('/trees/:treeId/backup', async (c) => {
    const backup = await chatOf(c).exportBackup(c.req.param('treeId'));
    return c.json(backup, 200, {
      'Content-Disposition': `attachment; filename="${backupFileName(backup.tree.title)}"`,
    });
  });
  // Each import writes a whole tree: rate limited per account, and the size cap is
  // checked on the bytes as they arrive, before the JSON is parsed.
  const importLimited = createMiddleware<AppBindings>(async (c, next) => {
    await enforceRateLimit(c, null, 'import');
    await next();
  });
  api.post(
    '/import',
    importLimited,
    bodyLimit({
      maxSize: MAX_BACKUP_BYTES,
      onError: () => {
        throw new ValidationError(
          `This backup is too large to import (the limit is ${MAX_BACKUP_BYTES / (1024 * 1024)} MB)`,
        );
      },
    }),
    validateJson(API_ROUTES.importBackup),
    async (c) => c.json(await chatOf(c).importBackup(c.req.valid('json')), 201),
  );
  // "Create a copy in Learn", the way on for a power tree that is read-only
  // without a membership: the caller's power tree, exported by the power service (404
  // for anyone else's), imported into the same account by a Learn-mode
  // service, so it is adapted like any import into Learn. Neither generates,
  // so there is no gate: no membership, no credit, no model call. The power
  // tree is only read.
  api.post('/trees/:treeId/copy-to-learn', importLimited, async (c) => {
    const { account, identity } = c.var;
    if (account.mode !== 'power')
      throw new DomainError('bad_request', 'Only a power conversation can be copied into Learn');
    const backup = await chatOf(c).exportBackup(c.req.param('treeId'));
    // The account as Learn's own requests on the user's key resolve it: never on credit.
    const learn = resolveAccount(c.env, identity, { mode: 'simple', payment: 'own-key' });
    const lesson = await chatService(c.env, learn, {
      defer: (p) => c.executionCtx.waitUntil(p),
    }).importBackup(backup);
    return c.json(
      { treeId: lesson.tree.id, title: lesson.tree.title } satisfies CopyToLearnResponse,
      201,
    );
  });

  // Markdown or a self-contained HTML page, built on the viewer renderer.
  api.get('/export', validateQuery(API_ROUTES.exportTree), async (c) => {
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
    const name = exportFileStem(result.payload.title);
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
