import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { mockOpenRouter, OPENROUTER_ORIGIN } from './test/mocks/openrouter.js';
import { mockStripe, STRIPE_ORIGIN } from './test/mocks/stripe.js';

const MOCK_UPSTREAM = 'https://llm.test';
/** Test-only 32-byte secret (base64). */
const TEST_KEY_SECRET = Buffer.alloc(32, 7).toString('base64');

/**
 * Stand-in for every outbound request: Turnstile's siteverify, Google's token endpoint, and api.anthropic.com. Keys starting with `sk-ant-good` are valid;
 * the reply echoes the rest of the key so tests can tell which key was used.
 * `…-slow` keys stream slowly (abort tests).
 *
 * Stripe (api.stripe.com) and OpenRouter (openrouter.ai) are delegated to
 * test/mocks/stripe.ts and test/mocks/openrouter.ts. Mechanism: miniflare's
 * `outboundService` (this function) receives every global `fetch()` made by the
 * Worker, its Durable Objects and the test files themselves, and runs in the
 * Node host process. The mocks are therefore plain Node modules imported here;
 * their module state lives in Node and persists across requests in a run.
 * vitest-pool-workers 0.22 has no `fetchMock` export, so this is the single
 * interception point; a test can drive a mock's control endpoints (if it
 * defines any) with a plain `fetch()` to that origin.
 */
