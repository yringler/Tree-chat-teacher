import type { Branch, SharePayload, ShareSummary, StreamEvent, TreeDetail } from '@tangent/shared';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AppEnv } from '../src/env.js';

const BASE = 'https://tangent.example.com';

function call(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set('Content-Type', 'application/json');
  return exports.default.fetch(
    new Request(BASE + path, {
      ...rest,
      headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    }),
  );
}

async function ok<T>(res: Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  expect(r.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function send(branchId: string, content: string) {
  const res = await call(`/api/branches/${branchId}/messages`, {
    method: 'POST',
    json: { content },
  });
  const events = (await res.text())
    .split('\n\n')
    .map((f) => f.split('\n').find((l) => l.startsWith('data:')))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(5)) as StreamEvent);
  const start = events[0];
  if (start?.type !== 'start') throw new Error('no start');
  return start;
}

async function seed() {
  const detail = await ok<TreeDetail>(
    call('/api/trees', { method: 'POST', json: { title: 'Shared <tree>' } }),
    201,
  );
  const trunk = detail.tree.trunkBranchId;
  const root = await send(trunk, 'PUBLIC-ROOT question');
  const side = await ok<Branch>(
    call('/api/branches', {
      method: 'POST',
      json: { fromNodeId: root.assistantNode.id, title: 'Side' },
    }),
    201,
  );
  const sideMsg = await send(side.id, 'PUBLIC-SIDE');
  const secret = await ok<Branch>(
    call('/api/branches', {
      method: 'POST',
      json: { fromNodeId: root.assistantNode.id, isPrivate: true },
    }),
    201,
  );
  await send(secret.id, 'PRIVATE-MARKER');
  return { detail, trunk, root, side, sideMsg, secret };
}

