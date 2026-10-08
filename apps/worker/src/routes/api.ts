import {
  DomainError,
  NotFoundError,
  projectShare,
  ValidationError,
  type ChatService,
  type HeldCandidate,
} from '@tangent/core';
import { payloadToMarkdown, renderViewerPage, viewerCsp } from '@tangent/render';
import {
  backupFileName,
  candidateRequestSchema,
  contextLimitsQuerySchema,
  createBranchRequestSchema,
  createLinkRequestSchema,
  createShareRequestSchema,
  createTreeRequestSchema,
  exportFileStem,
  exportQuerySchema,
  MAX_BACKUP_BYTES,
  reviewRequestSchema,
  sendMessageRequestSchema,
  treeBackupSchema,
  updateBranchRequestSchema,
  updateLinkRequestSchema,
  updateSettingsRequestSchema,
  updateShareRequestSchema,
  updateTreeRequestSchema,
  type CandidateEvent,
  type CopyToLearnResponse,
  type MeResponse,
} from '@tangent/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { ensureAccountRow, resolveAccount } from '../auth/account.js';
import { isAdmin } from '../auth/admin.js';
import { accountDeletionRoutes } from '../auth/delete-account.js';
import { enforceRateLimit, sameOriginOnly } from '../byok/guard.js';
import { assertCanGenerate, membershipNeededFor } from '../billing/gate.js';
import { membershipFor } from '../billing/membership.js';
import { readKeys, requireReadableKeys, type UserKeys } from '../byok/keys.js';
import {
  accountParams,
  type SessionCommitBody,
  type SessionHoldBody,
  type SessionHoldResponse,
  type SessionSendBody,
} from '../do/tree-session.js';
import {
  isPoolFunded,
  usesUserKeys,
  type AppBindings,
  type AppContext,
  type AppEnv,
} from '../env.js';
import { validateJson, validateQuery } from '../http/errors.js';
import { generationLimits, inputBudgetResponse } from '../input-limit.js';
import { sseFrame, sseKeepAliveFrame, sseResponse } from '../http/sse.js';
import { purgeShare } from '../share/cache.js';
import {
  builtInAvailable,
  canShare,
  chatService,
  providersFor,
  shareService,
} from '../services.js';
import { withUsageFactors } from '../tiers.js';
import { keyRoutes } from './key.js';

/** Keepalive of the streams served straight from the Worker (reviews, compare candidates). */
const REVIEW_KEEPALIVE_MS = 15_000;

