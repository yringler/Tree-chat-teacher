// The one module that reads the Worker's vars and secrets: everything else
// gets typed values from `appConfig(env)` (or `namedSecrets` for the secrets a
// provider config names), and reads only bindings (DB, ASSETS, Durable
// Objects, rate limiters) from env itself (test/env-reads.test.ts).
// docs/configuration.md documents every name in `CONFIG_VARS`.
//
// Values are parsed once per env object and frozen. An empty or unset var is
// its default; a malformed one throws `ConfigError` naming it, so a typo fails
// every request loudly instead of silently meaning something else.
//
// `appConfig` holds parsed values only. Anything that needs the provider
// registry (the pool's default model, whether the built-in provider is
// offered) is resolved by its caller, so this module imports nothing from
// registries.ts or simple-mode.ts.
import { DEFAULT_GROUNDING_POLICY, GROUNDING_POLICIES, type GroundingPolicy } from '@tangent/core';
import {
  BUILT_IN_MAX_OUTPUT_TOKENS,
  DEFAULT_BUILT_IN_MAX_INPUT_TOKENS,
  DEFAULT_OPENROUTER_FEE_BPS,
  DEFAULT_SERVICE_FEE,
  DEFAULT_SYSTEM_PROMPT,
  isReasoningEffort,
  type ReasoningEffort,
  type ServiceFee,
  SHARING_MODES,
  type SharingMode,
} from '@tangent/shared';
import { z } from 'zod';
import type { PolarConfig } from './billing/providers/polar/config.js';
import type { AppEnv } from './env.js';

// ---- Names

/**
 * Every var and secret a deployment may set, by group (the order of
 * docs/configuration.md). The provider keys are read by the name a provider
 * config gives (`apiKeySecret`, `extraHeaderSecrets`; `namedSecrets`); these
 * are the names the default configs use.
 */
export const CONFIG_VARS = [
  // Deployment
  'PUBLIC_BASE_URL',
  'LEGAL_OPERATOR',
  'LEGAL_CONTACT_EMAIL',
  'LEGAL_JURISDICTION',
  'SHARING',
  'SHARE_MIN_ACCOUNT_AGE_MS',
  'SHARE_CREATES_PER_DAY',
  'MODERATION_API_KEY',
  'MODERATOR_EMAIL',
  'ADMIN_USER_IDS',
  'ANDROID_APP_ID',
  // Sign-in and email
  'BETTER_AUTH_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'TURNSTILE_SITE_KEY',
  'TURNSTILE_SECRET_KEY',
  'REVIEWER_SIGN_IN',
  'MAX_USERS',
  'EMAIL_PROVIDER',
  'EMAIL_FROM',
  'RESEND_API_KEY',
  // Power mode and the user's own keys
  'KEY_ENCRYPTION_SECRET',
  'PROVIDERS',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'AI_GATEWAY_TOKEN',
  'SUMMARY_PROVIDER_ID',
  'SUMMARY_MODEL',
  'AUTO_TITLE',
  // Web search
  'GROUNDING',
  'GROUNDING_MAX_RESULTS',
  'GROUNDING_ENGINE',
  'GROUNDING_AUTO_DAILY_CAP',
  // The built-in provider and its models
  'BUILT_IN_API_KEY',
  'BUILT_IN_BACKENDS',
  'BUILT_IN_ANTHROPIC_API_KEY',
  'BUILT_IN_PROVIDER',
  'BUILT_IN_MAX_INPUT_TOKENS',
  'LEARN_NORMAL_MODEL',
  'LEARN_NORMAL_EFFORT',
  'LEARN_NORMAL_REPLY_TOKENS',
  'LEARN_NORMAL_PROVIDER_ORDER',
  'POWER_MAX_MODEL',
  'LEARN_SYSTEM_PROMPT',
  'BACKGROUND_MODEL',
  'BACKGROUND_EFFORT',
  'MODEL_PRICES',
  // Credit, membership and payments
  'SERVICE_FEE_BPS',
  'SERVICE_FEE_FIXED_CENTS',
  'OPENROUTER_FEE_BPS',
  'PERSONAL_CREDIT_ENABLED',
  'ANNUAL_FEE_ENABLED',
  'MEMBERSHIP_PRICE_CENTS',
  'MEMBERSHIP_WAIVER_CODE',
  'PAYMENT_PROVIDER',
  'POLAR_ACCESS_TOKEN',
  'POLAR_WEBHOOK_SECRET',
  'POLAR_SERVER',
  'POLAR_CREDITS_PRODUCT_ID',
  'POLAR_MEMBERSHIP_PRODUCT_ID',
  // The open pool
  'POOL_ENABLED',
  'POOL_SYSTEM_PROMPT',
  'POOL_MAX_INPUT_TOKENS',
  'POOL_MAX_OUTPUT_TOKENS',
  'POOL_MAX_MESSAGE_CHARS',
  'POOL_REQUESTS_PER_DAY',
  'POOL_SPEND_MICROS_PER_DAY',
  'POOL_IP_REQUESTS_PER_DAY',
  'POOL_IP_SPEND_MICROS_PER_DAY',
  'POOL_DAILY_GLOBAL_MICROS',
  'POOL_DAILY_GLOBAL_BPS',
  'POOL_USER_PER_MINUTE',
  'POOL_IP_PER_MINUTE',
  'POOL_MIN_ACCOUNT_AGE_MS',
  // Local development
  'DEV_ALLOW_NO_AUTH',
  'DEV_PURCHASES_ENABLED',
] as const;

