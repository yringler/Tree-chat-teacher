import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector, type Provider } from '@angular/core';
import type { NodeLink } from '@tangent/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, hasCode, SESSION_EXPIRED_MESSAGE } from './api-client';
import { API_FETCH, API_HEADERS } from './api-fetch';

type FetchArgs = [input: string, init: RequestInit];

function createApi(providers: Provider[] = []): ApiClient {
  return Injector.create({ providers: [{ provide: ApiClient }, ...providers] }).get(ApiClient);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(): Response {
  return new Response('event: status\ndata: {"type":"status","message":"x"}\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** An ApiClient over a transport that records each request and answers `reply()`. */
function recording(reply: (url: string) => Response = () => jsonResponse({})) {
  const transport = vi.fn<(...args: FetchArgs) => Promise<Response>>(async (url) => reply(url));
  const api = createApi([{ provide: API_FETCH, useValue: transport }]);
  return { api, transport };
}

const signal = new AbortController().signal;

describe('ApiClient', () => {
  // Each named method: the request it sends (method, URL, JSON body).
  const calls: [string, (api: ApiClient) => Promise<unknown> | string, string, string, unknown?][] =
    [
      ['me', (a) => a.me(), 'GET', '/api/me'],
      [
        'deleteAccount',
        (a) => a.deleteAccount('a@b.c'),
        'DELETE',
        '/api/account',
        { confirmEmail: 'a@b.c' },
      ],
      ['providers', (a) => a.providers(), 'GET', '/api/providers'],
      ['keyStatus', (a) => a.keyStatus(), 'GET', '/api/key/status'],
      [
        'saveKey',
        (a) => a.saveKey('openrouter', 'sk'),
        'POST',
        '/api/key',
        { provider: 'openrouter', apiKey: 'sk' },
      ],
      [
        'forgetKey',
        (a) => a.forgetKey('openrouter'),
        'DELETE',
        '/api/key',
        { provider: 'openrouter' },
      ],
      ['forgetKey (all)', (a) => a.forgetKey(), 'DELETE', '/api/key', {}],
      ['billing', (a) => a.billing(), 'GET', '/api/billing'],
      ['usage', (a) => a.usage(), 'GET', '/api/billing/usage'],
      [
        'usage (paged)',
        (a) => a.usage('c 1/2', 20),
        'GET',
        '/api/billing/usage?cursor=c+1%2F2&limit=20',
      ],
      ['usage (limit only)', (a) => a.usage(null, 5), 'GET', '/api/billing/usage?limit=5'],
      [
        'createCheckout',
        (a) => a.createCheckout(2500),
        'POST',
        '/api/billing/checkout',
        { amountCents: 2500 },
      ],
      [
        'membershipCheckout',
        (a) => a.membershipCheckout(),
        'POST',
        '/api/billing/membership/checkout',
      ],
      ['billingPortal', (a) => a.billingPortal(), 'POST', '/api/billing/portal'],
      [
        'redeemMembershipWaiver',
        (a) => a.redeemMembershipWaiver('FRIENDS'),
        'POST',
        '/api/billing/membership/waiver',
        { code: 'FRIENDS' },
      ],
      ['poolStatus', (a) => a.poolStatus(), 'GET', '/api/pool/status'],
      ['poolMe', (a) => a.poolMe(), 'GET', '/api/pool/me'],
      ['settings', (a) => a.settings(), 'GET', '/api/settings'],
      [
        'updateSettings',
        (a) => a.updateSettings({ systemPrompt: null }),
        'PATCH',
        '/api/settings',
        { systemPrompt: null },
      ],
      ['listTrees', (a) => a.listTrees(), 'GET', '/api/trees'],
      ['createTree', (a) => a.createTree({ title: 'T' }), 'POST', '/api/trees', { title: 'T' }],
      ['getTree', (a) => a.getTree('t/1'), 'GET', '/api/trees/t%2F1'],
      [
        'updateTree',
        (a) => a.updateTree('t', { title: 'U' }),
        'PATCH',
        '/api/trees/t',
        { title: 'U' },
      ],
      ['deleteTree', (a) => a.deleteTree('t'), 'DELETE', '/api/trees/t'],
      [
        'createBranch',
        (a) => a.createBranch({ fromNodeId: 'n' }),
        'POST',
        '/api/branches',
        { fromNodeId: 'n' },
      ],
      [
        'updateBranch',
        (a) => a.updateBranch('b', { title: 'B' }),
        'PATCH',
        '/api/branches/b',
        { title: 'B' },
      ],
      ['deleteBranch', (a) => a.deleteBranch('b'), 'DELETE', '/api/branches/b'],
      [
        'getContext',
        (a) => a.getContext('b', 'n', true, { maxInputTokens: 8000 }),
        'GET',
        '/api/branches/b/context?nodeId=n&resolve=true&maxInputTokens=8000',
      ],
      [
        'getContext (leaf)',
        (a) => a.getContext('b', null, false),
        'GET',
        '/api/branches/b/context?resolve=false',
      ],
      ['inputBudget', (a) => a.inputBudget('b'), 'GET', '/api/branches/b/input-budget'],
      [
        'createLink',
        (a) => a.createLink({ fromNodeId: 'a', toNodeId: 'b' }),
        'POST',
        '/api/links',
        { fromNodeId: 'a', toNodeId: 'b' },
      ],
      [
        'updateLink',
        (a) => a.updateLink('l/1', { note: 'why' }),
        'PATCH',
        '/api/links/l%2F1',
        { note: 'why' },
      ],
      ['deleteLink', (a) => a.deleteLink('l/1'), 'DELETE', '/api/links/l%2F1'],
      [
        'sendMessage',
        (a) => a.sendMessage('b1', { content: 'hi' }, signal),
        'POST',
        '/api/branches/b1/messages',
        { content: 'hi' },
      ],
      ['streamNode', (a) => a.streamNode('n', signal), 'GET', '/api/nodes/n/stream'],
      ['cancelNode', (a) => a.cancelNode('n'), 'POST', '/api/nodes/n/cancel'],
      [
        'reviewNode',
        (a) => a.reviewNode('n', { providerId: 'p', model: 'm' }, signal),
        'POST',
        '/api/nodes/n/review',
        { providerId: 'p', model: 'm' },
      ],
      [
        'streamCandidate',
        (a) => a.streamCandidate('b 1', { content: 'Why?', model: 'm' }, signal),
        'POST',
        '/api/branches/b%201/candidates',
        { content: 'Why?', model: 'm' },
      ],
      [
        'commitCandidate',
        (a) => a.commitCandidate('b 1', 'c/1'),
        'POST',
        '/api/branches/b%201/candidates/c%2F1/commit',
      ],
      ['listShares', (a) => a.listShares(), 'GET', '/api/shares'],
      [
        'createShare',
        (a) => a.createShare({ treeId: 't', scope: 'tree' }),
        'POST',
        '/api/shares',
        { treeId: 't', scope: 'tree' },
      ],
      [
        'updateShare',
        (a) => a.updateShare('s', { title: 'S' }),
        'PATCH',
        '/api/shares/s',
        { title: 'S' },
      ],
      ['republishShare', (a) => a.republishShare('s'), 'POST', '/api/shares/s/republish'],
      ['revokeShare', (a) => a.revokeShare('s'), 'POST', '/api/shares/s/revoke'],
      ['deleteShare', (a) => a.deleteShare('s/1'), 'DELETE', '/api/shares/s%2F1'],
      ['adminStatus', (a) => a.adminStatus(), 'GET', '/api/admin/status'],
      ['adminUsers', (a) => a.adminUsers(), 'GET', '/api/admin/users'],
      [
        'adminUsers (search)',
        (a) => a.adminUsers('ann', 'c'),
        'GET',
        '/api/admin/users?q=ann&cursor=c',
      ],
      [
        'updateAdminUser',
        (a) => a.updateAdminUser('u', { shareAllowed: true }),
        'PATCH',
        '/api/admin/users/u',
        { shareAllowed: true },
      ],
      ['adminPool', (a) => a.adminPool(), 'GET', '/api/admin/pool'],
      [
        'adminCredit',
        (a) =>
          a.adminCredit({
            target: 'pool',
            userId: null,
            amountCents: 2000,
            mode: 'adjustment',
            idempotencyKey: 'key-12345678',
          }),
        'POST',
        '/api/admin/credit',
        {
          target: 'pool',
          userId: null,
          amountCents: 2000,
          mode: 'adjustment',
          idempotencyKey: 'key-12345678',
        },
      ],
      ['adminPoolUsage', (a) => a.adminPoolUsage(), 'GET', '/api/admin/pool/usage'],
      [
        'adminPoolUsage (days)',
        (a) => a.adminPoolUsage(30),
        'GET',
        '/api/admin/pool/usage?days=30',
      ],
      ['adminUserShares', (a) => a.adminUserShares('u'), 'GET', '/api/admin/users/u/shares'],
      ['adminRevokeShare', (a) => a.adminRevokeShare('s'), 'POST', '/api/admin/shares/s/revoke'],
      ['backup', (a) => a.backup('t/1'), 'GET', '/api/trees/t%2F1/backup'],
      [
        'importBackup',
        (a) =>
          a.importBackup({
            format: 'tangent-tree-backup',
            version: 1,
            exportedAt: 'x',
            tree: {
              id: 't',
              title: 'T',
              systemPrompt: null,
              trunkBranchId: 'b',
              createdAt: 'x',
              updatedAt: 'x',
            },
            branches: [],
            nodes: [],
          }),
        'POST',
        '/api/import',
        {
          format: 'tangent-tree-backup',
          version: 1,
          exportedAt: 'x',
          tree: {
            id: 't',
            title: 'T',
            systemPrompt: null,
            trunkBranchId: 'b',
            createdAt: 'x',
            updatedAt: 'x',
          },
          branches: [],
          nodes: [],
        },
      ],
      ['copyToLearn', (a) => a.copyToLearn('t'), 'POST', '/api/trees/t/copy-to-learn'],
    ];

  it.each(calls)('%s sends %s %s', async (_name, run, method, url, body) => {
    const { api, transport } = recording((u) =>
      /\/(messages|stream|review|candidates)$/.test(u) ? sseResponse() : jsonResponse({}),
    );
    await run(api);
    const [sent, init] = transport.mock.calls[0]!;
    expect([init.method, sent]).toEqual([method, url]);
    expect(init.credentials).toBe('same-origin');
    expect(init.body === undefined ? undefined : JSON.parse(String(init.body))).toEqual(body);
    if (body !== undefined)
      expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('builds the export and backup links', () => {
    const api = createApi();
    expect(api.backupUrl('t/1')).toBe('/api/trees/t%2F1/backup');
    expect(
      api.exportUrl({
        treeId: 't',
        scope: 'path',
        nodeId: 'n',
        format: 'html',
        includeAncestors: true,
      }),
    ).toBe('/api/export?treeId=t&scope=path&format=html&nodeId=n&includeAncestors=true');
    expect(api.exportUrl({ treeId: 't', scope: 'tree', nodeId: 'n', format: 'md' })).toBe(
      '/api/export?treeId=t&scope=tree&format=md',
    );
  });

  it('resolves a 204 with undefined and tells an existing link pair (200) from a new one (201)', async () => {
    const link = { id: 'l' } as NodeLink;
    const statuses = [204, 201, 200];
    const { api } = recording(() => {
      const status = statuses.shift()!;
      return status === 204 ? new Response(null, { status }) : jsonResponse(link, status);
    });
    await expect(api.deleteShare('s')).resolves.toBeUndefined();
    await expect(api.createLink({ fromNodeId: 'a', toNodeId: 'b' })).resolves.toEqual({
      link,
      created: true,
    });
    await expect(api.createLink({ fromNodeId: 'b', toNodeId: 'a' })).resolves.toEqual({
      link,
      created: false,
    });
  });
});

describe('ApiClient errors', () => {
  const respondWith = (res: () => Response) => recording(res).api;
  const send = (api: ApiClient) => api.sendMessage('b1', { content: 'hi' }, signal);

  it("turns the server's error body into an ApiError with its code, message and pool details", async () => {
    const pool = {
      reason: 'cap_requests',
      limit: 30,
      resetAt: '2026-10-06T00:00:00.000Z',
    } as const;
    const api = respondWith(() =>
      jsonResponse({ error: { code: 'pool_cap_reached', message: 'Cap', pool } }, 429),
    );
    const err = await api.poolMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, code: 'pool_cap_reached', message: 'Cap', pool });
    expect(hasCode(err, 'pool_cap_reached')).toBe(true);
    expect(hasCode(err, 'pool_empty')).toBe(false);
    expect(hasCode(new Error('x'), 'internal')).toBe(false);
    expect(new ApiError(402, 'payment_required', 'x').pool).toBeNull();
  });

  it('maps a response without our body by its status', async () => {
    const statuses = [402, 404, 503, 400];
    const api = respondWith(() => new Response('nope', { status: statuses.shift()! }));
    for (const code of ['payment_required', 'not_found', 'internal', 'bad_request']) {
      await expect(api.billing()).rejects.toMatchObject({ code });
    }
  });

  it('reports a network failure as status 0, and rethrows an abort as it is', async () => {
    const api = createApi([
      {
        provide: API_FETCH,
        useValue: async () => {
          throw new TypeError('Failed to fetch');
        },
      },
    ]);
    await expect(api.listTrees()).rejects.toMatchObject({ status: 0, code: 'network' });
    const aborted = new AbortController();
    aborted.abort();
    const abortApi = createApi([
      {
        provide: API_FETCH,
        useValue: async () => {
          throw new DOMException('Aborted', 'AbortError');
        },
      },
    ]);
    await expect(
      abortApi.sendMessage('b', { content: 'x' }, aborted.signal),
    ).rejects.toBeInstanceOf(DOMException);
  });

  it('keeps key_required and the server message (not "session expired")', async () => {
    const message = 'Add your OpenRouter API key to continue this conversation.';
    const api = respondWith(() => jsonResponse({ error: { code: 'key_required', message } }, 401));
    const err = await send(api).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401, code: 'key_required', message });
    expect(hasCode(err, 'unauthorized')).toBe(false);
    await expect(api.listTrees()).rejects.toMatchObject({ code: 'key_required', message });
  });

  it('reports a missing or expired session (401 unauthorized, or a bare 401) as expired', async () => {
    const api = respondWith(() =>
      jsonResponse({ error: { code: 'unauthorized', message: 'Sign in required' } }, 401),
    );
    const err = await send(api).catch((e: unknown) => e);
    expect(err).toMatchObject({
      status: 401,
      code: 'unauthorized',
      message: SESSION_EXPIRED_MESSAGE,
    });
    expect(hasCode(err, 'unauthorized')).toBe(true);
    const bare = respondWith(() => new Response('Unauthorized', { status: 401 }));
    await expect(bare.listTrees()).rejects.toMatchObject({
      code: 'unauthorized',
      message: SESSION_EXPIRED_MESSAGE,
    });
  });
});

describe('ApiClient transport and headers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends through the provided API_FETCH; without one, the global fetch looked up per call', async () => {
    const globalFetch = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal('fetch', globalFetch);
    const { api, transport } = recording(() => jsonResponse([]));
    await api.listTrees();
    expect(transport).toHaveBeenCalledOnce();
    expect(globalFetch).not.toHaveBeenCalled();
    await createApi().listTrees();
    expect(globalFetch).toHaveBeenCalledOnce();
  });

  it('passes the signal of a stream through', async () => {
    const { api, transport } = recording(() => sseResponse());
    const res = await api.sendMessage('b1', { content: 'hi' }, signal);
    expect(res.body).not.toBeNull();
    expect(transport.mock.calls[0]![1].signal).toBe(signal);
  });

  it('adds API_HEADERS to every request, read per call; none by default', async () => {
    let payment = 'own-key';
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>(async () =>
      jsonResponse([]),
    );
    const api = createApi([
      { provide: API_FETCH, useValue: fetchMock },
      {
        provide: API_HEADERS,
        useValue: () => ({ 'x-tangent-mode': 'simple', 'x-tangent-payment': payment }),
      },
    ]);
    await api.listTrees();
    payment = 'credit';
    await api.createTree({ title: 'T' });
    const headers = fetchMock.mock.calls.map(([, init]) => init.headers);
    expect(headers[0]).toMatchObject({
      'x-tangent-mode': 'simple',
      'x-tangent-payment': 'own-key',
    });
    expect(headers[1]).toMatchObject({
      'x-tangent-payment': 'credit',
      'content-type': 'application/json',
    });
    const plain = recording(() => jsonResponse([]));
    await plain.api.listTrees();
    expect(plain.transport.mock.calls[0]![1].headers).toEqual({
      accept: 'application/json, text/event-stream',
    });
  });
});
