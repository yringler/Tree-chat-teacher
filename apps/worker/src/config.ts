// The one config module: every cap, price, markup,
// limit and flag the billing code and the open pool read. Values come
// from wrangler.jsonc `vars` (strings), parsed once per env object and frozen;
// empty or malformed values fall back to the defaults below, and the safety
// clamps at the end log when they change a value.
//
// `appConfig` holds raw parsed values only. Anything that needs the provider
// registry (the pool's default model, whether the built-in provider is
// offered) is resolved by its caller, so this module imports nothing from
// services.ts or simple-mode.ts.
import {
  BUILT_IN_MAX_OUTPUT_TOKENS,
  DEFAULT_SYSTEM_PROMPT,
  isReasoningEffort,
  POOL_NOTICE_VERSION,
  type ReasoningEffort,
} from '@tangent/shared';
import { z } from 'zod';
import type { AppEnv } from './env.js';

// ---- Defaults

export const DEFAULT_USAGE_HOLD_MICROS = 20_000;
export const DEFAULT_USAGE_MAX_PENDING = 6;
export const DEFAULT_MARKUP_BPS = 1000;
/** OpenRouter's fee on credit purchases (5.5%; higher for top-ups under ~$15, see README). */
export const DEFAULT_OPENROUTER_FEE_BPS = 550;
export const DEFAULT_MEMBERSHIP_PRICE_CENTS = 1000;
export const DEFAULT_SIMPLE_MAX_INPUT_TOKENS = 60_000;

// ---- The hosted models (docs/DECISIONS.md "Hosted models from the eval")

/** Learn's Normal tier, its default (`SIMPLE_NORMAL_MODEL`). */
export const DEFAULT_SIMPLE_NORMAL_MODEL = 'deepseek/deepseek-v4.1-flash';
/** Learn's Max tier (`SIMPLE_MAX_MODEL`). */
export const DEFAULT_SIMPLE_MAX_MODEL = 'anthropic/claude-sonnet-5.5';
/**
 * The background model (`SIMPLE_FAST_MODEL`): Learn's summaries and titles,
 * and the open pool's default model. Not a tier, though today it is the same
 * model as Normal, asked differently.
 */
export const DEFAULT_SIMPLE_FAST_MODEL = 'deepseek/deepseek-v4.1-flash';

/**
 * Where V4.1 Flash is pinned: StreamLake, then DeepInfra, both fp8 and both
 * caching. Not `deepseek` (first-party): OpenRouter drops it for an account
 * that denies paid-data training, and the fallbacks then scatter across
 * about 28 providers, fp4 ones included, and lose the prompt cache.
 */
const V4_1_FLASH_PROVIDER_ORDER: readonly string[] = ['streamlake/fp8', 'deepinfra/fp8'];

/** How a hosted tier asks its default model when the tier's vars are empty. */
export interface DefaultTierRequest {
  /** The default model these settings are for. */
  model: string;
  request: TierRequestConfig;
}

/**
 * The evaluated settings of each hosted tier's default model (wrangler.jsonc
 * sets the same values): what an empty `*_EFFORT`, `SIMPLE_*_REPLY_TOKENS` or
 * `*_PROVIDER_ORDER` means while the tier runs that model (`withTierDefaults`).
 * A tier moved to another model starts from that model's own defaults (no
 * effort sent, the default cap, OpenRouter's routing): an effort or a pinned
 * provider tuned for one model says nothing about another. The pool's reply
 * cap is `POOL_MAX_OUTPUT_TOKENS` (8,192), whatever its model.
 */
export const DEFAULT_TIER_REQUESTS: Readonly<
  Record<'normal' | 'max' | 'pool', DefaultTierRequest>
> = {
  normal: {
    model: DEFAULT_SIMPLE_NORMAL_MODEL,
    request: {
      effort: 'high',
      maxOutputTokens: BUILT_IN_MAX_OUTPUT_TOKENS,
      providerOrder: V4_1_FLASH_PROVIDER_ORDER,
    },
  },
  max: {
    model: DEFAULT_SIMPLE_MAX_MODEL,
    request: { effort: null, maxOutputTokens: BUILT_IN_MAX_OUTPUT_TOKENS, providerOrder: [] },
  },
  pool: {
    model: DEFAULT_SIMPLE_FAST_MODEL,
    request: { effort: 'low', maxOutputTokens: null, providerOrder: V4_1_FLASH_PROVIDER_ORDER },
  },
};

/**
 * The effort of summaries and titles on the default background model when
 * `SIMPLE_FAST_EFFORT` is empty. Without one they would run at the effort of
 * the model's listing, which on V4.1 Flash is Normal's `high`.
 */