/**
 * Read by the test suites only, and only while `TEST_SEAMS` is exactly
 * "true" (except `TEST_SEAMS` itself): never documented, never set by a
 * deployment.
 * - `FAKE_PAYMENTS`: the fake payment provider's options (billing/providers/fake.ts).
 * - `TEST_POOL_ACCOUNT_ID`: the pool's ledger id, so each test gets a pool of its own.
 * - `TEST_MODERATION_URL`: where the moderation classifier is called, so the
 *   end-to-end server screens against its local stand-in (apps/e2e/serve.mjs).
 */
export const TEST_VARS = [
  'TEST_SEAMS',
  'FAKE_PAYMENTS',
  'TEST_POOL_ACCOUNT_ID',
  'TEST_MODERATION_URL',
] as const;

export type ConfigVarName = (typeof CONFIG_VARS)[number] | (typeof TEST_VARS)[number];

/** The vars and secrets as the Worker receives them: strings, any of them unset. */
export type ConfigVars = { [K in ConfigVarName]?: string };

/** The names in `CONFIG_VARS` that are secrets (`wrangler secret put`), never wrangler.jsonc vars. */
export const CONFIG_SECRETS: ReadonlySet<ConfigVarName> = new Set<ConfigVarName>([
  'ADMIN_USER_IDS',
  'MODERATION_API_KEY',
  'BETTER_AUTH_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'TURNSTILE_SECRET_KEY',
  'REVIEWER_SIGN_IN',
  'RESEND_API_KEY',
  'KEY_ENCRYPTION_SECRET',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'AI_GATEWAY_TOKEN',
  'BUILT_IN_API_KEY',
  'BUILT_IN_ANTHROPIC_API_KEY',
  'MEMBERSHIP_WAIVER_CODE',
  'POLAR_ACCESS_TOKEN',
  'POLAR_WEBHOOK_SECRET',
]);

/** The secret behind the built-in provider (its default config's `apiKeySecret`). */
export const BUILT_IN_API_KEY_SECRET = 'BUILT_IN_API_KEY';
/** The operator's Anthropic key, which only the built-in provider's Anthropic backend spends. */
export const BUILT_IN_ANTHROPIC_API_KEY_SECRET = 'BUILT_IN_ANTHROPIC_API_KEY';

/** The hosted backends the built-in provider can run a call on (`BUILT_IN_BACKENDS`, hosted/). */
export const HOSTED_BACKEND_IDS = ['openrouter', 'anthropic'] as const;
export type HostedBackendId = (typeof HOSTED_BACKEND_IDS)[number];

// ---- Defaults

export const DEFAULT_MEMBERSHIP_PRICE_CENTS = 1000;
const DEFAULT_GROUNDING_AUTO_DAILY_CAP = 40;
const DEFAULT_GROUNDING_MAX_RESULTS = 5;
const DEFAULT_GROUNDING_ENGINE = 'exa';
/** OpenRouter accepts 1–25 results per search. */
const MAX_GROUNDING_RESULTS = 25;
/** Turnstile's published test secrets: always pass, always fail, token already spent. */
const TURNSTILE_TEST_SECRETS: readonly string[] = [
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
];
/**
 * The open pool's ledger account id in `credit_grants` / `usage_events`, and
 * its PoolBank's name. Not configurable: another id would orphan the pool's
 * balance and history.
 */
export const POOL_ACCOUNT_ID = 'pool';

// ---- The hosted models: the owner's pick, which the open pool runs too

/** Learn's Normal, and power's (`LEARN_NORMAL_MODEL`). */
export const DEFAULT_LEARN_NORMAL_MODEL = 'anthropic/claude-haiku-5.5';
/** Power's Max, the stronger model it suggests (`POWER_MAX_MODEL`). */
export const DEFAULT_POWER_MAX_MODEL = 'anthropic/claude-sonnet-5.5';
/**
 * The background model (`BACKGROUND_MODEL`): Learn's summaries and titles.
 * Not a tier, though today it is the same model as Normal, asked differently.
 */
export const DEFAULT_BACKGROUND_MODEL = 'anthropic/claude-haiku-5.5';
/**
 * Where Haiku is pinned: Anthropic's own endpoint, so one provider keeps the
 * prompt cache warm; fallbacks stay allowed (openai-compatible.ts
 * `pinnedRouting`), so an outage there doesn't fail the reply.
 */
const HAIKU_PROVIDER_ORDER: readonly string[] = ['anthropic'];

/** How a hosted tier asks its default model when the tier's vars are empty. */
export interface DefaultTierRequest {
  /** The default model these settings are for. */
  model: string;
  request: TierRequestConfig;
}

/**
 * The evaluated settings of each hosted tier's default model: what an empty
 * `*_EFFORT`, `LEARN_*_REPLY_TOKENS` or `*_PROVIDER_ORDER` means while the
 * tier runs that model (`withTierDefaults`). A tier moved to another model
 * starts from that model's own defaults (no effort sent, the default cap,
 * OpenRouter's routing): an effort or a pinned provider tuned for one model
 * says nothing about another. The open pool runs Normal as it is, under its
 * own reply cap (`POOL_MAX_OUTPUT_TOKENS`).
 */
