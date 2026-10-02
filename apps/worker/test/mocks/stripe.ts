// Stand-in for https://api.stripe.com in tests. It runs in Node (the Vitest
// host), not in workerd: vitest.config.ts's `outboundService` delegates every
// outbound request to this origin here. Keep it free of `cloudflare:*` imports.
//
// Module state lives for the whole test run and is shared by every test file
// (files may run concurrently), so tests should find their own calls by a
// unique value (email, metadata) instead of resetting.
//
// Stripe API (form-encoded bodies, as the SDK sends them):
// - POST /v1/customers                      → `cus_mock_<n>`; same Idempotency-Key → same customer
// - GET  /v1/customers/:id                  → the stored customer, else 404
// - DELETE /v1/customers/:id                → `{ deleted: true }` and forgets it, else 404
// - POST /v1/checkout/sessions              → `cs_mock_<n>` with a checkout.stripe.com url
// - GET  /v1/checkout/sessions?payment_intent= → sessions stored with that payment intent
// - GET  /v1/subscriptions/:id              → 404 resource_missing (the plugin's payment-mode noise)
// - GET  /v1/refunds?charge=                → refunds registered for that charge (default none)
// - GET  /v1/payment_intents/:id            → a succeeded PaymentIntent whose `latest_charge`
//   (`ch_of_<id>`) and its `balance_transaction` (`txn_of_<id>`) are expanded per `expand[]`.
//   Known when registered (control endpoint) or when a stored Checkout Session names it.
//   Fee: the registered `fee`, else 2.9% + 30¢ of the amount plus a 0.5% Stripe Tax fee;
//   `latestCharge: false` / `balanceTransaction: false` leave them null (not settled yet).
// - GET  /v1/charges/:id                    → `ch_of_<pi>` of a known PaymentIntent (expand[])
// - GET  /v1/invoice_payments?invoice=&status= → registered invoice payments for that invoice
// - anything else                           → 404 resource_missing
// Every request without `Authorization: Bearer sk_…` gets 401.
//
// Control endpoints (plain `fetch()` from a test):
// - GET  /__mock/calls[?path=/v1/customers] → MockStripeCall[] (oldest first)
// - POST /__mock/objects { checkoutSessions?, refunds?, paymentIntents?, invoicePayments? } →
//   stores fixtures; a payment intent is { id, amount (cents, tax included), fee?,
//   latestCharge?: false, balanceTransaction?: false } and re-posting an id replaces it
// - POST /__mock/reset                      → clears all state (only for files that own the run)

export const STRIPE_ORIGIN = 'https://api.stripe.com';

export interface MockStripeCall {
  method: string;
  path: string;
  query: Record<string, string>;
  /** Form body decoded into nested objects (`a[b][0]=x` → { a: { b: { 0: 'x' } } }). */
  body: Record<string, unknown>;
  idempotencyKey: string | null;
  stripeVersion: string | null;
  authorized: boolean;
}

type Obj = Record<string, unknown>;

interface State {
  calls: MockStripeCall[];
  seq: number;
  customers: Map<string, Obj>;
  idempotent: Map<string, Obj>;
  sessions: Map<string, Obj>;
  refunds: Obj[];
  paymentIntents: Map<string, MockPaymentIntent>;
  invoicePayments: Obj[];
}

/** A payment intent fixture (`POST /__mock/objects { paymentIntents }`). */
export interface MockPaymentIntent {
  id: string;
  /** Amount charged in cents, tax included (default: the stored session's `amount_total`). */
  amount?: number;
  /** Stripe's fee in cents (default: 2.9% + 30¢ + 0.5% Stripe Tax fee of `amount`). */
  fee?: number;
  /** false: no charge yet (`latest_charge: null`). */
  latestCharge?: boolean;
  /** false: the charge has no balance transaction yet. */
  balanceTransaction?: boolean;
}

const state: State = fresh();

function fresh(): State {
  return {
    calls: [],
    seq: 0,
    customers: new Map(),
    idempotent: new Map(),
    sessions: new Map(),
    refunds: [],
    paymentIntents: new Map(),
    invoicePayments: [],
  };
}

function nextId(prefix: string): string {
  state.seq += 1;
  return `${prefix}_mock_${state.seq}`;
}

/** Decodes Stripe's bracket notation into nested objects. */
export function decodeForm(text: string): Obj {
  const out: Obj = {};
  for (const [rawKey, value] of new URLSearchParams(text)) {
    const parts = rawKey.split(/[[\]]+/).filter((p) => p !== '');
    let node: Obj = out;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) {
        node[part] = value;
      } else {
        const next = node[part];
        if (typeof next !== 'object' || next === null) node[part] = {};
        node = node[part] as Obj;
      }
    });
  }
  return out;
}