export const DEFAULT_BACKGROUND_EFFORT: { model: string; effort: ReasoningEffort } = {
  model: DEFAULT_SIMPLE_FAST_MODEL,
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

/** `SIMPLE_FAST_EFFORT`, else `DEFAULT_BACKGROUND_EFFORT` while background calls run its model. */
export function backgroundEffort(env: AppEnv, model: string): ReasoningEffort | null {
  return (
    appConfig(env).simple.backgroundEffort ??
    (model === DEFAULT_BACKGROUND_EFFORT.model ? DEFAULT_BACKGROUND_EFFORT.effort : null)
  );
}

/** The open pool's ledger account id (`POOL_ACCOUNT_ID`). */
export const DEFAULT_POOL_ACCOUNT_ID = 'pool';
/** The expiry alarm needs this much slack between a call's timeout and its reservation's TTL. */
const POOL_TTL_SLACK_MS = 60_000;

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
 */
export interface ModelPrice {
  inMicrosPerMTok: number;
  outMicrosPerMTok: number;
  contextTokens: number;
  feeBps?: number;
  cacheReadMicrosPerMTok?: number;
  cacheWriteMicrosPerMTok?: number;
}

/**
 * Placeholder prices of the default pool model, of Learn's tiers, Normal
 * and Max, which the Max usage note compares (tiers.ts `withUsageFactors`;
 * `MAX_USAGE_FACTOR_FALLBACK` is their factor), of the previous defaults and
 * of a fallback candidate: OpenRouter list prices when they were added, or
 * (V4.1 Flash) the price of its pinned providers. The daily price sync
 * (pool/model-prices.ts) replaces them with OpenRouter's current list prices;
 * `MODEL_PRICES` overrides or extends them, and an override also wins over
 * the synced price.
 */
export const DEFAULT_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // Normal and the pool. The price of StreamLake (and DeepSeek's own): $0.15 / $0.60, cache
  // read $0.003. OpenRouter's model-level list price ($0.0356 / $1.00) is no route's price, and
  // as the pool's `max_price` it would admit only fp4 endpoints, so wrangler.jsonc repeats this
  // entry in `MODEL_PRICES`, where it wins over the daily sync (docs/DECISIONS.md "Hosted
  // models from the eval").
  'deepseek/deepseek-v4.1-flash': {
    inMicrosPerMTok: 150_000,
    outMicrosPerMTok: 600_000,
    contextTokens: 1_048_576,
    cacheReadMicrosPerMTok: 3_000,
  },
  // The previous pool and Normal models, priced so moving back is a config change.
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
  // A fallback candidate, no default: priced so the pool (`POOL_MODEL`) or a
  // tier can be moved to it by config alone (docs/DECISIONS.md "Hosted tier config").
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

export interface PoolOverage {
  /** Window over which clamped overage is summed. */
  windowMs: number;
  /** Above this, the pool refuses every reservation (`unpriced`). */
  maxMicros: number;
}

/**
 * How one hosted tier asks its model (`SIMPLE_NORMAL_*`, `SIMPLE_MAX_*`,
 * `POOL_*`), as parsed: an empty var is null (or no providers). The tier's
 * model is resolved by the caller (simple-mode.ts, pool/params.ts), which
 * fills the empty settings from `DEFAULT_TIER_REQUESTS` while the tier runs
 * its default model (`withTierDefaults`); on any other model they stay
 * empty: no effort sent, the default output cap, OpenRouter's own routing.
 */
export interface TierRequestConfig {
  /** `*_EFFORT`: `none`, `low` or `high` (never `max`); null = send none, the model's default. */
  effort: ReasoningEffort | null;
  /**
   * `SIMPLE_*_REPLY_TOKENS`: the reply's output cap (thinking and answer
   * together), at most BUILT_IN_MAX_OUTPUT_TOKENS (16,384); null = the default
   * for the model's kind (16,384 on a reasoning model, 4,096 otherwise). The
   * pool's is `POOL_MAX_OUTPUT_TOKENS` (`PoolConfig.maxOutputTokens`).
   */
  maxOutputTokens: number | null;
  /** `*_PROVIDER_ORDER`: OpenRouter provider slugs to pin, comma-separated; empty = none. */
  providerOrder: readonly string[];
}

export interface PoolConfig {
  accountId: string;
  /** `POOL_MODEL`; null = the simple provider's fast model, resolved by the caller. */
  model: string | null;
  /** `POOL_EFFORT` (null = the model's default). */
  effort: ReasoningEffort | null;
  /** `POOL_PROVIDER_ORDER`. */
  providerOrder: readonly string[];
  systemPrompt: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxMessageChars: number;
  reservationTtlMs: number;
  giveUpMs: number;
  callTimeoutMs: number;
  expireBatch: number;
  sessionEstimateMicros: number;
  caps: PoolCaps;
  limits: PoolRateLimits;
  minAccountAgeMs: number;
  overage: PoolOverage;
  /**
   * The pool notice version a pool request needs acknowledged: the code
   * constant `POOL_NOTICE_VERSION` (packages/shared/src/pool.ts, next to the
   * text it versions). Not an env var; only tests (`TEST_SEAMS`) may raise it,
   * with `POOL_NOTICE_VERSION`, to check that a bump asks again.
   */
  noticeVersion: number;
}

export interface AppConfig {
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
    usageHoldMicros: number;
    usageMaxPending: number;
    markupBps: number;
    openRouterFeeBps: number;
    membershipPriceCents: number;
  };
  simple: {
    maxInputTokens: number;
    /** Learn's tiers' request settings (their models: `SIMPLE_NORMAL_MODEL`, `SIMPLE_MAX_MODEL`). */
    normal: TierRequestConfig;
    max: TierRequestConfig;
    /**
     * `SIMPLE_FAST_EFFORT`: the effort of summaries and titles, in Learn and on
     * the open pool, as parsed (null = empty: `backgroundEffort` resolves it).
     */
    backgroundEffort: ReasoningEffort | null;
  };
  pool: PoolConfig;
}

