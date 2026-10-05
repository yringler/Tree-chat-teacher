// Stand-in for https://sandbox-api.polar.sh (API version 2026-10) in tests. It
// runs in Node (the Vitest host), not in workerd: vitest.config.ts's
// `outboundService` delegates every outbound request to this origin here.
// Keep it free of `cloudflare:*` imports.
//
// Module state lives for the whole test run and is shared by every test file
// (files may run concurrently), so tests find their own calls by a unique
// value (an external customer id, metadata) instead of resetting.
//
// Polar API (JSON bodies, as the SDK sends them):
// - POST   /v1/checkouts/                      → `{ id, url, status: 'open', ... }`; the url is
//   `https://sandbox.polar.sh/checkout/polar_c_<n>`
// - POST   /v1/customer-sessions/              → `{ customer_portal_url, customer_id, ... }` when
//   the body's `external_customer_id` is a known customer, else 404 ResourceNotFound
// - GET    /v1/subscriptions/?external_customer_id=&active= → the known customer's registered
//   subscriptions that are not revoked (paged: `items`, `pagination`)
// - DELETE /v1/subscriptions/:id               → the subscription, now `canceled`, else 404
// - DELETE /v1/customers/external/:id          → 204 and forgets the customer, else 404
// - GET    /v1/orders/:id                      → a registered order, else 404
// - GET    /v1/disputes/?status=&page=&limit=  → registered disputes with one of the statuses,
//   newest first, paged
// - anything else                              → 404
// Every request without `Authorization: Bearer polar_oat_…` gets 401, and one without a
// `Polar-Version` header 400. An external customer id starting with `fail_` makes every
// call naming it answer 503.
//
// Control endpoints (plain `fetch()` from a test):
// - GET  /__mock/calls[?path=/v1/checkouts/] → MockPolarCall[] (oldest first)
// - POST /__mock/objects { customers?: string[], subscriptions?, orders?, disputes? } → stores
//   fixtures (customers are external ids; a subscription needs `id` and `external_customer_id`;
//   orders and disputes are stored by `id`, re-posting an id replaces it)

export const POLAR_ORIGIN = 'https://sandbox-api.polar.sh';

export interface MockPolarCall {
  method: string;
  path: string;
  query: Record<string, string[]>;
  body: Record<string, unknown> | null;
  polarVersion: string | null;
  authorized: boolean;
}

type Obj = Record<string, unknown>;

interface State {
  calls: MockPolarCall[];
  seq: number;
  customers: Set<string>;
  subscriptions: Map<string, Obj>;
  orders: Map<string, Obj>;
  disputes: Map<string, Obj>;
}

const state: State = {
  calls: [],
  seq: 0,
  customers: new Set(),
  subscriptions: new Map(),
  orders: new Map(),
  disputes: new Map(),
};

function notFound(): Response {
  return Response.json({ error: 'ResourceNotFound', detail: 'Not found' }, { status: 404 });
}

function page(items: Obj[], query: URLSearchParams): Response {
  const limit = Number(query.get('limit') ?? 10);
  const n = Number(query.get('page') ?? 1);
  const slice = items.slice((n - 1) * limit, n * limit);
  return Response.json({
    items: slice,
    pagination: {
      total_count: items.length,
      max_page: Math.max(1, Math.ceil(items.length / limit)),
    },
  });
}

async function control(request: Request, url: URL): Promise<Response> {
  if (url.pathname === '/__mock/calls') {
    const path = url.searchParams.get('path');
    return Response.json(path ? state.calls.filter((c) => c.path === path) : state.calls);
  }
  if (url.pathname === '/__mock/objects' && request.method === 'POST') {
    const body = (await request.json()) as {
      customers?: string[];
      subscriptions?: Obj[];
      orders?: Obj[];
      disputes?: Obj[];
    };
    for (const c of body.customers ?? []) state.customers.add(c);
    for (const s of body.subscriptions ?? []) state.subscriptions.set(String(s['id']), s);
    for (const o of body.orders ?? []) state.orders.set(String(o['id']), o);
    for (const d of body.disputes ?? []) state.disputes.set(String(d['id']), d);
    return Response.json({ ok: true });
  }
  return new Response('unknown control endpoint', { status: 404 });
}

export async function mockPolar(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/__mock/')) return control(request, url);
  const text = request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text();
  const body = text ? (JSON.parse(text) as Obj) : null;
  const query: Record<string, string[]> = {};
  for (const [k, v] of url.searchParams) (query[k] ??= []).push(v);
  const authorized = /^Bearer polar_oat_/.test(request.headers.get('authorization') ?? '');
  const polarVersion = request.headers.get('polar-version');
  state.calls.push({
    method: request.method,
    path: url.pathname,
    query,
    body,
    polarVersion,
    authorized,
  });
  if (!authorized) return Response.json({ error: 'invalid_token' }, { status: 401 });
  if (!polarVersion) return Response.json({ error: 'missing version' }, { status: 400 });

  const external =
    (body?.['external_customer_id'] as string | undefined) ??
    url.searchParams.get('external_customer_id') ??
    decodeURIComponent(url.pathname.match(/^\/v1\/customers\/external\/([^/]+)$/)?.[1] ?? '');
  if (external.startsWith('fail_')) return new Response('Service Unavailable', { status: 503 });

  if (request.method === 'POST' && url.pathname === '/v1/checkouts/') {
    const id = `polar_c_${++state.seq}`;
    return Response.json(
      {
        id,
        url: `https://sandbox.polar.sh/checkout/${id}`,
        status: 'open',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        metadata: body?.['metadata'] ?? {},
      },
      { status: 201 },
    );
  }
  if (request.method === 'POST' && url.pathname === '/v1/customer-sessions/') {
    if (!state.customers.has(external)) return notFound();
    return Response.json(
      {
        id: `polar_cs_${++state.seq}`,
        token: 'polar_cst_x',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        return_url: body?.['return_url'] ?? null,
        customer_portal_url: `https://sandbox.polar.sh/tangent/portal?customer_session_token=${state.seq}`,
        customer_id: `cus_of_${external}`,
      },
      { status: 201 },
    );
  }
  if (request.method === 'GET' && url.pathname === '/v1/subscriptions/') {
    const active = url.searchParams.get('active');
    const items = [...state.subscriptions.values()].filter(
      (s) =>
        s['external_customer_id'] === external && (active !== 'true' || s['status'] !== 'canceled'),
    );
    return page(items, url.searchParams);
  }
  const sub = url.pathname.match(/^\/v1\/subscriptions\/([^/]+)$/);
  if (request.method === 'DELETE' && sub) {
    const found = state.subscriptions.get(sub[1]!);
    if (!found) return notFound();
    found['status'] = 'canceled';
    return Response.json(found);
  }
  if (request.method === 'DELETE' && url.pathname.startsWith('/v1/customers/external/')) {
    if (!state.customers.delete(external)) return notFound();
    return new Response(null, { status: 204 });
  }
  const order = url.pathname.match(/^\/v1\/orders\/([^/]+)$/);
  if (request.method === 'GET' && order) {
    const found = state.orders.get(order[1]!);
    return found ? Response.json(found) : notFound();
  }
  if (request.method === 'GET' && url.pathname === '/v1/disputes/') {
    const statuses = url.searchParams.getAll('status');
    const items = [...state.disputes.values()]
      .filter((d) => statuses.length === 0 || statuses.includes(String(d['status'])))
      .sort((a, b) => String(b['created_at']).localeCompare(String(a['created_at'])));
    return page(items, url.searchParams);
  }
  return notFound();
}
