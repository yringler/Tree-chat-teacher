import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector, type Provider } from '@angular/core';
import type { BillingSummary, NodeLink, UsageListResponse } from '@tangent/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiClient,
  ApiError,
  isMembershipRequired,
  isPaymentRequired,
  isPoolCapReached,
  isPoolEmpty,
  isPoolConsentRequired,
  isPoolUnavailable,
  isSessionExpired,
  SESSION_EXPIRED_MESSAGE,
} from './api-client';
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

const SUMMARY: BillingSummary = {
  enabled: true,
  membership: {
    required: false,
    status: 'inactive',
    subscriptionStatus: null,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    priceCents: 1000,
    includedCreditCents: 200,
  },
  builtInCredit: true,
  currency: 'usd',
  balanceMicros: 5_000_000,
  heldMicros: 0,
  availableMicros: 5_000_000,
  markupBps: 1000,
  openRouterFeeBps: 550,
  minTopUpCents: 500,
  maxTopUpCents: 50_000,
};

describe('ApiClient billing', () => {
  let fetchMock: ReturnType<typeof vi.fn<(...args: FetchArgs) => Promise<Response>>>;
  const api = createApi();

  beforeEach(() => {
    fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('billing() GETs /api/billing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SUMMARY));
    await expect(api.billing()).resolves.toEqual(SUMMARY);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/billing');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('same-origin');
    expect(init.body).toBeUndefined();
  });

  it('usage() pages with cursor and limit', async () => {
    const page: UsageListResponse = { entries: [], nextCursor: null };
    fetchMock.mockImplementation(async () => jsonResponse(page));
    await expect(api.usage()).resolves.toEqual(page);
    await api.usage('c 1/2', 20);
    await api.usage(null, 5);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/billing/usage',
      '/api/billing/usage?cursor=c+1%2F2&limit=20',
      '/api/billing/usage?limit=5',
    ]);
  });

  it('createCheckout() POSTs the amount as JSON', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ url: 'https://pay.example/checkout/x' }));
    await expect(api.createCheckout(2500)).resolves.toEqual({
      url: 'https://pay.example/checkout/x',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/billing/checkout');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ amountCents: 2500 });
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('membershipCheckout() and billingPortal() POST to the billing routes', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ url: 'https://pay.example/checkout/m' }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ url: 'https://pay.example/portal/p' }));
    await expect(api.membershipCheckout()).resolves.toEqual({
      url: 'https://pay.example/checkout/m',
    });
    await expect(api.billingPortal()).resolves.toEqual({ url: 'https://pay.example/portal/p' });
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ['/api/billing/membership/checkout', 'POST'],
      ['/api/billing/portal', 'POST'],
    ]);
  });

  it('turns a 404 no_customer body into an ApiError with that code', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'no_customer', message: 'Nothing to manage' } }, 404),
    );
    await expect(api.billingPortal()).rejects.toMatchObject({ status: 404, code: 'no_customer' });
  });

  it('turns a 402 body into a payment_required ApiError', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'payment_required', message: 'Add credit' } }, 402),
    );
    const err = await api.billing().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 402, code: 'payment_required', message: 'Add credit' });
    expect(isPaymentRequired(err)).toBe(true);
  });

  it('maps a bare 402 (no JSON body) to payment_required', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 402 }));
    const err = await api.createCheckout(500).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 402, code: 'payment_required' });
    expect(isPaymentRequired(err)).toBe(true);
    expect(isPaymentRequired(new ApiError(403, 'forbidden', 'x'))).toBe(false);
    expect(isPaymentRequired(new Error('x'))).toBe(false);
  });
});