// ---- Parsers

/** Parses a var holding a non-negative integer; empty, malformed or unsafe values give `fallback`. */
export function intVar(raw: string | undefined, fallback: number): number {
  const s = raw?.trim();
  if (!s || !/^\d+$/.test(s)) return fallback;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : fallback;
}

/** A positive safe integer, else `fallback` (0 is rejected). */
export function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw?.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** "true" / "false" (any case); anything else gives `fallback`. */
export function boolVar(raw: string | undefined, fallback: boolean): boolean {
  const s = raw?.trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return fallback;
}

/** JSON validated by `schema`; empty gives `fallback`, invalid logs and gives `fallback`. */
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
    console.error(`Invalid ${name}: not JSON; using the default`);
    return fallback;
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    console.error(`Invalid ${name}; using the default`, z.prettifyError(result.error));
    return fallback;
  }
  return result.data;
}

const nonNegativeInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * `MODEL_PRICES`: `{"<model>": {"in": µ$/MTok, "out": µ$/MTok, "context": tokens,
 * "feeBps"?: bps, "cacheRead"?: µ$/MTok, "cacheWrite"?: µ$/MTok}}`.
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
  }),
);

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
      ...(p.cacheRead !== undefined ? { cacheReadMicrosPerMTok: p.cacheRead } : {}),
      ...(p.cacheWrite !== undefined ? { cacheWriteMicrosPerMTok: p.cacheWrite } : {}),
    };
  }
  return { prices, overrides: Object.keys(overrides) };
}

/**
 * `*_EFFORT`: `none`, `low` or `high` (any case); empty gives null (the
 * model's default). `max` and `xhigh` are refused like any other value
 * (logged, null): Tangent never asks for a model's top effort.
 */
export function effortVar(name: string, raw: string | undefined): ReasoningEffort | null {
  const s = raw?.trim().toLowerCase();
  if (!s) return null;
  if (isReasoningEffort(s)) return s;
  console.error(`Invalid ${name}=${s}: expected none, low or high; sending no effort`);
  return null;
}

/** `SIMPLE_*_REPLY_TOKENS`: a positive cap up to BUILT_IN_MAX_OUTPUT_TOKENS; empty or invalid gives null. */
function replyTokensVar(name: string, raw: string | undefined): number | null {
  const n = positiveInt(raw, 0);
  if (n === 0) return null;
  return clamped(name, n, Math.min(n, BUILT_IN_MAX_OUTPUT_TOKENS));
}

function tierRequest(env: AppEnv, prefix: 'SIMPLE_NORMAL' | 'SIMPLE_MAX'): TierRequestConfig {
  return {
    effort: effortVar(`${prefix}_EFFORT`, env[`${prefix}_EFFORT`]),
    maxOutputTokens: replyTokensVar(`${prefix}_REPLY_TOKENS`, env[`${prefix}_REPLY_TOKENS`]),
    providerOrder: list(env[`${prefix}_PROVIDER_ORDER`]),
  };
}

