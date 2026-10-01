import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const MOCK_UPSTREAM = 'https://llm.test';
/** Test-only 32-byte secret (base64). */
const TEST_KEY_SECRET = Buffer.alloc(32, 7).toString('base64');

/**
 * Stand-in for every outbound request: Turnstile's siteverify, Google's token endpoint, and api.anthropic.com. Keys starting with `sk-ant-good` are valid;
 * the reply echoes the rest of the key so tests can tell which key was used.
 * `…-slow` keys stream slowly (abort tests).
 */
async function mockUpstream(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // Cloudflare Turnstile siteverify: the token `pass` is valid.
  if (url.origin === 'https://challenges.cloudflare.com' && url.pathname === '/turnstile/v0/siteverify') {
    const body = (await request.json()) as { response?: string };
    const ok = body.response === 'pass';
    return Response.json({ success: ok, hostname: 'tangent.example.com', 'error-codes': ok ? [] : ['invalid-input-response'] });
  }
  // Google's OAuth token endpoint: the authorization code is the email to sign in as.
  // Better Auth reads the user from the (here unsigned) id_token it gets back.
  if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token') {
    const code = new URLSearchParams(await request.text()).get('code') ?? '';
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const claims = { sub: `google-${code}`, email: code, email_verified: true, name: 'Test User', iss: 'https://accounts.google.com' };
    return Response.json({ access_token: 'at', token_type: 'Bearer', expires_in: 3600, id_token: `${b64({ alg: 'none' })}.${b64(claims)}.` });
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
            PROVIDERS: JSON.stringify([
              { id: 'fake', kind: 'fake', label: 'Fake', defaultModel: 'fake-1', models: [{ id: 'fake-1', label: 'Fake 1' }], options: { chunkSize: 4 } },
              { id: 'slow', kind: 'fake', label: 'Slow', defaultModel: 'fake-1', models: [{ id: 'fake-1', label: 'Fake 1' }], options: { chunkSize: 2, delayMs: 30 } },
              // Bring-your-own-key only (no apiKeySecret); talks to mockUpstream below.
              { id: 'ant', kind: 'anthropic', label: 'Ant', baseUrl: MOCK_UPSTREAM, defaultModel: 'claude-test', models: [{ id: 'claude-test', label: 'Claude Test' }] },
            ]),
            KEY_ENCRYPTION_SECRET: TEST_KEY_SECRET,
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