describe('ApiClient open pool', () => {
  let fetchMock: ReturnType<typeof vi.fn<(...args: FetchArgs) => Promise<Response>>>;
  const api = createApi();

  beforeEach(() => {
    fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('poolStatus() and poolMe() GET /api/pool/status and /api/pool/me', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}));
    await api.poolStatus();
    await api.poolMe();
    expect(fetchMock.mock.calls.map(([url, init]) => [init.method, url])).toEqual([
      ['GET', '/api/pool/status'],
      ['GET', '/api/pool/me'],
    ]);
  });

  it('poolImpact(week?) and poolImpactWeeks() GET the public impact feed', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}));
    await api.poolImpact();
    await api.poolImpact('2026-09-28');
    await api.poolImpactWeeks();
    expect(fetchMock.mock.calls.map(([url, init]) => [init.method, url])).toEqual([
      ['GET', '/api/pool/impact'],
      ['GET', '/api/pool/impact?week=2026-09-28'],
      ['GET', '/api/pool/impact/weeks'],
    ]);
  });

  it('adminPool() GETs the pool panel; adminCredit POSTs the request as given', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}));
    await api.adminPool();
    const req = {
      target: 'pool',
      userId: null,
      amountCents: 2000,
      mode: 'adjustment',
      idempotencyKey: 'key-12345678',
    } as const;
    await api.adminCredit(req);
    expect(fetchMock.mock.calls.map(([url, init]) => [init.method, url])).toEqual([
      ['GET', '/api/admin/pool'],
      ['POST', '/api/admin/credit'],
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body))).toEqual(req);
  });

  it('adminPoolTopics(status?) lists the review queue; decideAdminPoolTopic POSTs the decision', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ topics: [] }));
    await api.adminPoolTopics();
    await api.adminPoolTopics('rejected');
    await api.decideAdminPoolTopic('history.ancient-rome', 'approved');
    expect(fetchMock.mock.calls.map(([url, init]) => [init.method, url])).toEqual([
      ['GET', '/api/admin/pool/topics'],
      ['GET', '/api/admin/pool/topics?status=rejected'],
      ['POST', '/api/admin/pool/topics/history.ancient-rome'],
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1].body))).toEqual({ decision: 'approved' });
  });

  it("createCheckout(cents) asks for a top-up of the caller's own credit only", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ url: 'https://pay.example/checkout/p' }));
    await api.createCheckout(2000);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toEqual({ amountCents: 2000 });
  });

  it('poolConsent(version) POSTs the version shown to /api/pool/consent', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ version: 1, acknowledgedAt: '2026-10-05T12:00:00.000Z' }),
    );
    await expect(api.poolConsent(1)).resolves.toEqual({
      version: 1,
      acknowledgedAt: '2026-10-05T12:00:00.000Z',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect([init.method, url]).toEqual(['POST', '/api/pool/consent']);
    expect(JSON.parse(String(init.body))).toEqual({ version: 1 });
  });

  it('keeps the notice version a pool_consent_required asks for', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            code: 'pool_consent_required',
            message: 'Read the notice',
            consent: { currentVersion: 2 },
          },
        },
        403,
      ),
    );
    const err = await api.poolMe().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 403, consent: { currentVersion: 2 }, pool: null });
    expect(isPoolConsentRequired(err)).toBe(true);
    expect(isPoolUnavailable(err)).toBe(false);
    expect(new ApiError(403, 'pool_unavailable', 'x').consent).toBeNull();
  });

  it('keeps what a pool refusal hit on the ApiError', async () => {
    const pool = {
      reason: 'cap_requests',
      limit: 30,
      resetAt: '2026-10-06T00:00:00.000Z',
      member: false,
      memberLimit: 150,
    };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'pool_cap_reached', message: 'Cap', pool } }, 429),
    );
    const err = await api.poolMe().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, code: 'pool_cap_reached', pool });
    expect(isPoolCapReached(err)).toBe(true);
    expect(isPoolEmpty(err)).toBe(false);
    expect(isPoolEmpty(new ApiError(402, 'pool_empty', 'Empty'))).toBe(true);
    expect(isPoolUnavailable(new ApiError(403, 'pool_unavailable', 'No'))).toBe(true);
    // Any other error has no pool details.
    expect(new ApiError(402, 'payment_required', 'x').pool).toBeNull();
  });
});

describe('ApiClient membership waiver', () => {
  let fetchMock: ReturnType<typeof vi.fn<(...args: FetchArgs) => Promise<Response>>>;
  const api = createApi();

  beforeEach(() => {
    fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redeemMembershipWaiver() POSTs the code and resolves with the membership', async () => {
    const waived = { ...SUMMARY.membership, required: true, status: 'waived' as const };
    fetchMock.mockResolvedValueOnce(jsonResponse(waived));
    await expect(api.redeemMembershipWaiver('FRIENDS-2026')).resolves.toEqual(waived);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/billing/membership/waiver');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ code: 'FRIENDS-2026' });
  });

  it('a wrong code rejects with the 403 forbidden ApiError', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'forbidden', message: 'That code is not valid' } }, 403),
    );
    const err = await api.redeemMembershipWaiver('nope').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('isMembershipRequired() tells the membership 402 from the credit one', () => {
    expect(isMembershipRequired(new ApiError(402, 'membership_required', 'x'))).toBe(true);
    expect(isPaymentRequired(new ApiError(402, 'membership_required', 'x'))).toBe(false);
    expect(isMembershipRequired(new ApiError(402, 'payment_required', 'x'))).toBe(false);
    expect(isMembershipRequired(new Error('x'))).toBe(false);
  });
});