function list(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function clamped(name: string, value: number, safe: number): number {
  if (value !== safe) console.warn(`${name}=${value} is unsafe; using ${safe}`);
  return safe;
}

function parse(env: AppEnv): AppConfig {
  const ttl = positiveInt(env.POOL_RESERVATION_TTL_MS, 10 * 60_000);
  const callTimeout = positiveInt(env.POOL_CALL_TIMEOUT_MS, 120_000);
  const giveUp = positiveInt(env.POOL_GIVE_UP_MS, 60 * 60_000);
  const prices = parsePrices(env.MODEL_PRICES);
  return {
    flags: {
      poolEnabled: boolVar(env.POOL_ENABLED, false),
      annualFeeEnabled: boolVar(env.ANNUAL_FEE_ENABLED, false),
      personalCreditEnabled: boolVar(env.PERSONAL_CREDIT_ENABLED, false),
      devPurchasesEnabled: boolVar(env.DEV_PURCHASES_ENABLED, false),
    },
    prices: prices.prices,
    priceOverrides: prices.overrides,
    billing: {
      usageHoldMicros: intVar(env.USAGE_HOLD_MICROS, DEFAULT_USAGE_HOLD_MICROS),
      usageMaxPending: intVar(env.USAGE_MAX_PENDING, DEFAULT_USAGE_MAX_PENDING),
      markupBps: intVar(env.MARKUP_BPS, DEFAULT_MARKUP_BPS),
      openRouterFeeBps: intVar(env.OPENROUTER_FEE_BPS, DEFAULT_OPENROUTER_FEE_BPS),
      membershipPriceCents: intVar(env.MEMBERSHIP_PRICE_CENTS, DEFAULT_MEMBERSHIP_PRICE_CENTS),
    },
    simple: {
      maxInputTokens: positiveInt(env.SIMPLE_MAX_INPUT_TOKENS, DEFAULT_SIMPLE_MAX_INPUT_TOKENS),
      normal: tierRequest(env, 'SIMPLE_NORMAL'),
      max: tierRequest(env, 'SIMPLE_MAX'),
      backgroundEffort: effortVar('SIMPLE_FAST_EFFORT', env.SIMPLE_FAST_EFFORT),
    },
    pool: {
      accountId: env.POOL_ACCOUNT_ID?.trim() || DEFAULT_POOL_ACCOUNT_ID,
      model: env.POOL_MODEL?.trim() || null,
      effort: effortVar('POOL_EFFORT', env.POOL_EFFORT),
      providerOrder: list(env.POOL_PROVIDER_ORDER),
      systemPrompt:
        env.POOL_SYSTEM_PROMPT?.trim() || env.SIMPLE_SYSTEM_PROMPT?.trim() || DEFAULT_SYSTEM_PROMPT,
      maxInputTokens: positiveInt(env.POOL_MAX_INPUT_TOKENS, 16_000),
      maxOutputTokens: positiveInt(env.POOL_MAX_OUTPUT_TOKENS, 8192),
      maxMessageChars: positiveInt(env.POOL_MAX_MESSAGE_CHARS, 4000),
      reservationTtlMs: ttl,
      // A call must time out well before the alarm may expire its reservation, and a
      // generation lookup may not give up before the reservation could expire.
      callTimeoutMs: clamped(
        'POOL_CALL_TIMEOUT_MS',
        callTimeout,
        Math.min(callTimeout, Math.max(1_000, ttl - POOL_TTL_SLACK_MS)),
      ),
      giveUpMs: clamped('POOL_GIVE_UP_MS', giveUp, Math.max(giveUp, ttl)),
      expireBatch: positiveInt(env.POOL_EXPIRE_BATCH, 20),
      sessionEstimateMicros: positiveInt(env.POOL_SESSION_ESTIMATE_MICROS, 20_000),
      caps: {
        user: {
          requestsPerDay: intVar(env.POOL_REQUESTS_PER_DAY, 30),
          spendMicrosPerDay: intVar(env.POOL_SPEND_MICROS_PER_DAY, 100_000),
        },
        global: {
          spendMicrosPerDay: intVar(env.POOL_DAILY_GLOBAL_MICROS, 5_000_000),
          bpsOfMorningBalance: intVar(env.POOL_DAILY_GLOBAL_BPS, 2_000),
        },
        ip: {
          requestsPerDay: intVar(env.POOL_IP_REQUESTS_PER_DAY, 60),
          spendMicrosPerDay: intVar(env.POOL_IP_SPEND_MICROS_PER_DAY, 300_000),
        },
      },
      limits: {
        userPerMinute: positiveInt(env.POOL_USER_PER_MINUTE, 6),
        ipPerMinute: positiveInt(env.POOL_IP_PER_MINUTE, 20),
      },
      minAccountAgeMs: intVar(env.POOL_MIN_ACCOUNT_AGE_MS, 0),
      overage: {
        windowMs: positiveInt(env.POOL_OVERAGE_WINDOW_MS, 24 * 60 * 60_000),
        maxMicros: intVar(env.POOL_OVERAGE_MAX_MICROS, 200_000),
      },
      noticeVersion:
        env.TEST_SEAMS === 'true'
          ? Math.max(POOL_NOTICE_VERSION, intVar(env.POOL_NOTICE_VERSION, POOL_NOTICE_VERSION))
          : POOL_NOTICE_VERSION,
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

/** The parsed, frozen config of `env` (parsed once per env object). */
export function appConfig(env: AppEnv): AppConfig {
  let config = cache.get(env);
  if (!config) {
    config = deepFreeze(parse(env));
    cache.set(env, config);
  }
  return config;
}
