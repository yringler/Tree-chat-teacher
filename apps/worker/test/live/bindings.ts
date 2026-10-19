// What the live contract suite runs the Worker with on top of wrangler.jsonc's vars:
// switches that make a harness possible, and nothing that decides how a provider is
// asked or what a call costs, so every call is the one production makes. Imported by
// vitest.live.config.ts (Node) and by the guard in 00-preflight.live.ts (workerd).
import type { ConfigVarName } from '../../src/config.js';

/** The control origin the host answers for the suite (vitest.live.config.ts). */
export const LIVE_CONTROL = 'https://live.test';

/**
 * The harness switches: the dev bypass (no session needed for the Durable Object smoke
 * tests' plain routes), the test seams and fake payment provider (credit is then sold,
 * without a card), the open pool and credit on, sign-ups uncapped, no publishing
 * classifier. Sign-in itself uses session-client.ts's `authEnv`.
 */
export const LIVE_HARNESS_BINDINGS: Readonly<Partial<Record<ConfigVarName, string>>> = {
  BETTER_AUTH_SECRET: '',
  PUBLIC_BASE_URL: '',
  DEV_ALLOW_NO_AUTH: 'true',
  MAX_USERS: '',
  TEST_SEAMS: 'true',
  PAYMENT_PROVIDER: 'fake',
  FAKE_PAYMENTS: '',
  POLAR_ACCESS_TOKEN: '',
  POLAR_WEBHOOK_SECRET: '',
  POLAR_CREDITS_PRODUCT_ID: '',
  POLAR_MEMBERSHIP_PRODUCT_ID: '',
  POOL_ENABLED: 'true',
  PERSONAL_CREDIT_ENABLED: 'true',
  MODERATION_API_KEY: '',
};

/**
 * The vars that choose a provider, a model, how it is asked or what a call is charged.
 * The suite must run with the deployed values of every one of them (the guard checks
 * the harness sets none).
 */
export const PRODUCTION_ONLY_VARS: readonly ConfigVarName[] = [
  'PROVIDERS',
  'BUILT_IN_PROVIDER',
  'BUILT_IN_BACKENDS',
  'BUILT_IN_MAX_INPUT_TOKENS',
  'LEARN_NORMAL_MODEL',
  'LEARN_NORMAL_EFFORT',
  'LEARN_NORMAL_REPLY_TOKENS',
  'LEARN_NORMAL_PROVIDER_ORDER',
  'POWER_MAX_MODEL',
  'BACKGROUND_MODEL',
  'BACKGROUND_EFFORT',
  'MODEL_PRICES',
  'OPENROUTER_FEE_BPS',
  'SERVICE_FEE_BPS',
  'SERVICE_FEE_FIXED_CENTS',
  'POOL_MODEL',
  'POOL_EFFORT',
  'POOL_PROVIDER_ORDER',
  'POOL_SYSTEM_PROMPT',
  'POOL_MAX_INPUT_TOKENS',
  'POOL_MAX_OUTPUT_TOKENS',
  'GROUNDING',
  'GROUNDING_MAX_RESULTS',
  'GROUNDING_ENGINE',
  'GROUNDING_AUTO_DAILY_CAP',
];

/** The production secret names the keys reach the Worker under. */
export const LIVE_KEY_BINDINGS = {
  openrouter: ['BUILT_IN_API_KEY', 'OPENROUTER_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
} as const satisfies Record<string, readonly ConfigVarName[]>;