export const DEFAULT_TIER_REQUESTS: Readonly<Record<'normal', DefaultTierRequest>> = {
  normal: {
    model: DEFAULT_LEARN_NORMAL_MODEL,
    request: {
      effort: 'high',
      maxOutputTokens: BUILT_IN_MAX_OUTPUT_TOKENS,
      providerOrder: HAIKU_PROVIDER_ORDER,
    },
  },
};

/**
 * The effort of summaries and titles on the default background model when
 * `BACKGROUND_EFFORT` is empty. Without one they would run at the effort of
 * the model's listing, which on Haiku is Normal's `high`.
 */
export const DEFAULT_BACKGROUND_EFFORT: { model: string; effort: ReasoningEffort } = {
  model: DEFAULT_BACKGROUND_MODEL,
  effort: 'low',
};

/**
 * `request` (parsed from a tier's vars) with `defaults` filling each empty
 * setting, while the tier runs the defaults' model; unchanged on any other.
 */
export function withTierDefaults(
  request: TierRequestConfig,
  defaults: DefaultTierRequest,
  model: string,
): TierRequestConfig {
  if (model !== defaults.model) return request;
  return {
    effort: request.effort ?? defaults.request.effort,
    maxOutputTokens: request.maxOutputTokens ?? defaults.request.maxOutputTokens,
    providerOrder:
      request.providerOrder.length > 0 ? request.providerOrder : defaults.request.providerOrder,
  };
}

/** `BACKGROUND_EFFORT`, else `DEFAULT_BACKGROUND_EFFORT` while background calls run its model. */
export function backgroundEffort(env: AppEnv, model: string): ReasoningEffort | null {
  return (
    appConfig(env).background.effort ??
    (model === DEFAULT_BACKGROUND_EFFORT.model ? DEFAULT_BACKGROUND_EFFORT.effort : null)
  );
}

/**
 * Price of one model in micro-USD per million tokens. `contextTokens` is the
 * model's context window: the input bound of the reply's ceiling hold.
 * `feeBps` grosses the price up like OPENROUTER_FEE_BPS does for reported
 * costs (default: that var); 0 for a provider billed directly.
 * Prompt caching: `cacheReadMicrosPerMTok` prices input tokens read from the
 * cache, `cacheWriteMicrosPerMTok` those written to it (Anthropic: 1.25× the
 * input price). Unset, a read costs the input price (never less than the
 * truth) and a write too, except on explicit-cache models, which
 * `pool/model-prices.ts` gives the write premium.
 * `longContext`: the rates of a call whose input is over `aboveInputTokens`
 * (`pool/pricing.ts` `priceForInput`), for a model whose provider charges the
 * whole request more once its prompt passes a size; its cache prices fall
 * back as the base ones do.
 */
export interface ModelPrice {
  inMicrosPerMTok: number;
  outMicrosPerMTok: number;
  contextTokens: number;
  feeBps?: number;
  cacheReadMicrosPerMTok?: number;
  cacheWriteMicrosPerMTok?: number;
  longContext?: LongContextPrice;
}

/** A model's rates above an input size (`ModelPrice.longContext`), in micro-USD per million tokens. */
export interface LongContextPrice {
  aboveInputTokens: number;
  inMicrosPerMTok: number;
  outMicrosPerMTok: number;
  cacheReadMicrosPerMTok?: number;
  cacheWriteMicrosPerMTok?: number;
}

/**
 * Placeholder prices of power's tiers, Normal (which the open pool runs too)
 * and Max, which the Max usage note compares (tiers.ts `withUsageFactors`;
 * `MAX_USAGE_FACTOR_FALLBACK` is their factor), and of a fallback candidate:
 * OpenRouter list prices when they were added. The daily price sync
 * (pool/model-prices.ts) replaces them with OpenRouter's current list
 * prices; `MODEL_PRICES` overrides or extends them, and an override also
 * wins over the synced price.
 */
export const DEFAULT_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // Normal and the background model: Anthropic's price, $0.10 / $0.50, cache read $0.01, and
  // $0.50 / $2.50, cache read $0.05, for the whole request once its prompt is over 100K tokens
  // (the write premium is added to both for Claude ids, pool/price-table.ts
  // `withCacheWritePrice`). The daily sync replaces the base rates only; the tier stays.
  'anthropic/claude-haiku-5.5': {
    inMicrosPerMTok: 100_000,
    outMicrosPerMTok: 500_000,
    contextTokens: 1_000_000,
    cacheReadMicrosPerMTok: 10_000,
    longContext: {
      aboveInputTokens: 100_000,
      inMicrosPerMTok: 500_000,
      outMicrosPerMTok: 2_500_000,
      cacheReadMicrosPerMTok: 50_000,
    },
  },
  // DeepSeek models, priced so Normal (and with it the pool) can move to one by config alone.
  'deepseek/deepseek-v4-flash': {
    inMicrosPerMTok: 100_000,
    outMicrosPerMTok: 400_000,
    contextTokens: 131_072,
  },
  'deepseek/deepseek-v4-pro': {
    inMicrosPerMTok: 955_260,
    outMicrosPerMTok: 1_910_520,
    contextTokens: 1_048_576,
  },
  'anthropic/claude-sonnet-5.5': {
    inMicrosPerMTok: 2_000_000,
    outMicrosPerMTok: 10_000_000,
    contextTokens: 1_000_000,
  },
  // A fallback candidate, no default: priced so a tier (and with Normal, the
  // pool) can be moved to it by config alone, without a code change.
  'minimax/minimax-m3': {
    inMicrosPerMTok: 300_000,
    outMicrosPerMTok: 1_200_000,
    contextTokens: 1_000_000,
    cacheReadMicrosPerMTok: 60_000,
  },
};

