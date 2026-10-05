// The one config module (docs/pool/PLAN.md §4): every cap, price, margin,
// limit and flag the billing code and the community pool read. Values come
// from wrangler.jsonc `vars` (strings), parsed once per env object and frozen;
// empty or malformed values fall back to the defaults below, and the safety
// clamps at the end log when they change a value.
//
// `appConfig` holds raw parsed values only. Anything that needs the provider
// registry (the pool's default model, whether the built-in provider is
// offered) is resolved by its caller, so this module imports nothing from
// services.ts or simple-mode.ts.
import { DEFAULT_SYSTEM_PROMPT, POOL_NOTICE_VERSION } from '@tangent/shared';
import { z } from 'zod';
import type { AppEnv } from './env.js';

// The topic taxonomy is code, not env: it lives in its own module.
export {
  isSensitive,
  isValidLeafTopicId,
  LEAF_TOPIC_IDS,
  SENSITIVE_TOPIC_ID,
  topicById,
  TOPICS,
  type Topic,
} from './pool/taxonomy.js';

// ---- Defaults (re-exported from the modules that used to own them)

export const DEFAULT_USAGE_HOLD_MICROS = 20_000;
export const DEFAULT_USAGE_MAX_PENDING = 3;
export const DEFAULT_MARKUP_BPS = 1000;
/** OpenRouter's fee on credit purchases (5.5%; higher for top-ups under ~$15, see README). */
export const DEFAULT_OPENROUTER_FEE_BPS = 550;
export const DEFAULT_MEMBERSHIP_PRICE_CENTS = 1000;
export const DEFAULT_MEMBERSHIP_CREDIT_CENTS = 200;
export const DEFAULT_SIMPLE_MAX_INPUT_TOKENS = 60_000;

/** The community pool's ledger account id (`POOL_ACCOUNT_ID`). */
export const DEFAULT_POOL_ACCOUNT_ID = 'pool';
/** Margin on pool purchases in bps (8%): `credit = gross / (1 + margin)`. */
export const DEFAULT_POOL_MARGIN_BPS = 800;
/** A smaller impact threshold would make single learners identifiable. */
export const MIN_IMPACT_DISTINCT_USERS = 3;
/** The expiry alarm needs this much slack between a call's timeout and its reservation's TTL. */
export const POOL_TTL_SLACK_MS = 60_000;

/**
 * Price of one model in micro-USD per million tokens. `contextTokens` is the
 * model's context window: the input bound of the reply's ceiling hold.
 * `feeBps` grosses the price up like OPENROUTER_FEE_BPS does for reported
 * costs (default: that var); 0 for a provider billed directly.
 */
export interface ModelPrice {
  inMicrosPerMTok: number;
  outMicrosPerMTok: number;
  contextTokens: number;
  feeBps?: number;
}

/**
 * Placeholder prices of the default pool models (OpenRouter list prices when
 * the pool was planned); the operator confirms them before enabling the pool.
 * `MODEL_PRICES` overrides or extends them.
 */
export const DEFAULT_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'deepseek/deepseek-v4-flash': {
    inMicrosPerMTok: 100_000,
    outMicrosPerMTok: 400_000,
    contextTokens: 131_072,
  },
  'deepseek/deepseek-v4-pro': {
    inMicrosPerMTok: 500_000,
    outMicrosPerMTok: 2_000_000,
    contextTokens: 131_072,
  },
};

export interface PoolTierCaps {
  /** Pool replies per UTC day. */
  requestsPerDay: number;
  /** Pool spend (settled charges plus pending holds) per UTC day, micro-USD. */
  spendMicrosPerDay: number;
}