describe('ApiClient transport (API_FETCH)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends every request through the provided API_FETCH, never the global fetch', async () => {
    const globalFetch = vi.fn<(...args: FetchArgs) => Promise<Response>>();
    vi.stubGlobal('fetch', globalFetch);
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      return input === '/api/trees'
        ? jsonResponse([])
        : new Response('data: {}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    const api = createApi([{ provide: API_FETCH, useValue: transport }]);

    await expect(api.listTrees()).resolves.toEqual([]);
    const signal = new AbortController().signal;
    const res = await api.sendMessage('b1', { content: 'hi' }, signal);
    expect(res.body).not.toBeNull();

    expect(globalFetch).not.toHaveBeenCalled();
    expect(transport.mock.calls.map(([url]) => url)).toEqual([
      '/api/trees',
      '/api/branches/b1/messages',
    ]);
    const init = transport.mock.calls[1]![1]!;
    expect(init.method).toBe('POST');
    expect(init.signal).toBe(signal);
    expect(JSON.parse(String(init.body))).toEqual({ content: 'hi' });
  });

  it("maps the transport's error responses like fetch's", async () => {
    const api = createApi([
      {
        provide: API_FETCH,
        useValue: async () =>
          jsonResponse({ error: { code: 'not_found', message: 'Route not found' } }, 404),
      },
    ]);
    await expect(api.getTree('x')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
      message: 'Route not found',
    });
  });

  it('defaults to the global fetch, looked up per call', async () => {
    const api = createApi();
    const later = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal('fetch', later);
    await api.listTrees();
    expect(later).toHaveBeenCalledOnce();
  });
});

describe('ApiClient 401s', () => {
  const respondWith = (res: () => Response) =>
    createApi([{ provide: API_FETCH, useValue: async () => res() }]);
  const send = (api: ApiClient) =>
    api.sendMessage('b1', { content: 'hi' }, new AbortController().signal);

  it('keeps key_required and the server message (not "session expired")', async () => {
    const message = 'Add your OpenRouter API key to continue this conversation.';
    const api = respondWith(() => jsonResponse({ error: { code: 'key_required', message } }, 401));
    const err = await send(api).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: 'key_required', message });
    expect(isSessionExpired(err)).toBe(false);
    // The same through the JSON routes.
    await expect(api.listTrees()).rejects.toMatchObject({ code: 'key_required', message });
  });

  it('reports a missing or expired session (401 unauthorized) as expired', async () => {
    const api = respondWith(() =>
      jsonResponse({ error: { code: 'unauthorized', message: 'Sign in required' } }, 401),
    );
    const err = await send(api).catch((e: unknown) => e);
    expect(err).toMatchObject({
      status: 401,
      code: 'unauthorized',
      message: SESSION_EXPIRED_MESSAGE,
    });
    expect(isSessionExpired(err)).toBe(true);
    await expect(api.listTrees()).rejects.toMatchObject({ message: SESSION_EXPIRED_MESSAGE });
  });

  it('treats a 401 without our error body (e.g. from a proxy) as an expired session', async () => {
    const api = respondWith(() => new Response('Unauthorized', { status: 401 }));
    await expect(api.listTrees()).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
      message: SESSION_EXPIRED_MESSAGE,
    });
  });
});