export interface PoolDailyCaps {
  /** Pool replies per UTC day. */
  requestsPerDay: number;
  /** Pool spend (settled charges plus pending holds) per UTC day, micro-USD. */
  spendMicrosPerDay: number;
}

export interface PoolGlobalCap {
  spendMicrosPerDay: number;
  bpsOfMorningBalance: number;
}

/** The pool's caps: one set for everyone, member or not, paying or not. */
export interface PoolCaps {
  /** Per user (and every account that held their pool identity). */
  user: PoolDailyCaps;
  /**
   * The pool's spend per UTC day, all users together: the lower of the two.
   * The share is of the day's base, the pool's balance at 00:00 UTC plus
   * what was added to it since.
   */
  global: PoolGlobalCap;
  /** Per network (IPv4 address or IPv6 /64), all users together. */
  ip: PoolDailyCaps;
}

export interface PoolRateLimits {
  userPerMinute: number;
  ipPerMinute: number;
}

/**
 * How one hosted tier asks its model (`LEARN_NORMAL_*`), as parsed: an
 * empty var is null (or no providers). The tier's model is resolved by the
 * caller (simple-mode.ts), which fills the
 * empty settings from `DEFAULT_TIER_REQUESTS` while the tier runs
 * its default model (`withTierDefaults`); on any other model they stay
 * empty: no effort sent, the default output cap, OpenRouter's own routing.
 */
export interface TierRequestConfig {
  /** `*_EFFORT`: `none`, `low` or `high` (never `max`); null = send none, the model's default. */
  effort: ReasoningEffort | null;
  /**
   * `LEARN_*_REPLY_TOKENS`: the reply's output cap (thinking and answer
   * together), at most BUILT_IN_MAX_OUTPUT_TOKENS (16,384); null = the default
   * for the model's kind (16,384 on a reasoning model, 4,096 otherwise). The
   * pool's is `POOL_MAX_OUTPUT_TOKENS` (`PoolConfig.maxOutputTokens`).
   */
  maxOutputTokens: number | null;
  /** `*_PROVIDER_ORDER`: OpenRouter provider slugs to pin, comma-separated; empty = none. */
  providerOrder: readonly string[];
}

export interface PoolConfig {
  /** `POOL_ACCOUNT_ID`; in the tests, `TEST_POOL_ACCOUNT_ID`. */
  accountId: string;
  systemPrompt: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxMessageChars: number;
  caps: PoolCaps;
  limits: PoolRateLimits;
  minAccountAgeMs: number;
}

/** An OAuth app's credentials; set only when both halves are. */
export interface OAuthApp {
  clientId: string;
  clientSecret: string;
}

