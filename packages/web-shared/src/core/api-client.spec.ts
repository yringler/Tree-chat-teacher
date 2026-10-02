import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector, type Provider } from '@angular/core';
import type { BillingSummary, UsageListResponse } from '@tangent/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, isPaymentRequired } from './api-client';
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
    stripeStatus: null,
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
    fetchMock.mockResolvedValueOnce(jsonResponse({ url: 'https://checkout.stripe.com/c/x' }));
    await expect(api.createCheckout(2500)).resolves.toEqual({
      url: 'https://checkout.stripe.com/c/x',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/billing/checkout');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ amountCents: 2500 });
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
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
