import { DEFAULT_SYSTEM_PROMPT, POOL_NOTICE_VERSION } from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { membershipCreditCents } from '../src/billing/membership.js';
import { appConfig, boolVar, DEFAULT_MODEL_PRICES, intVar, positiveInt } from '../src/config.js';
import type { AppEnv } from '../src/env.js';
import { poolModel, resolvePoolParams } from '../src/pool/params.js';
import { simpleMaxInputTokens } from '../src/simple-mode.js';

const env = rawEnv as unknown as AppEnv;

/** The deployed defaults: every pool var empty (wrangler.jsonc ships most of them set to these). */
const POOL_VARS = Object.keys(env).filter(
  (k) =>
    k.startsWith('POOL_') ||
    k.startsWith('IMPACT_') ||
    k === 'MODEL_PRICES' ||
    k === 'SUPPORTER_WINDOW_MONTHS',
);
const blank = (overrides: Record<string, string> = {}): AppEnv =>
  ({ ...env, ...Object.fromEntries(POOL_VARS.map((k) => [k, ''])), ...overrides }) as AppEnv;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('config parsers', () => {
  it('intVar: non-negative integers only', () => {
    expect(intVar('42', 7)).toBe(42);
    expect(intVar(' 0 ', 7)).toBe(0);
    for (const bad of [undefined, '', '-1', '1.5', '1e3', 'x', '99999999999999999999'])
      expect(intVar(bad, 7)).toBe(7);
  });

  it('positiveInt: rejects 0, negatives and fractions', () => {
    expect(positiveInt('12', 5)).toBe(12);
    for (const bad of [undefined, '', '0', '-3', '2.5', 'x']) expect(positiveInt(bad, 5)).toBe(5);
  });

  it('boolVar: true/false in any case, else the fallback', () => {
    expect(boolVar('TRUE', false)).toBe(true);
    expect(boolVar(' false ', true)).toBe(false);
    expect(boolVar('yes', false)).toBe(false);
    expect(boolVar(undefined, true)).toBe(true);
  });
});