export interface AppConfig {
  site: {
    /** `PUBLIC_BASE_URL`; null = derive from the request (local dev and tests). */
    publicBaseUrl: string | null;
    legal: {
      /** `LEGAL_OPERATOR`; null = "the operator of <host>". */
      operator: string | null;
      /** `LEGAL_CONTACT_EMAIL`; null = privacy@<host>. */
      contactEmail: string | null;
      /** `LEGAL_JURISDICTION`; empty = where the operator is established. */
      jurisdiction: string;
    };
    /** Who may publish share links and whose links open (`SHARING`). */
    sharing: SharingMode;
    /** `SHARE_MIN_ACCOUNT_AGE_MS`: how old a non-admin account must be to publish a link. */
    shareMinAccountAgeMs: number;
    /** `SHARE_CREATES_PER_DAY`: new links per user in any 24 hours. */
    shareCreatesPerDay: number;
    /**
     * `MODERATION_API_KEY`: the classifier that screens every publish; null =
     * nothing is screened and `SHARING=everyone` acts as `allowlist`.
     */
    moderationApiKey: string | null;
    /** `MODERATOR_EMAIL`: where an owner whose share was refused is told to write; null = the legal contact. */
    moderatorEmail: string | null;
    /** `TEST_MODERATION_URL` (tests only); null = the provider's endpoint. */
    moderationUrl: string | null;
    adminUserIds: readonly string[];
    /**
     * `ANDROID_APP_ID`: the Play Store package of an Android app that talks to
     * this deployment, which the web apps and the landing page point phones
     * to; null = none.
     */
    androidAppId: string | null;
  };
  auth: {
    /**
     * `BETTER_AUTH_SECRET` exactly as stored (Better Auth signs with it, so
     * trimming would change every signature); null when blank.
     */
    secret: string | null;
    /** `DEV_ALLOW_NO_AUTH` is exactly "true" (honoured only while `secret` is null). */
    devAllowNoAuth: boolean;
    google: OAuthApp | null;
    github: OAuthApp | null;
    turnstileSiteKey: string | null;
    turnstileSecretKey: string | null;
    /**
     * `TURNSTILE_SECRET_KEY` is one of Cloudflare's test secrets, whose passes
     * report a dummy hostname, so tokens aren't pinned to this deployment's.
     */
    turnstileTestSecret: boolean;
    /** `MAX_USERS`: sign-ups stop at this many users; null = no cap. */
    maxUsers: number | null;
    /** `REVIEWER_SIGN_IN`: the app-store reviewer's email and fixed code; null = none. */
    reviewer: ReviewerSignIn | null;
  };
  email: {
    provider: 'resend' | 'log';
    from: string | null;
    resendApiKey: string | null;
  };
  power: {
    /** `KEY_ENCRYPTION_SECRET`; null = bring-your-own-key disabled. */
    keyEncryptionSecret: string | null;
    /** `PROVIDERS` as JSON text (parsed by provider-configs.ts); null = the default configs. */
    providers: string | null;
    summaryProviderId: string | null;
    summaryModel: string | null;
    autoTitle: boolean;
    /** `POWER_MAX_MODEL`: power's Max, on Tangent credit and on the user's own OpenRouter key. */
    maxModel: string;
  };
  grounding: {
    policy: GroundingPolicy;
    maxResults: number;
    engine: string;
    /** Automatic searches per user per UTC day on credit; 0 = no cap. */
    autoDailyCap: number;
  };
  flags: {
    poolEnabled: boolean;
    /**
     * The yearly membership fee is charged and required for generating on the
     * user's own keys, in Learn and power mode alike (`ANNUAL_FEE_ENABLED`,
     * default off; Tangent credit, bought or spent, and the open pool never
     * need it). Off, the membership code paths stay but nothing requires a
     * membership, whatever the payment provider offers.
     */
    annualFeeEnabled: boolean;
    /**
     * Personal credit may be spent before payments are configured (admin-granted
     * credit, `PERSONAL_CREDIT_ENABLED`); a configured payment provider enables it anyway.
     */
    personalCreditEnabled: boolean;
    /**
     * Admins may simulate purchases (`POST /api/admin/credit`, mode
     * `simulated_purchase`) to test funding without a payment (`DEV_PURCHASES_ENABLED`).
     * Never on in production: a simulated purchase is spendable credit nobody paid for.
     */
    devPurchasesEnabled: boolean;
  };
  /** The built-in price table with `MODEL_PRICES` merged over it. */
  prices: Readonly<Record<string, ModelPrice>>;
  /** The models `MODEL_PRICES` prices explicitly: their entry wins over a synced price. */
  priceOverrides: readonly string[];
  billing: {
    /** The fee on a credit purchase (`SERVICE_FEE_BPS`, `SERVICE_FEE_FIXED_CENTS`). */
    serviceFee: ServiceFee;
    /** OpenRouter's credit-purchase fee: part of what the open pool's calls truly cost. */
    openRouterFeeBps: number;
    membershipPriceCents: number;
    /** `MEMBERSHIP_WAIVER_CODE`; null = no code redemption. */
    membershipWaiverCode: string | null;
  };
  payments: {
    provider: 'polar' | 'fake';
    /** Polar's settings; null unless both of its secrets are set. */
    polar: PolarConfig | null;
    /** `FAKE_PAYMENTS` (tests only): the fake provider's options as JSON. */
    fake: string | null;
  };
  builtIn: {
    /** `BUILT_IN_BACKENDS`: the backends a built-in call may run on, first choice first. */
    backends: readonly HostedBackendId[];
    /** `BUILT_IN_PROVIDER` as JSON text (parsed by simple-mode.ts); null = OpenRouter, Normal and Max. */
    provider: string | null;
    /** Per-call input cap of Learn and of Tangent credit in power. */
    maxInputTokens: number;
  };
  learn: {
    /** `LEARN_NORMAL_MODEL`: Normal, in Learn and power. */
    normalModel: string;
    normal: TierRequestConfig;
    /** `LEARN_SYSTEM_PROMPT`; null = DEFAULT_SYSTEM_PROMPT. */
    systemPrompt: string | null;
  };
  background: {
    model: string;
    /** `BACKGROUND_EFFORT` as parsed (null = empty: `backgroundEffort` resolves it). */
    effort: ReasoningEffort | null;
  };
  pool: PoolConfig;
}

// ---- Parsers: `raw` is the var's value, `name` names it in the error.

/** A var holding a value its parser can't read. */
export class ConfigError extends Error {
  constructor(name: string, raw: string, expected: string) {
    super(`Invalid ${name}=${JSON.stringify(raw)}: expected ${expected}`);
    this.name = 'ConfigError';
  }
}

export type ReviewerSignIn = { email: string; code: string };

/**
 * `REVIEWER_SIGN_IN`: `<email>:<6 digits>`; empty gives null. The email is
 * lowercased, as Better Auth stores it. The error leaves the value out: it is
 * a secret.
 */
export function reviewerSignInVar(raw: string | undefined): ReviewerSignIn | null {
  const s = raw?.trim();
  if (!s) return null;
  const m = /^([^\s:@]+@[^\s:@]+):(\d{6})$/.exec(s);
  if (!m) throw new Error('Invalid REVIEWER_SIGN_IN: expected <email>:<6 digits>');
  return { email: m[1]!.toLowerCase(), code: m[2]! };
}

/**
 * An Android application id (`com.example.app`): two or more dot-separated
 * segments, each a letter then letters, digits or underscores, as Gradle
 * accepts. Null when empty or unset.
 */
export function androidAppIdVar(raw: string | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  if (!/^[A-Za-z]\w*(\.[A-Za-z]\w*)+$/.test(s))
    throw new Error('Invalid ANDROID_APP_ID: expected an application id like com.example.app');
  return s;
}

/** The trimmed value; null when empty or unset. */
function textVar(raw: string | undefined): string | null {
  return raw?.trim() || null;
}