describe('ApiClient headers', () => {
  it('adds API_HEADERS to every request, read per call', async () => {
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
    const headers = fetchMock.mock.calls.map(([, init]) => init.headers as Record<string, string>);
    expect(headers[0]).toMatchObject({
      'x-tangent-mode': 'simple',
      'x-tangent-payment': 'own-key',
    });
    expect(headers[1]).toMatchObject({
      'x-tangent-mode': 'simple',
      'x-tangent-payment': 'credit',
      'content-type': 'application/json',
    });
  });

  it("backup(treeId) GETs the tree's backup with the app's headers (Learn's mode reaches its account)", async () => {
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>(async () =>
      jsonResponse({ format: 'tangent-tree-backup' }),
    );
    const api = createApi([
      { provide: API_FETCH, useValue: fetchMock },
      { provide: API_HEADERS, useValue: () => ({ 'x-tangent-mode': 'simple' }) },
    ]);
    await expect(api.backup('t/1')).resolves.toEqual({ format: 'tangent-tree-backup' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/trees/t%2F1/backup');
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({ 'x-tangent-mode': 'simple' });
  });

  it('sends none by default', async () => {
    const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>(async () =>
      jsonResponse([]),
    );
    await createApi([{ provide: API_FETCH, useValue: fetchMock }]).listTrees();
    expect(fetchMock.mock.calls[0]![1].headers).toEqual({
      accept: 'application/json, text/event-stream',
    });
  });
});

describe('ApiClient links', () => {
  let fetchMock: ReturnType<typeof vi.fn<(...args: FetchArgs) => Promise<Response>>>;
  const api = createApi();
  const link: NodeLink = {
    id: 'l/1',
    treeId: 't',
    sourceNodeId: 'a',
    targetNodeId: 'b',
    note: null,
    origin: 'user',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };

  beforeEach(() => {
    fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('createLink POSTs, updateLink PATCHes and deleteLink DELETEs /api/links', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(link, 201));
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...link, note: 'why' }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api.createLink({ fromNodeId: 'a', toNodeId: 'b' })).resolves.toEqual({
      link,
      created: true,
    });
    await expect(api.updateLink(link.id, { note: 'why' })).resolves.toMatchObject({ note: 'why' });
    await expect(api.deleteLink(link.id)).resolves.toBeUndefined();
    expect(
      fetchMock.mock.calls.map(([url, init]) => [
        url,
        init.method,
        init.body === undefined ? undefined : JSON.parse(String(init.body)),
      ]),
    ).toEqual([
      ['/api/links', 'POST', { fromNodeId: 'a', toNodeId: 'b' }],
      ['/api/links/l%2F1', 'PATCH', { note: 'why' }],
      ['/api/links/l%2F1', 'DELETE', undefined],
    ]);
  });

  it('deleteShare DELETEs /api/shares/:id and resolves on 204', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api.deleteShare('s/1')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ['/api/shares/s%2F1', 'DELETE'],
    ]);
  });

  it('createLink tells an existing pair (200) from a new link (201)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(link, 200));
    await expect(api.createLink({ fromNodeId: 'b', toNodeId: 'a' })).resolves.toEqual({
      link,
      created: false,
    });
  });
});

describe('ApiClient compare', () => {
  it('streamCandidate() POSTs the request and resolves with the stream; commitCandidate() POSTs the commit', async () => {
    const committed = { userNode: { id: 'u' }, assistantNode: { id: 'a' }, branch: { id: 'b 1' } };
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      return String(input).endsWith('/commit')
        ? jsonResponse(committed)
        : new Response('event: status\ndata: {"type":"status","message":"x"}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
    });
    const api = createApi([{ provide: API_FETCH, useValue: transport }]);
    const signal = new AbortController().signal;

    const res = await api.streamCandidate('b 1', { content: 'Why?', model: 'm' }, signal);
    expect(res.body).not.toBeNull();
    await expect(api.commitCandidate('b 1', 'c/1')).resolves.toEqual(committed);

    expect(transport.mock.calls.map(([url]) => url)).toEqual([
      '/api/branches/b%201/candidates',
      '/api/branches/b%201/candidates/c%2F1/commit',
    ]);
    const [, streamInit] = transport.mock.calls[0]!;
    expect(streamInit!.method).toBe('POST');
    expect(streamInit!.signal).toBe(signal);
    expect(JSON.parse(String(streamInit!.body))).toEqual({ content: 'Why?', model: 'm' });
    const [, commitInit] = transport.mock.calls[1]!;
    expect(commitInit!.method).toBe('POST');
    expect(commitInit!.body).toBeUndefined();
  });

  it('rejects an expired candidate with the 410', async () => {
    const api = createApi([
      {
        provide: API_FETCH,
        useValue: async () =>
          jsonResponse({ error: { code: 'gone', message: 'That comparison has expired' } }, 410),
      },
    ]);
    await expect(api.commitCandidate('b', 'c')).rejects.toMatchObject({
      status: 410,
      code: 'gone',
    });
  });
});