describe('appConfig', () => {
  it('has the documented defaults', () => {
    const c = appConfig(
      blank({ POOL_ENABLED: '', ANNUAL_FEE_ENABLED: '', POOL_PURCHASES_ENABLED: '' }),
    );
    expect(c.flags).toEqual({
      poolEnabled: false,
      poolPurchasesEnabled: false,
      annualFeeEnabled: false,
      personalCreditEnabled: false,
      devPurchasesEnabled: false,
      featuredConversationsEnabled: false,
    });
    expect(c.prices).toEqual(DEFAULT_MODEL_PRICES);
    expect(c.pool).toMatchObject({
      accountId: 'pool',
      model: null,
      markupBps: 500,
      minPurchaseCents: 1000,
      maxInputTokens: 16_000,
      maxOutputTokens: 1024,
      maxMessageChars: 4000,
      reservationTtlMs: 600_000,
      giveUpMs: 3_600_000,
      callTimeoutMs: 120_000,
      expireBatch: 20,
      sessionEstimateMicros: 20_000,
      caps: {
        free: { requestsPerDay: 30, spendMicrosPerDay: 100_000 },
        supporter: { requestsPerDay: 150, spendMicrosPerDay: 500_000, windowMonths: null },
        globalFree: { spendMicrosPerDay: 5_000_000, bpsOfMorningBalance: 2_000 },
        globalSupporter: { spendMicrosPerDay: 10_000_000, bpsOfMorningBalance: 4_000 },
        ip: { requestsPerDay: 60, spendMicrosPerDay: 300_000 },
      },
      limits: { userPerMinute: 6, ipPerMinute: 20 },
      minAccountAgeMs: 0,
      overage: { windowMs: 86_400_000, maxMicros: 200_000 },
    });
    expect(c.impact).toEqual({
      minDistinctUsers: 5,
      topicBlocklist: [],
      classifierMaxOutputTokens: 12,
      classifierInputChars: 2000,
      tagRetentionDays: 14,
    });
    expect(c.billing).toEqual({
      usageHoldMicros: 20_000,
      usageMaxPending: 3,
      markupBps: 1000,
      openRouterFeeBps: 550,
      membershipPriceCents: 1000,
      membershipCreditCentsRaw: 200,
    });
  });

  it('applies overrides, and is parsed once per env object and frozen', () => {
    const custom = blank({
      POOL_ENABLED: 'true',
      POOL_PURCHASES_ENABLED: 'true',
      ANNUAL_FEE_ENABLED: 'true',
      PERSONAL_CREDIT_ENABLED: 'TRUE',
      DEV_PURCHASES_ENABLED: 'true',
      FEATURED_CONVERSATIONS_ENABLED: 'true',
      POOL_ACCOUNT_ID: 'pool-x',
      POOL_FREE_REQUESTS_PER_DAY: '9',
      SUPPORTER_WINDOW_MONTHS: '12',
      POOL_TOPIC_BLOCKLIST: ' a.b , ,c ',
      POOL_SYSTEM_PROMPT: 'Teach.',
    });
    const c = appConfig(custom);
    expect(appConfig(custom)).toBe(c);
    expect(c.flags).toEqual({
      poolEnabled: true,
      poolPurchasesEnabled: true,
      annualFeeEnabled: true,
      personalCreditEnabled: true,
      devPurchasesEnabled: true,
      featuredConversationsEnabled: true,
    });
    expect(c.pool.accountId).toBe('pool-x');
    expect(c.pool.caps.free.requestsPerDay).toBe(9);
    expect(c.pool.caps.supporter.windowMonths).toBe(12);
    expect(c.impact.topicBlocklist).toEqual(['a.b', 'c']);
    expect(c.pool.systemPrompt).toBe('Teach.');
    expect(Object.isFrozen(c.pool.caps.free)).toBe(true);
    expect(
      appConfig(blank({ POOL_FREE_REQUESTS_PER_DAY: 'lots' })).pool.caps.free.requestsPerDay,
    ).toBe(30);
  });

  it('falls back to the Learn prompt, then the built-in one, for the locked pool prompt', () => {
    expect(appConfig(blank({ SIMPLE_SYSTEM_PROMPT: 'Learn.' })).pool.systemPrompt).toBe('Learn.');
    expect(appConfig(blank({ SIMPLE_SYSTEM_PROMPT: '' })).pool.systemPrompt).toBe(
      DEFAULT_SYSTEM_PROMPT,
    );
  });

  it('merges valid MODEL_PRICES over the defaults and ignores invalid ones', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const merged = appConfig(
      blank({ MODEL_PRICES: JSON.stringify({ m: { in: 5, out: 6, context: 100, feeBps: 0 } }) }),
    ).prices;
    expect(merged['m']).toEqual({
      inMicrosPerMTok: 5,
      outMicrosPerMTok: 6,
      contextTokens: 100,
      feeBps: 0,
    });
    expect(merged['deepseek/deepseek-v4-flash']).toEqual(
      DEFAULT_MODEL_PRICES['deepseek/deepseek-v4-flash'],
    );
    for (const bad of [
      '{not json',
      JSON.stringify({ m: { in: 1.5, out: 1, context: 1 } }),
      JSON.stringify({ m: { in: -1, out: 1, context: 1 } }),
      JSON.stringify({ m: { in: 1, out: 1, context: 0 } }),
      JSON.stringify({ m: { in: 1, out: 1 } }),
      JSON.stringify({ m: { in: 1, out: 1, context: 1, extra: true } }),
      JSON.stringify([1]),
    ]) {
      expect(appConfig(blank({ MODEL_PRICES: bad })).prices).toEqual(DEFAULT_MODEL_PRICES);
    }
    expect(error).toHaveBeenCalled();
  });

  it('reads the pool markup from POOL_MARKUP_BPS (default 5%)', () => {
    expect(appConfig(blank({ POOL_MARKUP_BPS: '750' })).pool.markupBps).toBe(750);
    expect(appConfig(blank({ POOL_MARKUP_BPS: '0' })).pool.markupBps).toBe(0);
    expect(appConfig(blank({ POOL_MARKUP_BPS: 'five' })).pool.markupBps).toBe(500);
  });

  it('clamps unsafe combinations, logging each', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const c = appConfig(
      blank({
        POOL_RESERVATION_TTL_MS: '300000',
        POOL_CALL_TIMEOUT_MS: '600000',
        POOL_GIVE_UP_MS: '1000',
        IMPACT_MIN_DISTINCT_USERS: '1',
      }),
    );
    expect(c.pool.callTimeoutMs).toBe(240_000); // the TTL minus a minute
    expect(c.pool.giveUpMs).toBe(300_000); // at least the TTL
    expect(c.impact.minDistinctUsers).toBe(3); // never below 3
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockClear();
    const safe = appConfig(blank({ IMPACT_MIN_DISTINCT_USERS: '8' }));
    expect(safe.impact.minDistinctUsers).toBe(8);
    expect(safe.pool.callTimeoutMs).toBe(120_000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the old accessors: SIMPLE_MAX_INPUT_TOKENS is positive, membership credit needs the built-in provider', () => {
    expect(simpleMaxInputTokens({ ...env, SIMPLE_MAX_INPUT_TOKENS: '0' })).toBe(60_000);
    expect(simpleMaxInputTokens({ ...env, SIMPLE_MAX_INPUT_TOKENS: '1234' })).toBe(1234);
    expect(membershipCreditCents({ ...env, MEMBERSHIP_CREDIT_CENTS: '300' })).toBe(300);
    expect(
      membershipCreditCents({ ...env, PAYMENT_PROVIDER: 'polar', MEMBERSHIP_CREDIT_CENTS: '300' }),
    ).toBe(0);
  });
});