async function mockUpstream(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin === STRIPE_ORIGIN) return mockStripe(request);
  if (url.origin === OPENROUTER_ORIGIN) return mockOpenRouter(request);
  // Cloudflare Turnstile siteverify: the token `pass` is valid.
  if (url.origin === 'https://challenges.cloudflare.com' && url.pathname === '/turnstile/v0/siteverify') {
    const body = (await request.json()) as { response?: string };
    const ok = body.response === 'pass';
    return Response.json({ success: ok, hostname: 'tangent.example.com', 'error-codes': ok ? [] : ['invalid-input-response'] });
  }
  // Google's OAuth token endpoint: the authorization code is the email to sign in as
  // (an email starting with `unverified` comes back with email_verified: false).
  // Better Auth reads the user from the (here unsigned) id_token it gets back.
  if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token') {
    const code = new URLSearchParams(await request.text()).get('code') ?? '';
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const verified = !code.startsWith('unverified');
    const claims = { sub: `google-${code}`, email: code, email_verified: verified, name: 'Test User', iss: 'https://accounts.google.com' };
    return Response.json({ access_token: 'at', refresh_token: 'rt', token_type: 'Bearer', expires_in: 3600, id_token: `${b64({ alg: 'none' })}.${b64(claims)}.` });
  }
  if (url.origin !== MOCK_UPSTREAM) return new Response('blocked in tests', { status: 599 });
  const key = request.headers.get('x-api-key') ?? '';
  if (!key.startsWith('sk-ant-good')) {
    return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 });
  }
  if (url.pathname === '/v1/models') return Response.json({ data: [] });
  if (url.pathname === '/v1/messages/count_tokens') return Response.json({ input_tokens: 5 });
  if (url.pathname !== '/v1/messages') return new Response('not found', { status: 404 });
  const tag = key.slice('sk-ant-good'.length);
  const slow = tag.endsWith('-slow');
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      ctrl.enqueue(enc.encode(frame('message_start', { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } })));
      const pieces = slow ? Array.from({ length: 200 }, () => '.') : [`key=${tag}`];
      for (const text of pieces) {
        if (slow) await new Promise((r) => setTimeout(r, 25));
        ctrl.enqueue(enc.encode(frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })));
      }
      ctrl.enqueue(enc.encode(frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })));
      ctrl.enqueue(enc.encode(frame('message_stop', { type: 'message_stop' })));
      ctrl.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
      return {
        main: './src/index.ts',
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // Test-only bindings: migrations to apply, and dev auth bypass.
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Pin these so tests hold whatever wrangler.jsonc deploys with (and
            // whatever a local .dev.vars sets): no BETTER_AUTH_SECRET (dev bypass,
            // so API tests need no session), share links derived from the request
            // URL. Auth tests (test/auth.test.ts) pass an env with the secret set.
            BETTER_AUTH_SECRET: '',
            PUBLIC_BASE_URL: '',
            DEV_ALLOW_NO_AUTH: 'true',
            AUTO_TITLE: 'false',
            // Sharing on, so the share suites run; test/share.test.ts covers it off.
            DMCA_AGENT_REGISTERED: 'true',
            PROVIDERS: JSON.stringify([
              { id: 'fake', kind: 'fake', label: 'Fake', defaultModel: 'fake-1', models: [{ id: 'fake-1', label: 'Fake 1' }], options: { chunkSize: 4 } },
              { id: 'slow', kind: 'fake', label: 'Slow', defaultModel: 'fake-1', models: [{ id: 'fake-1', label: 'Fake 1' }], options: { chunkSize: 2, delayMs: 30 } },
              // Bring-your-own-key only (no apiKeySecret); talks to mockUpstream below.
              { id: 'ant', kind: 'anthropic', label: 'Ant', baseUrl: MOCK_UPSTREAM, defaultModel: 'claude-test', models: [{ id: 'claude-test', label: 'Claude Test' }] },
            ]),
            KEY_ENCRYPTION_SECRET: TEST_KEY_SECRET,
            // Learn mode and billing (paid credit offered). Multi-user tests pass an env
            // override with auth configured (as auth.test.ts does for BETTER_AUTH_SECRET).
            // The simple-mode provider `tangent`: fake, reporting a fixed cost per call.
            SIMPLE_PROVIDER: JSON.stringify({
              id: 'tangent',
              kind: 'fake',
              label: 'Tangent',
              defaultModel: 'smart',
              models: [{ id: 'smart', label: 'Smart' }, { id: 'simple', label: 'Simple' }],
              // `[echo-request]` in a message makes the reply echo the request's model, output cap
              // and system prompt (the pool tests check what was really sent upstream).
              // `[topic:<id>]` makes it answer `<id>`, which the pool's topic classifier reads as its
              // answer (pool-impact-tagging.test.ts); any other message gets the default fake reply,
              // which is no topic id, so other tests' pool replies are classified but never tagged.
              // `[any-topic:<id>]` answers `<id>` when it is in ANY message sent, so a test can tell
              // whether the classifier was sent a branch's earlier history (it must not be).
              options: {
                chunkSize: 4,
                costUsd: 0.001234,
                echoRequest: '[echo-request]',
                responses: {
                  '[topic:math.algebra]': 'math.algebra',
                  '[topic:history.ancient-rome]': 'history.ancient-rome',
                  '[topic:health.conditions]': 'health.conditions',
                },
                anyMessageResponses: { '[any-topic:math.algebra]': 'math.algebra' },
              },
            }),
            STRIPE_SECRET_KEY: 'sk_test_x',
            STRIPE_WEBHOOK_SECRET: 'whsec_test',
            STRIPE_CREDITS_PRODUCT_ID: 'prod_test',
            // No membership by default (tests that need one pass ANNUAL_FEE_ENABLED: 'true' and
            // STRIPE_MEMBERSHIP_PRICE_ID in an env override), so the other suites generate freely. The
            // fee is off as deployed; the price and credit are the defaults.
            ANNUAL_FEE_ENABLED: 'false',
            STRIPE_MEMBERSHIP_PRICE_ID: '',
            MEMBERSHIP_PRICE_CENTS: '1000',
            MEMBERSHIP_CREDIT_CENTS: '200',
            MEMBERSHIP_WAIVER_CODE: '',
            MARKUP_BPS: '1000',
            // The community pool, on (wrangler.jsonc ships it off). Pool tests isolate themselves with a
            // unique POOL_ACCOUNT_ID per test. The pool model is the fake `tangent` provider's `simple`,
            // priced at 1 µ$ per token each way, so every reply hold (up to 2,048 tokens out) is above
            // the fake's reported cost (0.001234 USD ≈ 1,302 µ$ with the fee) and only the test that
            // targets the clamp hits it. Caps are small so cap tests stay short; the per-minute
            // limits sit above them, so a cap test sees the cap.
            POOL_ENABLED: 'true',
            PERSONAL_CREDIT_ENABLED: 'false',
            // As deployed: tests that simulate purchases turn it on in an env override.
            DEV_PURCHASES_ENABLED: 'false',
            POOL_ACCOUNT_ID: 'pool',
            POOL_MODEL: 'simple',
            MODEL_PRICES: JSON.stringify({ simple: { in: 1_000_000, out: 1_000_000, context: 8_192 } }),
            POOL_MAX_OUTPUT_TOKENS: '2048',
            POOL_FREE_REQUESTS_PER_DAY: '3',
            POOL_FREE_SPEND_MICROS_PER_DAY: '1000000',
            POOL_SUPPORTER_REQUESTS_PER_DAY: '6',
            POOL_SUPPORTER_SPEND_MICROS_PER_DAY: '5000000',
            SUPPORTER_WINDOW_MONTHS: '',
            POOL_USER_PER_MINUTE: '100',
            POOL_IP_PER_MINUTE: '100',
            // Generation lookups made inside Durable Objects (PoolBank's expiry) reach the
            // OpenRouter mock with this key; tests that need no key override it with ''.
            OPENROUTER_SIMPLE_API_KEY: 'sk-or-test',
            // As deployed; pool-featured.test.ts also turns it on (the stub is 404 either way).
            FEATURED_CONVERSATIONS_ENABLED: 'false',
            // Test-only RPC methods (PoolBank.expire, PoolBank.status).
            TEST_SEAMS: 'true',
          },
          ratelimits: {
            CHAT_RATE_LIMITER: { namespace_id: '1002', simple: { limit: 5, period: 60 } },
            KEY_RATE_LIMITER: { namespace_id: '1003', simple: { limit: 1000, period: 60 } },
          },
          outboundService: mockUpstream,
        },
      };
    }),
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