/** The preview plans like a send with power's limits (`contextLimitsQuerySchema`) when given. */
const contextQuerySchema = contextLimitsQuerySchema.extend({
  nodeId: z.string().min(1).max(64).optional(),
  resolve: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

/**
 * The caller's ChatService. `keys` are the user's own provider keys (unused
 * by Learn on credit or the pool); the usage meter of the built-in provider
 * defers its work to the request's `waitUntil`. `generating`: the service
 * will call a model, so a pool-funded account gets the pool's restrictions;
 * build it after `assertCanGenerate`, which settles who pays.
 */
function chatOf(
  c: AppContext,
  keys: Extract<UserKeys, { state: 'ok' }> | null = null,
  generating = false,
): ChatService {
  return chatService(c.env, c.var.account, {
    ...(keys ? { apiKeys: keys.keys } : {}),
    defer: (p) => c.executionCtx.waitUntil(p),
    generating,
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
 * generate pass `assertCanGenerate` (billing/gate.ts): who pays (a Learn send on
 * spent credit moves to the open pool), the membership for the user's own
 * keys, in Learn or power mode (402 `membership_required`, when one is
 * required; Tangent credit and the pool need none), then the credit (402
 * `payment_required`) or the pool's rules. Every other route stays open
 * without a membership.
 */
export function apiRoutes(): Hono<AppBindings> {
  const api = new Hono<AppBindings>();

  // The membership rides along so the apps can gate at startup without a second
  // request (one query, none when no membership is required); so does whether
  // the user may share (one query while sharing is off, see canShare).
  api.get('/me', async (c) => {
    const { identity, account } = c.var;
    const [sharing, membership] = await Promise.all([
      canShare(c.env, identity.userId),
      membershipFor(c.env, account),
    ]);
    return c.json({
      email: identity.email,
      userId: identity.userId,
      devMode: identity.devMode,
      accountId: account.id,
      mode: account.mode,
      operatorKeys: account.operatorKeys,
      builtInCredit: builtInAvailable(c.env),
      sharing,
      isAdmin: isAdmin(c.env, identity),
      membership,
      membershipNeededFor: membershipNeededFor(account, membership),
      // The featured wall is a stub (routes/featured.ts): never offered.
      featuredConversations: false,
    } satisfies MeResponse);
  });

  // Power lists the built-in endpoint twice: on the user's key and as Tangent credit (`funding`).
  // The Max model of each entry listing both tiers carries its `usageFactor` (tiers.ts).
  api.get('/providers', async (c) => {
    // An unreadable key cookie simply counts as no user keys here; /key/status clears it.
    const keys = usesUserKeys(c.var.account) ? await readKeys(c) : null;
    const apiKeys = keys?.state === 'ok' ? keys.keys : undefined;
    return c.json(await withUsageFactors(c.env, providersFor(c.env, c.var.account, apiKeys)));
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
  // A tree that names no provider starts on the default route, whose first choice is a
  // provider the user has a key for: the key cookie is read for it (leniently: an
  // unreadable cookie counts as no keys, since nothing is sent here).
  api.post('/trees', validateJson(createTreeRequestSchema), async (c) => {
    const req = c.req.valid('json');
    const keys =
      req.providerId === undefined && usesUserKeys(c.var.account) ? await readKeys(c) : null;
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
  api.delete('/trees/:treeId', async (c) => {
    const treeId = c.req.param('treeId');
    return session(c.env, treeId).fetch(
      sessionUrl('/delete-tree', { treeId, ...accountParams(c.var.account) }),
      { method: 'POST' },
    );
  });
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
    validateJson(treeBackupSchema),
    async (c) => c.json(await chatOf(c).importBackup(c.req.valid('json')), 201),
  );
  // "Create a copy in Learn" (docs/DECISIONS.md "Read-only power without a
  // membership"): the caller's power tree, exported by the power service (404
  // for anyone else's), imported by the service of the same user's Learn
  // account, so it is adapted like any import into Learn. Neither generates,
  // so there is no gate: no membership, no credit, no model call. The power
  // tree is only read.
  api.post('/trees/:treeId/copy-to-learn', importLimited, async (c) => {
    const { account, identity } = c.var;
    if (account.mode !== 'power')
      throw new DomainError('bad_request', 'Only a power conversation can be copied into Learn');
    const backup = await chatOf(c).exportBackup(c.req.param('treeId'));
    // Learn's account as Learn's own requests on the user's key resolve it: never on credit.
    const learn = resolveAccount(c.env, identity, { mode: 'simple', payment: 'own-key' });
    await ensureAccountRow(c.env.DB, learn);
    const lesson = await chatService(c.env, learn, {
      defer: (p) => c.executionCtx.waitUntil(p),
    }).importBackup(backup);
    return c.json(
      { treeId: lesson.tree.id, title: lesson.tree.title } satisfies CopyToLearnResponse,
      201,
    );
  });

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
    const branch = await chat.getOwnedBranch(c.req.param('branchId'));
    return c.json(await inputBudgetResponse(c.env, c.var.account, chat, branch.id));
  });

  // ---- messages (delegated to the tree's Durable Object)
  api.post('/branches/:branchId/messages', validateJson(sendMessageRequestSchema), async (c) => {
    const keys = await keysOf(c);
    const req = c.req.valid('json');
    const chat = chatOf(c, keys);
    const branch = await chat.getOwnedBranch(c.req.param('branchId'));
    // The route is the Durable Object's only way in, so this gate covers it. On the
    // pool, the Durable Object reserves the reply before writing any node.
    const account = await assertCanGenerate(c, {
      purpose: 'send',
      providerId: branch.providerId,
      funding: branch.funding,
      model: branch.model,
      keys,
      content: req.content,
    });
    // "Check sources" needs a provider that can search; the pool's holds don't cover a search.
    if (req.ground === 'required' && (isPoolFunded(account) || !chat.canSearch(branch))) {
      throw new ValidationError("This conversation's model can't check sources");
    }
    // The Durable Object gets the still-sealed cookie value in the body (never
    // a header, which request logs may capture) and opens it itself. The output
    // cap and the input limit are power's settings, clamped on Tangent credit:
    // Learn's replies keep its own (input-limit.ts).
    const { maxOutputTokens, maxInputTokens, inputOverflow, ...rest } = req;
    const body: SessionSendBody = {
      ...rest,
      ...generationLimits(c.env, account, branch.funding, {
        maxOutputTokens,
        maxInputTokens,
        inputOverflow,
      }),
      account,
      ...(keys ? { sealedKeys: keys.sealed } : {}),
    };
    return session(c.env, branch.treeId).fetch(
      sessionUrl('/send', { treeId: branch.treeId, branchId: branch.id }),
      { method: 'POST', body: JSON.stringify(body) },
    );
  });
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
  api.post('/nodes/:nodeId/review', validateJson(reviewRequestSchema), async (c) => {
    const req = c.req.valid('json');
    const keys = await keysOf(c);
    let chat = chatOf(c, keys);
    const node = await chat.getOwnedNode(c.req.param('nodeId'));
    const branch = await chat.getOwnedBranch(node.branchId);
    // The client picks the reviewer model here, so the allowlist is what bounds it.
    // The review is metered iff the reviewer is on Tangent credit (its funding). The
    // context is resolved like a send on the node's branch, so missing summaries are
    // generated on that branch's route: its credit is checked too. Never on the pool (403).
    await assertCanGenerate(c, {
      purpose: 'review',
      providerId: req.providerId,
      funding: req.funding ?? 'own-key',
      model: req.model,
      alsoSpendsOn: { providerId: branch.providerId, funding: branch.funding },
      keys,
    });
    chat = chatOf(c, keys, true);
    // Power's reply length and input limit, clamped like a send's on the reviewer's
    // route (it is the one that reads the conversation): Tangent credit's input cap
    // applies with or without a setting; Learn takes none (input-limit.ts).
    const prepared = await chat.prepareReview(
      node.id,
      req,
      generationLimits(c.env, c.var.account, req.funding ?? 'own-key', req),
    );

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
  });

  // ---- compare (shared/compare.ts): each candidate streams straight from the
  // Worker, like a review, and nothing enters the tree until the user picks one.
  // A finished candidate is held by the tree's Durable Object (for
  // CANDIDATE_TTL_MS), which also appends the picked one, under its send lock.
  api.post('/branches/:branchId/candidates', validateJson(candidateRequestSchema), async (c) => {
    const req = c.req.valid('json');
    const keys = await keysOf(c);
    let chat = chatOf(c, keys);
    const branch = await chat.getOwnedBranch(c.req.param('branchId'));
    // The route as ChatService resolves it (`requestedRoute`): absent = the branch's,
    // and Learn's fixed funding (the branch's) always wins.
    const learn = c.var.account.mode === 'simple';
    const route = req.providerId
      ? { providerId: req.providerId, funding: req.funding ?? ('own-key' as const) }
      : { providerId: branch.providerId, funding: req.funding ?? branch.funding };
    if (learn && route.providerId !== branch.providerId)
      throw new ValidationError("Compare runs on the lesson's own provider");
    if (learn) route.funding = branch.funding;
    // The client picks the model, so the allowlist is what bounds it (Learn: its tiers).
    // The context is resolved like a send on the branch, so missing summaries are
    // generated on the branch's route: its credit is checked too. Never on the pool (403).
    await assertCanGenerate(c, {
      purpose: 'compare',
      ...route,
      model: req.model,
      alsoSpendsOn: { providerId: branch.providerId, funding: branch.funding },
      keys,
      content: req.content,
    });
    chat = chatOf(c, keys, true);
    // Power's reply length and input limit, clamped like a send's on the candidate's
    // route; Learn takes none (input-limit.ts).
    const prepared = await chat.prepareCandidate(
      branch.id,
      req,
      generationLimits(c.env, c.var.account, route.funding, req),
    );
    const accountId = c.var.account.id;

    /** The wire `done`: the candidate, once the Durable Object holds it for the commit. */
    const hold = async (candidate: HeldCandidate): Promise<CandidateEvent> => {
      try {
        const res = await session(c.env, branch.treeId).fetch(
          sessionUrl('/hold-candidate', { treeId: branch.treeId }),
          {
            method: 'POST',
            body: JSON.stringify({ candidate, accountId } satisfies SessionHoldBody),
          },
        );
        if (!res.ok) throw new Error(`hold-candidate answered ${res.status}`);
        const { expiresAt } = (await res.json()) as SessionHoldResponse;
        return {
          type: 'done',
          candidateId: candidate.id,
          providerId: candidate.providerId,
          funding: candidate.funding,
          model: candidate.model,
          usage: candidate.usage,
          sources: candidate.sources,
          expiresAt,
        };
      } catch (err) {
        console.error('Holding a compare candidate failed', err);
        return { type: 'error', message: 'This answer could not be kept; try again.' };
      }
    };

    const encoder = new TextEncoder();
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const signal = c.req.raw.signal;
    const write = (frame: string) => writer.write(encoder.encode(frame)).catch(() => undefined);
    const pump = async () => {
      const keepalive = setInterval(() => void write(sseKeepAliveFrame()), REVIEW_KEEPALIVE_MS);
      try {
        for await (const event of chat.runCandidate(prepared, signal)) {
          await write(sseFrame(event.type === 'done' ? await hold(event.candidate) : event));
        }
      } finally {
        clearInterval(keepalive);
        await writer.close().catch(() => undefined);
      }
    };
    c.executionCtx.waitUntil(pump());
    return sseResponse(readable);
  });
  // Appends the picked candidate (the server's copy, so the model and usage are
  // real). It may auto-title the branch, a model call, so the user's keys ride
  // along sealed, as for a send. 403 on the open pool, where compare is refused.
  api.post('/branches/:branchId/candidates/:candidateId/commit', async (c) => {
    const branch = await chatOf(c).getOwnedBranch(c.req.param('branchId'));
    if (c.var.account.funding === 'pool')
      throw new DomainError('pool_unavailable', "Compare isn't available on the open pool");
    const keys = await keysOf(c);
    const body: SessionCommitBody = {
      candidateId: c.req.param('candidateId'),
      branchId: branch.id,
      account: c.var.account,
      ...(keys ? { sealedKeys: keys.sealed } : {}),
    };
    return session(c.env, branch.treeId).fetch(
      sessionUrl('/commit-candidate', { treeId: branch.treeId }),
      { method: 'POST', body: JSON.stringify(body) },
    );
  });

  // ---- links (cross-references between two messages of a tree). Never
  // generate, so no gate: read-only power branches can be linked too.
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

  // ---- shares
  // With sharing off (no DMCA agent registered) only admins and the users the operator
  // allowed publish (canShare): for anyone else create, edit and republish are 403.
  // Listing, revoking and deleting stay open so owners can take old links down.
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
  api.post('/shares', sharingOn, validateJson(createShareRequestSchema), async (c) =>
    c.json(await shareService(c.env, c.req.url, c.var.accountId).create(c.req.valid('json')), 201),
  );
  api.patch('/shares/:shareId', sharingOn, validateJson(updateShareRequestSchema), async (c) =>
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

function session(env: AppEnv, treeId: string) {
  return env.TREE_SESSION.get(env.TREE_SESSION.idFromName(treeId));
}

function sessionUrl(path: string, params: Record<string, string>): string {
  return `https://tree-session${path}?${new URLSearchParams(params).toString()}`;
}