describe('the pool notice version', () => {
  it('is the code constant; only a test env (TEST_SEAMS) may raise it, never lower it', () => {
    expect(appConfig({ ...env, POOL_NOTICE_VERSION: '' } as AppEnv).pool.noticeVersion).toBe(
      POOL_NOTICE_VERSION,
    );
    const raised = { ...env, POOL_NOTICE_VERSION: String(POOL_NOTICE_VERSION + 1) } as AppEnv;
    expect(appConfig(raised).pool.noticeVersion).toBe(POOL_NOTICE_VERSION + 1);
    expect(resolvePoolParams(raised, null).noticeVersion).toBe(POOL_NOTICE_VERSION + 1);
    expect(appConfig({ ...raised, TEST_SEAMS: '' } as AppEnv).pool.noticeVersion).toBe(
      POOL_NOTICE_VERSION,
    );
    expect(appConfig({ ...env, POOL_NOTICE_VERSION: '0' } as AppEnv).pool.noticeVersion).toBe(
      POOL_NOTICE_VERSION,
    );
  });
});

describe('resolvePoolParams', () => {
  it('prices the pool model, filling in the default fee', () => {
    const p = resolvePoolParams(env, 'ipk');
    expect(p).toMatchObject({
      accountId: 'pool',
      model: 'simple',
      price: {
        inMicrosPerMTok: 1_000_000,
        outMicrosPerMTok: 1_000_000,
        contextTokens: 8192,
        feeBps: 550,
      },
      maxOutputTokens: 2048,
      ipKey: 'ipk',
    });
  });

  it('defaults the model to the simple provider fast model; an unpriced model has no price', () => {
    const noModel = { ...env, POOL_MODEL: '' } as AppEnv;
    expect(poolModel(noModel)).toBe('simple'); // the fake config's second model
    expect(resolvePoolParams({ ...env, POOL_MODEL: 'smart' } as AppEnv, null).price).toBeNull();
  });
});
