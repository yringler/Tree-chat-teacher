// The vars the Worker under test runs with, over wrangler.jsonc's: the
// workers project hands them to miniflare (vitest.config.ts), and the node
// project's `cloudflare:workers` stand-in (node/cloudflare-workers.ts) builds
// its `env` from them, so both see the same configuration.

/** The upstream of the Anthropic-style mock provider (vitest.config.ts `mockUpstream`). */
export const MOCK_UPSTREAM = 'https://llm.test';
/** Test-only 32-byte secret (base64). */
const TEST_KEY_SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

export const TEST_BINDINGS: Readonly<Record<string, string>> = {
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
    {
      id: 'fake',
      kind: 'fake',
      label: 'Fake',
      defaultModel: 'fake-1',
      models: [{ id: 'fake-1', label: 'Fake 1' }],
      // `[echo-request]`: the reply echoes the request's model and output cap (output-cap.test.ts).
      options: { chunkSize: 4, echoRequest: '[echo-request]' },
    },
    {
      id: 'slow',
      kind: 'fake',
      label: 'Slow',
      defaultModel: 'fake-1',
      models: [{ id: 'fake-1', label: 'Fake 1' }],
      options: { chunkSize: 2, delayMs: 30, webSearch: true },
    },
    // Bring-your-own-key only (no apiKeySecret); talks to mockUpstream below.
    {
      id: 'ant',
      kind: 'anthropic',
      label: 'Ant',
      baseUrl: MOCK_UPSTREAM,
      defaultModel: 'claude-test',
      models: [{ id: 'claude-test', label: 'Claude Test' }],
    },
  ]),
  KEY_ENCRYPTION_SECRET: TEST_KEY_SECRET,
  // Learn mode and billing (paid credit offered). Multi-user tests pass an env
  // override with auth configured (as auth.test.ts does for BETTER_AUTH_SECRET).
  // The built-in provider (the endpoint `openrouter`): fake, reporting a fixed cost per call.
  // Unlike a deployment, Max is the default, as the suites were written against it.
  BUILT_IN_PROVIDER: JSON.stringify({
    id: 'openrouter',
    kind: 'fake',
    label: 'Tangent',
    defaultModel: 'max',
    models: [
      { id: 'max', label: 'Max', tier: 'max' },
      { id: 'normal', label: 'Normal', tier: 'normal' },
    ],
    // `[echo-request]` in a message makes the reply echo the request's model, output cap
    // and system prompt (the pool tests check what was really sent upstream).
    options: {
      chunkSize: 4,
      costUsd: 0.001234,
      echoRequest: '[echo-request]',
    },
  }),
  // Payments through the fake provider (billing/providers/fake.ts): it sells top-ups and the
  // membership; tests change what it does with FAKE_PAYMENTS (JSON) in an env override. The
  // Polar suites build the real adapter themselves, against test/mocks/polar.ts.
  PAYMENT_PROVIDER: 'fake',
  FAKE_PAYMENTS: '',
  // Pinned empty, whatever a local .dev.vars says: `PAYMENT_PROVIDER: 'polar'` in an env
  // override is then "no payments configured".
  POLAR_ACCESS_TOKEN: '',
  POLAR_WEBHOOK_SECRET: '',
  // wrangler.jsonc ships the production product ids; no suite sells against them.
  POLAR_CREDITS_PRODUCT_ID: '',
  POLAR_MEMBERSHIP_PRODUCT_ID: '',
  // No membership required by default (tests that need one pass ANNUAL_FEE_ENABLED: 'true' in
  // an env override), so the other suites generate freely. The price is the default.
  ANNUAL_FEE_ENABLED: 'false',
  MEMBERSHIP_PRICE_CENTS: '1000',
  MEMBERSHIP_WAIVER_CODE: '',
  MARKUP_BPS: '1000',
  // The open pool, on. Pool tests isolate themselves with a unique TEST_POOL_ACCOUNT_ID per
  // test. The pool model is the fake built-in provider's `normal`, priced at 1 µ$ per token
  // each way, so every reply hold (up to 2,048 tokens out) is above the fake's reported
  // cost (0.001234 USD ≈ 1,302 µ$ with the fee) and only the test that targets the clamp
  // hits it. Its window is as large as the deployed pool model's, so the reply's ceiling
  // hold comes from POOL_MAX_INPUT_TOKENS (as deployed), not from a small window. Caps are
  // small so cap tests stay short; the per-minute limits sit above them, so a cap test
  // sees the cap.
  POOL_ENABLED: 'true',
  PERSONAL_CREDIT_ENABLED: 'false',
  // As deployed: tests that simulate purchases turn it on in an env override.
  DEV_PURCHASES_ENABLED: 'false',
  POOL_MODEL: 'normal',
  // `max` is priced too, low, so a credit call on it holds USAGE_HOLD_MICROS like
  // any cheap model (a model without a price can't run on credit).
  MODEL_PRICES: JSON.stringify({
    normal: { in: 1_000_000, out: 1_000_000, context: 1_048_576 },
    max: { in: 10_000, out: 10_000, context: 1_048_576 },
  }),
  POOL_MAX_OUTPUT_TOKENS: '2048',
  POOL_REQUESTS_PER_DAY: '3',
  POOL_SPEND_MICROS_PER_DAY: '1000000',
  POOL_USER_PER_MINUTE: '100',
  POOL_IP_PER_MINUTE: '100',
  // Generation lookups made inside Durable Objects (PoolBank's expiry) reach the
  // OpenRouter mock with this key; tests that need no key override it with ''.
  BUILT_IN_API_KEY: 'sk-or-test',
  // Test-only RPC methods (PoolBank.expire, PoolBank.status) and vars (config.ts TEST_VARS).
  TEST_SEAMS: 'true',
};
