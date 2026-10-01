import type { BillingSummary, UsageListResponse } from '@tangent/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, isPaymentRequired } from './api-client';

type FetchArgs = [input: string, init: RequestInit];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SUMMARY: BillingSummary = {
  enabled: true,
  currency: 'usd',
  balanceMicros: 5_000_000,
  heldMicros: 0,
  availableMicros: 5_000_000,
  markupBps: 1000,
  subscription: null,
  monthlyPlans: [{ name: 'basic', label: 'Basic', amountCents: 1000 }],
  minTopUpCents: 500,
  maxTopUpCents: 50_000,
};

describe('ApiClient billing', () => {
  let fetchMock: ReturnType<typeof vi.fn<(...args: FetchArgs) => Promise<Response>>>;
  const api = new ApiClient();

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