function stripeError(status: number, message: string, code = 'resource_missing'): Response {
  return Response.json(
    {
      error: {
        type: status === 401 ? 'invalid_request_error' : 'invalid_request_error',
        code,
        message,
      },
    },
    { status, headers: { 'request-id': `req_mock_${state.seq}` } },
  );
}

function list(data: Obj[], url: string): Response {
  return Response.json({ object: 'list', data, has_more: false, url });
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function createCustomer(call: MockStripeCall): Obj {
  const key = call.idempotencyKey ? `customers:${call.idempotencyKey}` : null;
  const cached = key ? state.idempotent.get(key) : undefined;
  if (cached) return cached;
  const customer: Obj = {
    id: nextId('cus'),
    object: 'customer',
    email: str(call.body['email']),
    name: str(call.body['name']),
    metadata: call.body['metadata'] ?? {},
    created: Math.floor(Date.now() / 1000),
    livemode: false,
  };
  state.customers.set(customer['id'] as string, customer);
  if (key) state.idempotent.set(key, customer);
  return customer;
}

function createSession(call: MockStripeCall): Obj {
  const id = nextId('cs');
  const items = (call.body['line_items'] ?? {}) as Record<string, Obj>;
  let subtotal = 0;
  for (const item of Object.values(items)) {
    const price = (item['price_data'] ?? {}) as Obj;
    subtotal += Number(price['unit_amount'] ?? 0) * Number(item['quantity'] ?? 1);
  }
  const session: Obj = {
    id,
    object: 'checkout.session',
    mode: str(call.body['mode']),
    status: 'open',
    payment_status: 'unpaid',
    customer: str(call.body['customer']),
    client_reference_id: str(call.body['client_reference_id']),
    metadata: call.body['metadata'] ?? {},
    currency: 'usd',
    amount_subtotal: subtotal,
    amount_total: subtotal,
    payment_intent: null,
    success_url: str(call.body['success_url']),
    cancel_url: str(call.body['cancel_url']),
    url: `https://checkout.stripe.com/c/pay/${id}`,
    livemode: false,
  };
  state.sessions.set(id, session);
  return session;
}

/** Card processing (2.9% + 30¢) and the Stripe Tax fee (0.5%), in cents. */
export function defaultFeeDetails(amount: number): { stripe: number; tax: number } {
  return { stripe: Math.round(amount * 0.029) + 30, tax: Math.round(amount * 0.005) };
}

function knownPaymentIntent(id: string): (MockPaymentIntent & { amount: number }) | null {
  const fixture = state.paymentIntents.get(id);
  const session = [...state.sessions.values()].find((s) => s['payment_intent'] === id);
  const amount = fixture?.amount ?? (session ? Number(session['amount_total'] ?? 0) : null);
  if (amount === null) return null;
  return { ...fixture, id, amount };
}

/** Requested expansions, from `expand[0]=a.b` / `expand[]=a.b` query parameters. */
function expansions(query: Record<string, string>): string[] {
  return Object.entries(query)
    .filter(([k]) => k === 'expand' || k.startsWith('expand['))
    .map(([, v]) => v);
}

function balanceTransaction(pi: MockPaymentIntent & { amount: number }): Obj {
  const detail = defaultFeeDetails(pi.amount);
  const fee = pi.fee ?? detail.stripe + detail.tax;
  const feeDetails =
    pi.fee === undefined
      ? [
          {
            amount: detail.stripe,
            currency: 'usd',
            description: 'Stripe processing fees',
            type: 'stripe_fee',
            application: null,
          },
          {
            amount: detail.tax,
            currency: 'usd',
            description: 'Stripe Tax fee',
            type: 'stripe_fee',
            application: null,
          },
        ]
      : [
          {
            amount: fee,
            currency: 'usd',
            description: 'Stripe processing fees',
            type: 'stripe_fee',
            application: null,
          },
        ];
  return {
    id: `txn_of_${pi.id}`,
    object: 'balance_transaction',
    amount: pi.amount,
    currency: 'usd',
    exchange_rate: null,
    fee,
    fee_details: feeDetails,
    net: pi.amount - fee,
    type: 'charge',
    status: 'pending',
  };
}

function chargeOf(pi: MockPaymentIntent & { amount: number }, expandTxn: boolean): Obj {
  return {
    id: `ch_of_${pi.id}`,
    object: 'charge',
    amount: pi.amount,
    currency: 'usd',
    paid: true,
    status: 'succeeded',
    payment_intent: pi.id,
    balance_transaction:
      pi.balanceTransaction === false
        ? null
        : expandTxn
          ? balanceTransaction(pi)
          : `txn_of_${pi.id}`,
  };
}

function paymentIntent(pi: MockPaymentIntent & { amount: number }, expand: string[]): Obj {
  const hasCharge = pi.latestCharge !== false;
  return {
    id: pi.id,
    object: 'payment_intent',
    amount: pi.amount,
    amount_received: hasCharge ? pi.amount : 0,
    currency: 'usd',
    status: hasCharge ? 'succeeded' : 'processing',
    latest_charge: !hasCharge
      ? null
      : expand.some((e) => e === 'latest_charge' || e.startsWith('latest_charge.'))
        ? chargeOf(pi, expand.includes('latest_charge.balance_transaction'))
        : `ch_of_${pi.id}`,
  };
}

async function control(request: Request, url: URL): Promise<Response> {
  if (request.method === 'GET' && url.pathname === '/__mock/calls') {
    const path = url.searchParams.get('path');
    return Response.json(path ? state.calls.filter((c) => c.path === path) : state.calls);
  }
  if (request.method === 'POST' && url.pathname === '/__mock/objects') {
    const body = (await request.json()) as {
      checkoutSessions?: Obj[];
      refunds?: Obj[];
      paymentIntents?: MockPaymentIntent[];
      invoicePayments?: Obj[];
    };
    for (const s of body.checkoutSessions ?? []) state.sessions.set(String(s['id']), s);
    state.refunds.push(...(body.refunds ?? []));
    for (const pi of body.paymentIntents ?? []) state.paymentIntents.set(pi.id, pi);
    state.invoicePayments.push(...(body.invoicePayments ?? []));
    return Response.json({ ok: true });
  }
  if (request.method === 'POST' && url.pathname === '/__mock/reset') {
    Object.assign(state, fresh());
    return Response.json({ ok: true });
  }
  return new Response('unknown mock control endpoint', { status: 404 });
}

export async function mockStripe(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/__mock/')) return control(request, url);

  const text = request.method === 'GET' ? '' : await request.text();
  const call: MockStripeCall = {
    method: request.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    body: decodeForm(text),
    idempotencyKey: request.headers.get('idempotency-key'),
    stripeVersion: request.headers.get('stripe-version'),
    authorized: /^Bearer sk_/.test(request.headers.get('authorization') ?? ''),
  };
  state.calls.push(call);
  if (!call.authorized) return stripeError(401, 'Invalid API Key provided', 'api_key_invalid');

  const { method, path } = call;
  if (method === 'POST' && path === '/v1/customers') return Response.json(createCustomer(call));
  const customerMatch = /^\/v1\/customers\/([^/]+)$/.exec(path);
  if (method === 'GET' && customerMatch) {
    const customer = state.customers.get(decodeURIComponent(customerMatch[1]!));
    return customer ? Response.json(customer) : stripeError(404, 'No such customer');
  }
  if (method === 'DELETE' && customerMatch) {
    const id = decodeURIComponent(customerMatch[1]!);
    if (!state.customers.delete(id)) return stripeError(404, 'No such customer');
    return Response.json({ id, object: 'customer', deleted: true });
  }
  if (method === 'POST' && path === '/v1/checkout/sessions')
    return Response.json(createSession(call));
  if (method === 'GET' && path === '/v1/checkout/sessions') {
    const pi = call.query['payment_intent'];
    const data = [...state.sessions.values()].filter((s) => !pi || s['payment_intent'] === pi);
    return list(data.slice(0, Number(call.query['limit'] ?? 10)), path);
  }
  if (method === 'GET' && path.startsWith('/v1/subscriptions/')) {
    return stripeError(404, `No such subscription: '${path.slice('/v1/subscriptions/'.length)}'`);
  }
  if (method === 'GET' && path === '/v1/refunds') {
    const charge = call.query['charge'];
    return list(
      state.refunds.filter((r) => !charge || r['charge'] === charge),
      path,
    );
  }
  const piMatch = /^\/v1\/payment_intents\/([^/]+)$/.exec(path);
  if (method === 'GET' && piMatch) {
    const id = decodeURIComponent(piMatch[1]!);
    const pi = knownPaymentIntent(id);
    return pi
      ? Response.json(paymentIntent(pi, expansions(call.query)))
      : stripeError(404, `No such payment_intent: '${id}'`);
  }
  const chargeMatch = /^\/v1\/charges\/ch_of_([^/]+)$/.exec(path);
  if (method === 'GET' && chargeMatch) {
    const pi = knownPaymentIntent(decodeURIComponent(chargeMatch[1]!));
    if (pi && pi.latestCharge !== false)
      return Response.json(chargeOf(pi, expansions(call.query).includes('balance_transaction')));
  }
  if (method === 'GET' && path === '/v1/invoice_payments') {
    const { invoice, status } = call.query;
    return list(
      state.invoicePayments.filter(
        (p) => (!invoice || p['invoice'] === invoice) && (!status || p['status'] === status),
      ),
      path,
    );
  }
  return stripeError(404, `Unrecognized request URL (${method}: ${path})`);
}