export interface PoolCaps {
  free: PoolTierCaps;
  /** Supporters: net purchases above $0 (pool/supporter.ts). */
  supporter: PoolTierCaps & {
    /** Months a purchase keeps its buyer a supporter; null = for life. */
    windowMonths: number | null;
  };
  /** The free tier's spend per UTC day, all users together: the lower of the two. */
  globalFree: { spendMicrosPerDay: number; bpsOfMorningBalance: number };
  /** Per network (IPv4 address or IPv6 /64), all users together. */
  ip: PoolTierCaps;
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

export interface PoolConfig {
  accountId: string;
  /** `POOL_MODEL`; null = the simple provider's fast model, resolved by the caller. */
  model: string | null;
  systemPrompt: string;
  marginBps: number;
  minPurchaseCents: number;
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
     * The yearly membership fee is charged and required to generate
     * (`ANNUAL_FEE_ENABLED`, default off). Off, the membership code paths stay
     * but nothing requires a membership, whatever STRIPE_MEMBERSHIP_PRICE_ID says.
     */
    annualFeeEnabled: boolean;
    /**
     * Personal credit may be spent before Stripe is configured (admin-granted
     * credit, `PERSONAL_CREDIT_ENABLED`); billing being configured enables it anyway.
     */
    personalCreditEnabled: boolean;
    /**
     * Admins may simulate purchases (`POST /api/admin/credit`, mode
     * `simulated_purchase`) to test funding without Stripe (`DEV_PURCHASES_ENABLED`).
     * Never on in production: a simulated purchase makes its buyer a supporter.
     */
    devPurchasesEnabled: boolean;
  };
  prices: Readonly<Record<string, ModelPrice>>;
  billing: {
    usageHoldMicros: number;
    usageMaxPending: number;
    markupBps: number;
    openRouterFeeBps: number;
    membershipPriceCents: number;
    /** Before the built-in-provider check (`membershipCreditCents`). */
    membershipCreditCentsRaw: number;
  };
  simple: { maxInputTokens: number };
  pool: PoolConfig;
  impact: {
    minDistinctUsers: number;
    topicBlocklist: readonly string[];
    classifierMaxOutputTokens: number;
    classifierInputChars: number;
    tagRetentionDays: number;
  };
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

/** `MODEL_PRICES`: `{"<model>": {"in": µ$/MTok, "out": µ$/MTok, "context": tokens, "feeBps"?: bps}}`. */
const modelPricesSchema = z.record(
  z.string().min(1),
  z.strictObject({
    in: nonNegativeInt,
    out: nonNegativeInt,
    context: nonNegativeInt.positive(),
    feeBps: nonNegativeInt.optional(),
  }),
);

function parsePrices(raw: string | undefined): Readonly<Record<string, ModelPrice>> {
  const overrides = jsonVar('MODEL_PRICES', raw, modelPricesSchema, {});
  const prices: Record<string, ModelPrice> = { ...DEFAULT_MODEL_PRICES };
  for (const [model, p] of Object.entries(overrides)) {
    prices[model] = {
      inMicrosPerMTok: p.in,
      outMicrosPerMTok: p.out,
      contextTokens: p.context,
      ...(p.feeBps !== undefined ? { feeBps: p.feeBps } : {}),
    };
  }
  return prices;
}

/** `POOL_MARGIN_BPS`, else `MARGIN_PERCENT` × 100 (up to two decimals), else 800. */
function parseMarginBps(env: AppEnv): number {
  const bps = intVar(env.POOL_MARGIN_BPS, -1);
  if (bps >= 0) return bps;
  const percent = env.MARGIN_PERCENT?.trim();
  if (percent && /^\d+(\.\d{1,2})?$/.test(percent)) return Math.round(Number(percent) * 100);
  return DEFAULT_POOL_MARGIN_BPS;
}

/** A positive number of months, or null (empty or anything else: for life). */
function optionalMonths(raw: string | undefined): number | null {
  const n = positiveInt(raw, 0);
  return n > 0 ? n : null;
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
  const minUsers = intVar(env.IMPACT_MIN_DISTINCT_USERS, 5);
  return {
    flags: {
      poolEnabled: boolVar(env.POOL_ENABLED, false),
      annualFeeEnabled: boolVar(env.ANNUAL_FEE_ENABLED, false),
      personalCreditEnabled: boolVar(env.PERSONAL_CREDIT_ENABLED, false),
      devPurchasesEnabled: boolVar(env.DEV_PURCHASES_ENABLED, false),
    },
    prices: parsePrices(env.MODEL_PRICES),
    billing: {
      usageHoldMicros: intVar(env.USAGE_HOLD_MICROS, DEFAULT_USAGE_HOLD_MICROS),
      usageMaxPending: intVar(env.USAGE_MAX_PENDING, DEFAULT_USAGE_MAX_PENDING),
      markupBps: intVar(env.MARKUP_BPS, intVar(env.MARKUP_PREPAID_BPS, DEFAULT_MARKUP_BPS)),
      openRouterFeeBps: intVar(env.OPENROUTER_FEE_BPS, DEFAULT_OPENROUTER_FEE_BPS),
      membershipPriceCents: intVar(env.MEMBERSHIP_PRICE_CENTS, DEFAULT_MEMBERSHIP_PRICE_CENTS),
      membershipCreditCentsRaw: intVar(
        env.MEMBERSHIP_CREDIT_CENTS,
        DEFAULT_MEMBERSHIP_CREDIT_CENTS,
      ),
    },
    simple: {
      maxInputTokens: positiveInt(env.SIMPLE_MAX_INPUT_TOKENS, DEFAULT_SIMPLE_MAX_INPUT_TOKENS),
    },
    pool: {
      accountId: env.POOL_ACCOUNT_ID?.trim() || DEFAULT_POOL_ACCOUNT_ID,
      model: env.POOL_MODEL?.trim() || null,
      systemPrompt:
        env.POOL_SYSTEM_PROMPT?.trim() || env.SIMPLE_SYSTEM_PROMPT?.trim() || DEFAULT_SYSTEM_PROMPT,
      marginBps: parseMarginBps(env),
      minPurchaseCents: intVar(env.POOL_MIN_PURCHASE_CENTS, 1000),
      maxInputTokens: positiveInt(env.POOL_MAX_INPUT_TOKENS, 16_000),
      maxOutputTokens: positiveInt(env.POOL_MAX_OUTPUT_TOKENS, 1024),
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
        free: {
          requestsPerDay: intVar(env.POOL_FREE_REQUESTS_PER_DAY, 30),
          spendMicrosPerDay: intVar(env.POOL_FREE_SPEND_MICROS_PER_DAY, 100_000),
        },
        supporter: {
          requestsPerDay: intVar(env.POOL_SUPPORTER_REQUESTS_PER_DAY, 150),
          spendMicrosPerDay: intVar(env.POOL_SUPPORTER_SPEND_MICROS_PER_DAY, 500_000),
          windowMonths: optionalMonths(env.SUPPORTER_WINDOW_MONTHS),
        },
        globalFree: {
          spendMicrosPerDay: intVar(env.POOL_FREE_DAILY_GLOBAL_MICROS, 5_000_000),
          bpsOfMorningBalance: intVar(env.POOL_FREE_DAILY_GLOBAL_BPS, 2_000),
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
    impact: {
      minDistinctUsers: clamped(
        'IMPACT_MIN_DISTINCT_USERS',
        minUsers,
        Math.max(MIN_IMPACT_DISTINCT_USERS, minUsers),
      ),
      topicBlocklist: list(env.POOL_TOPIC_BLOCKLIST),
      classifierMaxOutputTokens: 12,
      classifierInputChars: 2_000,
      tagRetentionDays: positiveInt(env.IMPACT_TAG_RETENTION_DAYS, 14),
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
