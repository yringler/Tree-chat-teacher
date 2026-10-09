import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { coverage } from '../../vitest.coverage.js';
import { MOCK_UPSTREAM, TEST_BINDINGS } from './test/bindings.js';
import { mockOpenRouter, OPENROUTER_ORIGIN } from './test/mocks/openrouter.js';
import { mockPolar, POLAR_ORIGIN } from './test/mocks/polar.js';

/**
 * Stand-in for every outbound request: Turnstile's siteverify, Google's token endpoint, and api.anthropic.com. Keys starting with `sk-ant-good` are valid;
 * the reply echoes the rest of the key so tests can tell which key was used.
 * `…-slow` keys stream slowly (abort tests).
 *
 * Polar's sandbox (sandbox-api.polar.sh) and OpenRouter (openrouter.ai) are
 * delegated to test/mocks/polar.ts and test/mocks/openrouter.ts. Mechanism: miniflare's
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
  if (url.origin === POLAR_ORIGIN) return mockPolar(request);
  if (url.origin === OPENROUTER_ORIGIN) return mockOpenRouter(request);
  // Cloudflare Turnstile siteverify: the token `pass` is valid.
  if (
    url.origin === 'https://challenges.cloudflare.com' &&
    url.pathname === '/turnstile/v0/siteverify'
  ) {
    const body = (await request.json()) as { response?: string };
    const ok = body.response === 'pass';
    return Response.json({
      success: ok,
      hostname: 'tangent.example.com',
      'error-codes': ok ? [] : ['invalid-input-response'],
    });
  }
  // Google's OAuth token endpoint: the authorization code is the email to sign in as
  // (an email starting with `unverified` comes back with email_verified: false).
  // Better Auth reads the user from the (here unsigned) id_token it gets back.
  if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token') {
    const code = new URLSearchParams(await request.text()).get('code') ?? '';
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const verified = !code.startsWith('unverified');
    const claims = {
      sub: `google-${code}`,
      email: code,
      email_verified: verified,
      name: 'Test User',
      iss: 'https://accounts.google.com',
    };
    return Response.json({
      access_token: 'at',
      refresh_token: 'rt',
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: `${b64({ alg: 'none' })}.${b64(claims)}.`,
    });
  }
  if (url.origin !== MOCK_UPSTREAM) return new Response('blocked in tests', { status: 599 });
  const key = request.headers.get('x-api-key') ?? '';
  if (!key.startsWith('sk-ant-good')) {
    return Response.json(
      { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
      { status: 401 },
    );
  }
  if (url.pathname === '/v1/models') return Response.json({ data: [] });
  if (url.pathname === '/v1/messages/count_tokens') return Response.json({ input_tokens: 5 });
  if (url.pathname !== '/v1/messages') return new Response('not found', { status: 404 });
  const tag = key.slice('sk-ant-good'.length);
  const slow = tag.endsWith('-slow');
  const frame = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      ctrl.enqueue(
        enc.encode(
          frame('message_start', {
            type: 'message_start',
            message: { usage: { input_tokens: 3, output_tokens: 1 } },
          }),
        ),
      );
      const pieces = slow ? Array.from({ length: 200 }, () => '.') : [`key=${tag}`];
      for (const text of pieces) {
        if (slow) await new Promise((r) => setTimeout(r, 25));
        ctrl.enqueue(
          enc.encode(
            frame('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text },
            }),
          ),
        );
      }
      ctrl.enqueue(
        enc.encode(
          frame('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 2 },
          }),
        ),
      );
      ctrl.enqueue(enc.encode(frame('message_stop', { type: 'message_stop' })));
      ctrl.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/**
 * Suites that read only vars (through `env`) and pure code: they run in plain
 * Node (the `node` project), with `cloudflare:workers` standing in for
 * workerd's (test/node/cloudflare-workers.ts), and skip the workers runtime.
 */
const NODE_SUITES = [
  'test/config-surface.test.ts',
  'test/cron.test.ts',
  'test/email.test.ts',
  'test/generation-guard.test.ts',
  'test/learn-tiers.test.ts',
  'test/legal.test.ts',
  'test/log.test.ts',
  'test/payments-port.test.ts',
  'test/polar-adapter-map.test.ts',
  'test/pool-pricing.test.ts',
];

/** Many tests sign users in and drive Durable Objects inside workerd; on a shared CI
 * runner the slowest take several seconds, so vitest's 5s default fails them at random. */
const TIMEOUTS = { testTimeout: 30_000, hookTimeout: 30_000 };

export default defineConfig({
  test: {
    // workerd has no V8 coverage: Istanbul instruments the code instead.
    coverage: coverage('istanbul'),
    projects: [
      {
        resolve: {
          alias: {
            'cloudflare:workers': path.join(import.meta.dirname, 'test/node/cloudflare-workers.ts'),
          },
        },
        test: { name: 'node', include: NODE_SUITES, environment: 'node', ...TIMEOUTS },
      },
      {
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
                  ...TEST_BINDINGS,
                },
                d1Databases: { DB: 'tangent-test' },
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
          name: 'workers',
          include: ['test/**/*.test.ts'],
          exclude: NODE_SUITES,
          setupFiles: ['./test/apply-migrations.ts'],
          // One runtime per vitest worker, shared by the suites it runs, instead of a fresh
          // one per file: starting workerd and loading the Worker was ~90% of the suite's
          // time. Suites share D1, the Durable Objects and the cache, so each test makes
          // its own users, trees and pool account (TEST_POOL_ACCOUNT_ID) and never
          // assumes an empty table.
          isolate: false,
          ...TIMEOUTS,
        },
      },
    ],
  },
});