describe('public shares', () => {
  it('serves a snapshot viewer page and DTO without leaking ids or private content', async () => {
    const { detail, root, trunk } = await seed();
    const share = await ok<ShareSummary>(
      call('/api/shares', { method: 'POST', json: { treeId: detail.tree.id, scope: 'tree' } }),
      201,
    );
    expect(share.url).toBe(`${BASE}/s/${share.token}`);

    const page = await exports.default.fetch(`${BASE}/s/${share.token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(page.headers.get('Cache-Control')).toBe('no-store');
    const html = await page.text();
    expect(html).toContain('og:title');
    expect(html).toContain('Shared &lt;tree&gt;');
    expect(html).toContain('PUBLIC-SIDE');
    expect(html).not.toContain('PRIVATE-MARKER');
    for (const id of [detail.tree.id, trunk, root.assistantNode.id, root.userNode.id]) {
      expect(html).not.toContain(id);
    }

    const data = await exports.default.fetch(`${BASE}/s/${share.token}/data.json`);
    const payload = (await data.json()) as SharePayload;
    const json = JSON.stringify(payload);
    expect(json).not.toContain('PRIVATE-MARKER');
    expect(json).not.toContain(detail.tree.id);
    expect(json).not.toMatch(
      /"(providerId|model|usage|inputTokens|contextMode|isPrivate|id|treeId|branchId)"/,
    );

    // Snapshot is immutable until republish.
    await send(trunk, 'AFTER-SHARE');
    expect(
      await (await exports.default.fetch(`${BASE}/s/${share.token}/data.json`)).text(),
    ).not.toContain('AFTER-SHARE');
    const republished = await ok<ShareSummary>(
      call(`/api/shares/${share.id}/republish`, { method: 'POST' }),
    );
    expect(republished.version).toBe(2);
    expect(
      await (await exports.default.fetch(`${BASE}/s/${share.token}/data.json`)).text(),
    ).toContain('AFTER-SHARE');

    // Revocation is immediate.
    await ok(call(`/api/shares/${share.id}/revoke`, { method: 'POST' }));
    expect((await exports.default.fetch(`${BASE}/s/${share.token}`)).status).toBe(410);
    expect((await exports.default.fetch(`${BASE}/s/${share.token}/data.json`)).status).toBe(410);

    const list = await ok<ShareSummary[]>(call('/api/shares'));
    const listed = list.find((s) => s.id === share.id)!;
    expect(listed.state).toBe('revoked');
    expect(listed.viewCount).toBeGreaterThanOrEqual(1);
  });

  it('deleting a share takes its link down and removes it from the list', async () => {
    const { detail } = await seed();
    const share = await ok<ShareSummary>(
      call('/api/shares', { method: 'POST', json: { treeId: detail.tree.id, scope: 'tree' } }),
      201,
    );
    expect((await exports.default.fetch(`${BASE}/s/${share.token}`)).status).toBe(200);

    expect((await call(`/api/shares/${share.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await exports.default.fetch(`${BASE}/s/${share.token}`)).status).toBe(404);
    expect((await exports.default.fetch(`${BASE}/s/${share.token}/data.json`)).status).toBe(404);
    const list = await ok<ShareSummary[]>(call('/api/shares'));
    expect(list.map((s) => s.id)).not.toContain(share.id);
    expect((await call(`/api/shares/${share.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('live shares follow the tree; path and subtree scopes stay in scope', async () => {
    const { detail, trunk, sideMsg, root } = await seed();
    const live = await ok<ShareSummary>(
      call('/api/shares', {
        method: 'POST',
        json: { treeId: detail.tree.id, scope: 'tree', mode: 'live' },
      }),
      201,
    );
    await send(trunk, 'LIVE-NEW');
    expect(
      await (await exports.default.fetch(`${BASE}/s/${live.token}/data.json`)).text(),
    ).toContain('LIVE-NEW');

    const path = await ok<ShareSummary>(
      call('/api/shares', {
        method: 'POST',
        json: { treeId: detail.tree.id, scope: 'path', nodeId: sideMsg.assistantNode.id },
      }),
      201,
    );
    const pathPayload = (await (
      await exports.default.fetch(`${BASE}/s/${path.token}/data.json`)
    ).json()) as SharePayload;
    expect(pathPayload.branches).toHaveLength(1);
    expect(JSON.stringify(pathPayload)).toContain('PUBLIC-ROOT');
    expect(JSON.stringify(pathPayload)).not.toContain('LIVE-NEW');

    const subtree = await ok<ShareSummary>(
      call('/api/shares', {
        method: 'POST',
        json: {
          treeId: detail.tree.id,
          scope: 'subtree',
          nodeId: sideMsg.userNode.id,
          includeAncestors: true,
        },
      }),
      201,
    );
    const sub = (await (
      await exports.default.fetch(`${BASE}/s/${subtree.token}/data.json`)
    ).json()) as SharePayload;
    expect(JSON.stringify(sub.branches)).toContain('PUBLIC-SIDE');
    expect(JSON.stringify(sub.branches)).not.toContain('PUBLIC-ROOT');
    expect(JSON.stringify(sub.context)).toContain('PUBLIC-ROOT');
    void root;
  });

  it('refuses shares of private branches and 404s unknown tokens', async () => {
    const { detail, secret } = await seed();
    const tree = await ok<TreeDetail>(call(`/api/trees/${detail.tree.id}`));
    const secretNode = tree.nodes.find((n) => n.branchId === secret.id)!;
    const res = await call('/api/shares', {
      method: 'POST',
      json: { treeId: detail.tree.id, scope: 'subtree', nodeId: secretNode.id },
    });
    expect(res.status).toBe(400);
    expect((await exports.default.fetch(`${BASE}/s/not-a-real-token`)).status).toBe(404);
  });

  it('public routes need no Access even when Access is configured', async () => {
    // /api is protected (dev bypass in tests), /s is always public: request without any auth header.
    const r = await exports.default.fetch(`${BASE}/s/whatever/data.json`);
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });
});

describe('sharing off (no DMCA agent registered)', () => {
  // Same database as the suite above; only DMCA_AGENT_REGISTERED differs. The dev bypass
  // follows the flag alone (it is never on the allowlist); test/admin.test.ts covers the
  // admins and the users the operator allows.
  const off = { ...env, DMCA_AGENT_REGISTERED: 'false' } as AppEnv;
  const app = createApp();
  async function callOff(
    path: string,
    init: RequestInit & { json?: unknown } = {},
  ): Promise<Response> {
    const { json, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (json !== undefined) headers.set('Content-Type', 'application/json');
    const ctx = createExecutionContext();
    const res = await app.request(
      BASE + path,
      { ...rest, headers, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) },
      off,
      ctx,
    );
    // A 204 (DELETE) must keep a null body.
    const out = new Response(res.status === 204 ? null : await res.text(), res);
    await waitOnExecutionContext(ctx);
    return out;
  }

  it('creates and serves nothing, but lets owners list, revoke, delete and export', async () => {
    const { detail } = await seed();
    // A link made while sharing was on.
    const share = await ok<ShareSummary>(
      call('/api/shares', { method: 'POST', json: { treeId: detail.tree.id, scope: 'tree' } }),
      201,
    );

    expect(((await (await callOff('/api/me')).json()) as { sharing: boolean }).sharing).toBe(false);

    const create = await callOff('/api/shares', {
      method: 'POST',
      json: { treeId: detail.tree.id, scope: 'tree' },
    });
    expect(create.status).toBe(403);
    expect(((await create.json()) as { error: { code: string } }).error.code).toBe('forbidden');
    expect(
      (await callOff(`/api/shares/${share.id}`, { method: 'PATCH', json: { title: 'x' } })).status,
    ).toBe(403);
    expect((await callOff(`/api/shares/${share.id}/republish`, { method: 'POST' })).status).toBe(
      403,
    );

    // The old link no longer opens, as a page or as data.
    const page = await callOff(`/s/${share.token}`);
    expect(page.status).toBe(404);
    expect(await page.text()).not.toContain('PUBLIC-ROOT');
    expect((await callOff(`/s/${share.token}/data.json`)).status).toBe(404);

    // Owners can still see, revoke and delete it, and download the conversation.
    const listed = (await (await callOff('/api/shares')).json()) as ShareSummary[];
    expect(listed.map((s) => s.id)).toContain(share.id);
    expect((await callOff(`/api/shares/${share.id}/revoke`, { method: 'POST' })).status).toBe(200);
    expect((await callOff(`/api/shares/${share.id}`, { method: 'DELETE' })).status).toBe(204);
    const md = await callOff(`/api/export?treeId=${detail.tree.id}&format=md`);
    expect(md.status).toBe(200);
    expect(await md.text()).toContain('PUBLIC-ROOT');
  });
});

describe('export', () => {
  it('exports Markdown and self-contained HTML, private excluded by default', async () => {
    const { detail } = await seed();
    const md = await call(`/api/export?treeId=${detail.tree.id}&format=md`);
    expect(md.headers.get('Content-Disposition')).toMatch(/attachment; filename=".+\.md"/);
    const mdText = await md.text();
    expect(mdText).toContain('PUBLIC-SIDE');
    expect(mdText).not.toContain('PRIVATE-MARKER');

    const withPrivate = await (
      await call(`/api/export?treeId=${detail.tree.id}&format=md&includePrivate=true`)
    ).text();
    expect(withPrivate).toContain('PRIVATE-MARKER');

    const html = await (await call(`/api/export?treeId=${detail.tree.id}&format=html`)).text();
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('Content-Security-Policy');
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+stylesheet/);
  });
});
