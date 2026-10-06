import fs from 'node:fs';
import path from 'node:path';
import { expect, type APIRequestContext, type BrowserContext } from '@playwright/test';

/** The server's output (serve.mjs), where EMAIL_PROVIDER=log prints magic links. */
const LOG = path.resolve(import.meta.dirname, '../.state/wrangler.log');
/** The token Cloudflare's always-pass Turnstile test keys accept (serve.mjs). */
const TURNSTILE_TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

let seq = 0;
/** A fresh address per call, so every test is a new user. */
export function newEmail(tag: string): string {
  return `${tag}-${Date.now()}-${++seq}@example.org`;
}

/**
 * Signs `context` in as `email` the way a person does: requests a magic link
 * (the real endpoint, captcha included), reads it from the server log and opens
 * it in the browser. Returns the user id.
 */
export async function signIn(context: BrowserContext, baseURL: string, email: string) {
  const res = await context.request.post('/api/auth/sign-in/magic-link', {
    headers: { origin: baseURL, 'x-captcha-response': TURNSTILE_TEST_TOKEN },
    data: { email, callbackURL: '/', errorCallbackURL: '/login' },
  });
  expect(res.status(), await res.text()).toBe(200);
  let link: string | undefined;
  await expect
    .poll(
      () => {
        const log = fs.readFileSync(LOG, 'utf8');
        const at = log.lastIndexOf(`[email] to=${email} `);
        if (at < 0) return undefined;
        link = /https?:\/\/\S+\/api\/auth\/magic-link\/verify\?\S+/.exec(log.slice(at))?.[0];
        return link;
      },
      { message: `magic link for ${email} in ${LOG}` },
    )
    .toBeTruthy();
  const page = await context.newPage();
  await page.goto(link!);
  await page.close();
  const me = await context.request.get('/api/me');
  expect(me.status()).toBe(200);
  return ((await me.json()) as { userId: string }).userId;
}

/** Headers for the API's same-origin writes. */
export function sameOrigin(baseURL: string) {
  return { origin: baseURL, 'sec-fetch-site': 'same-origin' };
}

let delivery = 0;
/**
 * A delivery of the fake payment provider's webhook (PAYMENT_PROVIDER=fake,
 * apps/worker/src/billing/providers/fake.ts): normalised events, signed by the
 * header `fake-signature: valid`. Goes through the same handler as a real
 * provider's webhook.
 */
export async function paymentWebhook(request: APIRequestContext, events: unknown[]) {
  const res = await request.post('/api/webhooks/fake', {
    headers: { 'fake-signature': 'valid' },
    data: { id: `e2e-delivery-${Date.now()}-${++delivery}`, events },
  });
  expect(res.status(), await res.text()).toBe(200);
}

/** The membership's state now, as the payment provider reports it. */
export function membership(userId: string, status: 'active' | 'canceled', version: number) {
  const now = new Date().toISOString();
  return {
    type: 'membership.changed',
    provider: 'fake',
    occurredAt: now,
    subscriptionRef: `fake:subscription:${userId}`,
    userId,
    customerRef: null,
    status,
    providerStatus: status,
    currentPeriodEnd: status === 'active' ? new Date(Date.now() + 86_400_000).toISOString() : now,
    cancelAtPeriodEnd: false,
    endedAt: status === 'canceled' ? now : null,
    version: String(version).padStart(12, '0'),
  };
}

/** A paid personal top-up of `cents` (no fee), credited to the user's balance. */
export function topUp(userId: string, cents: number) {
  return {
    type: 'payment.succeeded',
    provider: 'fake',
    occurredAt: new Date().toISOString(),
    paymentRef: `fake:order:${userId}:${Date.now()}`,
    purpose: { kind: 'credits', target: 'personal', accountId: null },
    userId,
    customerRef: null,
    currency: 'usd',
    netCents: cents,
    taxCents: 0,
    fee: { cents: 0, estimated: false },
  };
}