/** An integer in `[min, max]` (default: non-negative); empty gives `fallback`. */
export function intVar(
  name: string,
  raw: string | undefined,
  fallback: number,
  { min = 0, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): number {
  const s = raw?.trim();
  if (!s) return fallback;
  const n = /^\d+$/.test(s) ? Number(s) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new ConfigError(name, s, `an integer from ${min} to ${max}`);
  return n;
}

/** `true` or `false`, in any case; empty gives `fallback`. */
export function boolVar(name: string, raw: string | undefined, fallback: boolean): boolean {
  const s = raw?.trim();
  if (!s) return fallback;
  const lower = s.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  throw new ConfigError(name, s, 'true or false');
}

/**
 * A switch that weakens security (`DEV_ALLOW_NO_AUTH`, `TEST_SEAMS`): on only
 * for exactly `true`, off when empty or exactly `false`. Anything else, even
 * `TRUE` or ` true`, throws, so a near-miss is never read either way.
 */
export function strictFlagVar(name: string, raw: string | undefined): boolean {
  if (raw === 'true') return true;
  if (raw === undefined || raw === '' || raw === 'false') return false;
  throw new ConfigError(name, raw, 'exactly "true", or "false" / empty');
}

/** One of `values` (any case); empty gives `fallback`. */
export function enumVar<T extends string>(
  name: string,
  raw: string | undefined,
  values: readonly T[],
  fallback: T,
): T {
  const s = raw?.trim();
  if (!s) return fallback;
  const match = values.find((v) => v === s.toLowerCase());
  if (match === undefined) throw new ConfigError(name, s, values.join(', '));
  return match;
}

/**
 * `*_EFFORT`: `none`, `low` or `high` (any case); empty gives null (the
 * model's default). `max` and `xhigh` are refused like any other value:
 * Tangent never asks for a model's top effort.
 */
export function effortVar(name: string, raw: string | undefined): ReasoningEffort | null {
  const s = raw?.trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (isReasoningEffort(lower)) return lower;
  throw new ConfigError(name, s, 'none, low or high');
}

/** Comma-separated; blanks dropped. */
function listVar(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * `BUILT_IN_BACKENDS`: comma-separated backend ids (any case), in order, each
 * at most once; empty is OpenRouter alone.
 */
export function backendsVar(name: string, raw: string | undefined): HostedBackendId[] {
  const ids = listVar(raw).map((s) => s.toLowerCase());
  if (ids.length === 0) return ['openrouter'];
  const expected = `a comma-separated list of ${HOSTED_BACKEND_IDS.join(', ')}, each once`;
  const known = ids.filter((id): id is HostedBackendId =>
    (HOSTED_BACKEND_IDS as readonly string[]).includes(id),
  );
  if (known.length !== ids.length || new Set(known).size !== known.length)
    throw new ConfigError(name, raw?.trim() ?? '', expected);
  return known;
}

/** JSON validated by `schema`; empty gives `fallback`. */
export function jsonVar<T>(
  name: string,
  raw: string | undefined,
  schema: z.ZodType<T>,
  fallback: T,
): T {
  const s = raw?.trim();
  if (!s) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    throw new ConfigError(name, s, 'JSON');
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new ConfigError(name, s, z.prettifyError(result.error));
  return result.data;
}

const nonNegativeInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * `MODEL_PRICES`: `{"<model>": {"in": µ$/MTok, "out": µ$/MTok, "context": tokens,
 * "feeBps"?: bps, "cacheRead"?: µ$/MTok, "cacheWrite"?: µ$/MTok, "long"?: {"above":
 * tokens, "in", "out", "cacheRead"?, "cacheWrite"?}}}`.
 */
const modelPricesSchema = z.record(
  z.string().min(1),
  z.strictObject({
    in: nonNegativeInt,
    out: nonNegativeInt,
    context: nonNegativeInt.positive(),
    feeBps: nonNegativeInt.optional(),
    cacheRead: nonNegativeInt.optional(),
    cacheWrite: nonNegativeInt.optional(),
    long: z
      .strictObject({
        above: nonNegativeInt.positive(),
        in: nonNegativeInt,
        out: nonNegativeInt,
        cacheRead: nonNegativeInt.optional(),
        cacheWrite: nonNegativeInt.optional(),
      })
      .optional(),
  }),
);

/** The optional cache prices of a `MODEL_PRICES` entry or its `long` tier, as `ModelPrice` fields. */
function cachePrices(p: { cacheRead?: number | undefined; cacheWrite?: number | undefined }) {
  return {
    ...(p.cacheRead !== undefined ? { cacheReadMicrosPerMTok: p.cacheRead } : {}),
    ...(p.cacheWrite !== undefined ? { cacheWriteMicrosPerMTok: p.cacheWrite } : {}),
  };
}

function parsePrices(raw: string | undefined): {
  prices: Readonly<Record<string, ModelPrice>>;
  overrides: string[];
} {
  const overrides = jsonVar('MODEL_PRICES', raw, modelPricesSchema, {});
  const prices: Record<string, ModelPrice> = { ...DEFAULT_MODEL_PRICES };
  for (const [model, p] of Object.entries(overrides)) {
    prices[model] = {
      inMicrosPerMTok: p.in,
      outMicrosPerMTok: p.out,
      contextTokens: p.context,
      ...(p.feeBps !== undefined ? { feeBps: p.feeBps } : {}),
      ...cachePrices(p),
      ...(p.long
        ? {
            longContext: {
              aboveInputTokens: p.long.above,
              inMicrosPerMTok: p.long.in,
              outMicrosPerMTok: p.long.out,
              ...cachePrices(p.long),
            },
          }
        : {}),
    };
  }
  return { prices, overrides: Object.keys(overrides) };
}

// ---- Reading env

function parse(env: AppEnv): AppConfig {
  const v = (name: ConfigVarName): string | undefined => env[name];
  const text = (name: ConfigVarName) => textVar(v(name));
  const int = (name: ConfigVarName, fallback: number, range?: { min?: number; max?: number }) =>
    intVar(name, v(name), fallback, range);
  const bool = (name: ConfigVarName, fallback: boolean) => boolVar(name, v(name), fallback);
  const effort = (name: ConfigVarName) => effortVar(name, v(name));
  const oauth = (id: ConfigVarName, secret: ConfigVarName): OAuthApp | null => {
    const clientId = text(id);
    const clientSecret = text(secret);
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  };
  const tier = (
    effortName: ConfigVarName,
    replyName: ConfigVarName,
    orderName: ConfigVarName,
  ): TierRequestConfig => {
    const reply = int(replyName, 0, { min: 1, max: BUILT_IN_MAX_OUTPUT_TOKENS });
    return {
      effort: effort(effortName),
      maxOutputTokens: reply === 0 ? null : reply,
      providerOrder: listVar(v(orderName)),
    };
  };

  const testSeams = strictFlagVar('TEST_SEAMS', v('TEST_SEAMS'));
  const paymentProvider = enumVar(
    'PAYMENT_PROVIDER',
    v('PAYMENT_PROVIDER'),
    ['polar', 'fake'],
    'polar',
  );
  if (paymentProvider === 'fake' && !testSeams)
    throw new Error('PAYMENT_PROVIDER=fake is only allowed in tests (TEST_SEAMS)');
  const polarAccessToken = text('POLAR_ACCESS_TOKEN');
  const polarWebhookSecret = text('POLAR_WEBHOOK_SECRET');
  // Parsed whether or not Polar's secrets are set, so a bad value fails before they are.
  const polar = {
    // The sandbox unless set, so a missing var can't charge real cards.
    server: enumVar('POLAR_SERVER', v('POLAR_SERVER'), ['sandbox', 'production'], 'sandbox'),
    creditsProductId: text('POLAR_CREDITS_PRODUCT_ID'),
    membershipProductId: text('POLAR_MEMBERSHIP_PRODUCT_ID'),
  };
  const turnstileSecretKey = text('TURNSTILE_SECRET_KEY');
  const turnstileTestSecret =
    turnstileSecretKey !== null && TURNSTILE_TEST_SECRETS.includes(turnstileSecretKey);
  // A test secret lets every client through, so a deployment taking real
  // payments refuses one rather than run without its bot check.
  if (turnstileTestSecret && paymentProvider === 'polar' && polar.server === 'production')
    throw new Error(
      "TURNSTILE_SECRET_KEY is one of Turnstile's test secrets, which POLAR_SERVER=production refuses",
    );
  const prices = parsePrices(v('MODEL_PRICES'));
  const authSecret = v('BETTER_AUTH_SECRET');

  return {
    site: {
      publicBaseUrl: text('PUBLIC_BASE_URL'),
      legal: {
        operator: text('LEGAL_OPERATOR'),
        contactEmail: text('LEGAL_CONTACT_EMAIL'),
        jurisdiction: text('LEGAL_JURISDICTION') ?? '',
      },
      sharing: enumVar('SHARING', v('SHARING'), SHARING_MODES, 'allowlist'),
      shareMinAccountAgeMs: int('SHARE_MIN_ACCOUNT_AGE_MS', 86_400_000),
      shareCreatesPerDay: int('SHARE_CREATES_PER_DAY', 20, { min: 1 }),
      moderationApiKey: text('MODERATION_API_KEY'),
      moderatorEmail: text('MODERATOR_EMAIL'),
      moderationUrl: testSeams ? text('TEST_MODERATION_URL') : null,
      adminUserIds: listVar(v('ADMIN_USER_IDS')),
      androidAppId: androidAppIdVar(v('ANDROID_APP_ID')),
    },
    auth: {
      secret: authSecret?.trim() ? authSecret : null,
      devAllowNoAuth: strictFlagVar('DEV_ALLOW_NO_AUTH', v('DEV_ALLOW_NO_AUTH')),
      google: oauth('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'),
      github: oauth('GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'),
      turnstileSiteKey: text('TURNSTILE_SITE_KEY'),
      turnstileSecretKey,
      turnstileTestSecret,
      maxUsers: int('MAX_USERS', 0) || null,
      reviewer: reviewerSignInVar(v('REVIEWER_SIGN_IN')),
    },
    email: {
      provider: enumVar('EMAIL_PROVIDER', v('EMAIL_PROVIDER'), ['resend', 'log'], 'resend'),
      from: text('EMAIL_FROM'),
      resendApiKey: text('RESEND_API_KEY'),
    },
    power: {
      keyEncryptionSecret: text('KEY_ENCRYPTION_SECRET'),
      providers: text('PROVIDERS'),
      summaryProviderId: text('SUMMARY_PROVIDER_ID'),
      summaryModel: text('SUMMARY_MODEL'),
      autoTitle: bool('AUTO_TITLE', true),
      maxModel: text('POWER_MAX_MODEL') ?? DEFAULT_POWER_MAX_MODEL,
    },
    grounding: {
      policy: enumVar('GROUNDING', v('GROUNDING'), GROUNDING_POLICIES, DEFAULT_GROUNDING_POLICY),
      maxResults: int('GROUNDING_MAX_RESULTS', DEFAULT_GROUNDING_MAX_RESULTS, {
        min: 1,
        max: MAX_GROUNDING_RESULTS,
      }),
      engine: text('GROUNDING_ENGINE') ?? DEFAULT_GROUNDING_ENGINE,
      autoDailyCap: int('GROUNDING_AUTO_DAILY_CAP', DEFAULT_GROUNDING_AUTO_DAILY_CAP),
    },
    flags: {
      poolEnabled: bool('POOL_ENABLED', false),
      annualFeeEnabled: bool('ANNUAL_FEE_ENABLED', false),
      personalCreditEnabled: bool('PERSONAL_CREDIT_ENABLED', false),
      devPurchasesEnabled: bool('DEV_PURCHASES_ENABLED', false),
    },
    prices: prices.prices,
    priceOverrides: prices.overrides,
    billing: {
      serviceFee: {
        bps: int('SERVICE_FEE_BPS', DEFAULT_SERVICE_FEE.bps),
        fixedCents: int('SERVICE_FEE_FIXED_CENTS', DEFAULT_SERVICE_FEE.fixedCents),
      },
      openRouterFeeBps: int('OPENROUTER_FEE_BPS', DEFAULT_OPENROUTER_FEE_BPS),
      membershipPriceCents: int('MEMBERSHIP_PRICE_CENTS', DEFAULT_MEMBERSHIP_PRICE_CENTS),
      membershipWaiverCode: text('MEMBERSHIP_WAIVER_CODE'),
    },
    payments: {
      provider: paymentProvider,
      polar:
        polarAccessToken && polarWebhookSecret
          ? {
              accessToken: polarAccessToken,
              webhookSecret: polarWebhookSecret,
              // The sandbox unless set, so a missing var can't charge real cards.
              ...polar,
            }
          : null,
      fake: testSeams ? text('FAKE_PAYMENTS') : null,
    },
    builtIn: {
      backends: backendsVar('BUILT_IN_BACKENDS', v('BUILT_IN_BACKENDS')),
      provider: text('BUILT_IN_PROVIDER'),
      maxInputTokens: int('BUILT_IN_MAX_INPUT_TOKENS', DEFAULT_BUILT_IN_MAX_INPUT_TOKENS, {
        min: 1,
      }),
    },
    learn: {
      normalModel: text('LEARN_NORMAL_MODEL') ?? DEFAULT_LEARN_NORMAL_MODEL,
      normal: tier(
        'LEARN_NORMAL_EFFORT',
        'LEARN_NORMAL_REPLY_TOKENS',
        'LEARN_NORMAL_PROVIDER_ORDER',
      ),
      systemPrompt: text('LEARN_SYSTEM_PROMPT'),
    },
    background: {
      model: text('BACKGROUND_MODEL') ?? DEFAULT_BACKGROUND_MODEL,
      effort: effort('BACKGROUND_EFFORT'),
    },
    pool: {
      accountId: (testSeams && text('TEST_POOL_ACCOUNT_ID')) || POOL_ACCOUNT_ID,
      systemPrompt:
        text('POOL_SYSTEM_PROMPT') ?? text('LEARN_SYSTEM_PROMPT') ?? DEFAULT_SYSTEM_PROMPT,
      maxInputTokens: int('POOL_MAX_INPUT_TOKENS', 16_000, { min: 1 }),
      maxOutputTokens: int('POOL_MAX_OUTPUT_TOKENS', BUILT_IN_MAX_OUTPUT_TOKENS, { min: 1 }),
      maxMessageChars: int('POOL_MAX_MESSAGE_CHARS', 4000, { min: 1 }),
      caps: {
        user: {
          requestsPerDay: int('POOL_REQUESTS_PER_DAY', 10),
          spendMicrosPerDay: int('POOL_SPEND_MICROS_PER_DAY', 100_000),
        },
        global: {
          spendMicrosPerDay: int('POOL_DAILY_GLOBAL_MICROS', 5_000_000),
          bpsOfMorningBalance: int('POOL_DAILY_GLOBAL_BPS', 2_000),
        },
        ip: {
          requestsPerDay: int('POOL_IP_REQUESTS_PER_DAY', 60),
          spendMicrosPerDay: int('POOL_IP_SPEND_MICROS_PER_DAY', 300_000),
        },
      },
      limits: {
        userPerMinute: int('POOL_USER_PER_MINUTE', 6, { min: 1 }),
        ipPerMinute: int('POOL_IP_PER_MINUTE', 20, { min: 1 }),
      },
      minAccountAgeMs: int('POOL_MIN_ACCOUNT_AGE_MS', 0),
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const cache = new WeakMap<AppEnv, AppConfig>();

/** The parsed, frozen config of `env` (parsed once per env object); throws `ConfigError`. */
export function appConfig(env: AppEnv): AppConfig {
  let config = cache.get(env);
  if (!config) {
    config = deepFreeze(parse(env));
    cache.set(env, config);
  }
  return config;
}

/**
 * The secrets named in `names` that env holds (as stored), and no others:
 * the keys a provider config names by `apiKeySecret` / `extraHeaderSecrets`,
 * which may be any name (PROVIDERS, BUILT_IN_PROVIDER).
 */
export function namedSecrets(env: AppEnv, names: ReadonlySet<string>): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string' && names.has(k)) secrets[k] = v;
  }
  return secrets;
}
