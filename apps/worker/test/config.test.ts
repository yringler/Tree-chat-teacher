import { DEFAULT_SYSTEM_PROMPT, POOL_NOTICE_VERSION } from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- `?raw` is a Vite import; the worker tsconfig has no vite/client types.
import wranglerText from '../wrangler.jsonc?raw';
import { membershipCreditCents } from '../src/billing/membership.js';
import { appConfig, boolVar, DEFAULT_MODEL_PRICES, intVar, positiveInt } from '../src/config.js';
import type { AppEnv } from '../src/env.js';
import {
  poolConfigProblem,
  poolModel,
  replyCeilingMicros,
  resolvePoolParams,
} from '../src/pool/params.js';
import { poolStatus } from '../src/pool/status.js';
import { poolAvailable } from '../src/services.js';
import { simpleMaxInputTokens } from '../src/simple-mode.js';

const env = rawEnv as unknown as AppEnv;

/** The deployed defaults: every pool var empty (wrangler.jsonc ships most of them set to these). */
const POOL_VARS = Object.keys(env).filter((k) => k.startsWith('POOL_') || k === 'MODEL_PRICES');
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
      blank({ POOL_ENABLED: '', ANNUAL_FEE_ENABLED: '', POOL_REVENUE_SHARE_BPS: '' }),
    );
    expect(c.flags).toEqual({
      poolEnabled: false,
      annualFeeEnabled: false,
      personalCreditEnabled: false,
      devPurchasesEnabled: false,
      featuredConversationsEnabled: false,
    });
    expect(c.prices).toEqual(DEFAULT_MODEL_PRICES);
    expect(c.pool).toMatchObject({
      accountId: 'pool',
      model: null,
      revenueShareBps: 2000,
      maxInputTokens: 16_000,
      maxOutputTokens: 8192,
      maxMessageChars: 4000,
      reservationTtlMs: 600_000,
      giveUpMs: 3_600_000,
      callTimeoutMs: 120_000,
      expireBatch: 20,
      sessionEstimateMicros: 20_000,
      limits: { userPerMinute: 6, ipPerMinute: 20 },
      minAccountAgeMs: 0,
      overage: { windowMs: 86_400_000, maxMicros: 200_000 },
    });
    // One set of caps for everyone: no member tier.
    expect(c.pool.caps).toEqual({
      user: { requestsPerDay: 30, spendMicrosPerDay: 100_000 },
      global: { spendMicrosPerDay: 5_000_000, bpsOfMorningBalance: 2_000 },
      ip: { requestsPerDay: 60, spendMicrosPerDay: 300_000 },
    });
    expect(c.billing).toEqual({
      usageHoldMicros: 20_000,
      usageMaxPending: 6,
      markupBps: 1000,
      openRouterFeeBps: 550,
      membershipPriceCents: 1000,
      // The membership includes no credit by default.
      membershipCreditCentsRaw: 0,
    });
  });

  it('applies overrides, and is parsed once per env object and frozen', () => {
    const custom = blank({
      POOL_ENABLED: 'true',
      ANNUAL_FEE_ENABLED: 'true',
      PERSONAL_CREDIT_ENABLED: 'TRUE',
      DEV_PURCHASES_ENABLED: 'true',
      FEATURED_CONVERSATIONS_ENABLED: 'true',
      POOL_ACCOUNT_ID: 'pool-x',
      POOL_REQUESTS_PER_DAY: '9',
      POOL_SPEND_MICROS_PER_DAY: '12',
      POOL_DAILY_GLOBAL_MICROS: '700',
      POOL_DAILY_GLOBAL_BPS: '50',
      POOL_SYSTEM_PROMPT: 'Teach.',
    });
    const c = appConfig(custom);
    expect(appConfig(custom)).toBe(c);
    expect(c.flags).toEqual({
      poolEnabled: true,
      annualFeeEnabled: true,
      personalCreditEnabled: true,
      devPurchasesEnabled: true,
      featuredConversationsEnabled: true,
    });
    expect(c.pool.accountId).toBe('pool-x');
    expect(c.pool.caps.user).toEqual({ requestsPerDay: 9, spendMicrosPerDay: 12 });
    expect(c.pool.caps.global).toEqual({ spendMicrosPerDay: 700, bpsOfMorningBalance: 50 });
    expect(c.pool.systemPrompt).toBe('Teach.');
    expect(Object.isFrozen(c.pool.caps.user)).toBe(true);
    expect(appConfig(blank({ POOL_REQUESTS_PER_DAY: 'lots' })).pool.caps.user.requestsPerDay).toBe(
      30,
    );
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
    const cached = appConfig(
      blank({
        MODEL_PRICES: JSON.stringify({
          c: { in: 5, out: 6, context: 100, cacheRead: 1, cacheWrite: 7 },
        }),
      }),
    ).prices;
    expect(cached['c']).toEqual({
      inMicrosPerMTok: 5,
      outMicrosPerMTok: 6,
      contextTokens: 100,
      cacheReadMicrosPerMTok: 1,
      cacheWriteMicrosPerMTok: 7,
    });
    for (const bad of [
      JSON.stringify({ m: { in: 1, out: 1, context: 1, cacheRead: -1 } }),
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

  it('reads the pool revenue share from POOL_REVENUE_SHARE_BPS (default 20%, at most 100%)', () => {
    expect(appConfig(blank({ POOL_REVENUE_SHARE_BPS: '1500' })).pool.revenueShareBps).toBe(1500);
    expect(appConfig(blank({ POOL_REVENUE_SHARE_BPS: '0' })).pool.revenueShareBps).toBe(0);
    expect(appConfig(blank({ POOL_REVENUE_SHARE_BPS: 'a fifth' })).pool.revenueShareBps).toBe(2000);
    expect(appConfig(blank({ POOL_REVENUE_SHARE_BPS: '12000' })).pool.revenueShareBps).toBe(10_000);
  });

  it('ships the share wrangler.jsonc documents, and no pool purchase or pool markup vars', () => {
    expect(/"POOL_REVENUE_SHARE_BPS"\s*:\s*"([^"]*)"/.exec(wranglerText as string)?.[1]).toBe(
      '2000',
    );
    for (const gone of ['POOL_PURCHASES_ENABLED', 'POOL_MIN_PURCHASE_CENTS', 'POOL_MARKUP_BPS'])
      expect(wranglerText as string).not.toContain(gone);
  });

  it('clamps unsafe combinations, logging each', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const c = appConfig(
      blank({
        POOL_RESERVATION_TTL_MS: '300000',
        POOL_CALL_TIMEOUT_MS: '600000',
        POOL_GIVE_UP_MS: '1000',
      }),
    );
    expect(c.pool.callTimeoutMs).toBe(240_000); // the TTL minus a minute
    expect(c.pool.giveUpMs).toBe(300_000); // at least the TTL
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockClear();
    const safe = appConfig(blank());
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
  it('is the code constant; only a test env (TEST_SEAMS) may raise it, never lower it', async () => {
    expect(appConfig({ ...env, POOL_NOTICE_VERSION: '' } as AppEnv).pool.noticeVersion).toBe(
      POOL_NOTICE_VERSION,
    );
    const raised = { ...env, POOL_NOTICE_VERSION: String(POOL_NOTICE_VERSION + 1) } as AppEnv;
    expect(appConfig(raised).pool.noticeVersion).toBe(POOL_NOTICE_VERSION + 1);
    expect((await resolvePoolParams(raised, null)).noticeVersion).toBe(POOL_NOTICE_VERSION + 1);
    expect(appConfig({ ...raised, TEST_SEAMS: '' } as AppEnv).pool.noticeVersion).toBe(
      POOL_NOTICE_VERSION,
    );
    expect(appConfig({ ...env, POOL_NOTICE_VERSION: '0' } as AppEnv).pool.noticeVersion).toBe(
      POOL_NOTICE_VERSION,
    );
  });
});

describe('resolvePoolParams', () => {
  it('prices the pool model, filling in the default fee', async () => {
    const p = await resolvePoolParams(env, 'ipk');
    expect(p).toMatchObject({
      accountId: 'pool',
      model: 'simple',
      price: {
        inMicrosPerMTok: 1_000_000,
        outMicrosPerMTok: 1_000_000,
        contextTokens: 1_048_576,
        feeBps: 550,
      },
      maxOutputTokens: 2048,
      ipKey: 'ipk',
    });
  });

  it('reports a pool whose reply ceiling no daily spend cap admits as off, and logs why', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(poolConfigProblem(env)).toBeNull();
    expect(poolAvailable(env)).toBe(true);
    const params = await resolvePoolParams(env, null);
    const ceiling = replyCeilingMicros(params, params.price!);
    for (const cap of ['POOL_SPEND_MICROS_PER_DAY', 'POOL_IP_SPEND_MICROS_PER_DAY']) {
      const tight = { ...env, [cap]: String(ceiling - 1) } as AppEnv;
      expect(poolConfigProblem(tight)).toContain(cap);
      expect(poolAvailable(tight)).toBe(false);
      expect((await poolStatus(tight)).enabled).toBe(false);
      // A request that gets this far is refused as unpriced, not as the user's cap.
      expect((await resolvePoolParams(tight, null)).price).toBeNull();
      expect(error.mock.calls.some((c) => String(c[0]).includes('pool_misconfigured'))).toBe(true);
      error.mockClear();
      // At the ceiling exactly, a reply fits.
      expect(poolConfigProblem({ ...env, [cap]: String(ceiling) } as AppEnv)).toBeNull();
    }
  });

  it('reports the pool off when its synced price puts a reply over the caps, as it refuses then', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // A placeholder-priced pool model (no MODEL_PRICES entry pins it), so the synced price applies.
    const model = 'minimax/minimax-m3';
    const synced = {
      ...env,
      POOL_MODEL: model,
      MODEL_PRICES: '',
      POOL_ACCOUNT_ID: `pool-synced-${Date.now()}`,
    } as AppEnv;
    expect(poolAvailable(synced)).toBe(true);
    expect((await poolStatus(synced)).enabled).toBe(true);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO model_prices (model, in_micros_per_mtok, out_micros_per_mtok, fetched_at)
       VALUES (?1, 1000000000, 1000000000, '2026-01-01T00:00:00.000Z')`,
    )
      .bind(model)
      .run();
    try {
      // The configured price still fits; the live one refuses every reply, and says so.
      expect(poolConfigProblem(synced)).toBeNull();
      expect((await resolvePoolParams(synced, null)).price).toBeNull();
      expect((await poolStatus(synced)).enabled).toBe(false);
      expect(error.mock.calls.some((c) => String(c[0]).includes('pool_misconfigured'))).toBe(true);
    } finally {
      await env.DB.prepare('DELETE FROM model_prices WHERE model = ?1').bind(model).run();
    }
  });

  it("defaults the model to Learn's background model; an unpriced model has no price", async () => {
    const noModel = { ...env, POOL_MODEL: '' } as AppEnv;
    // SIMPLE_FAST_MODEL when the fake config lists it, else that config's default.
    expect(poolModel({ ...noModel, SIMPLE_FAST_MODEL: 'simple' } as AppEnv)).toBe('simple');
    expect(poolModel(noModel)).toBe('smart');
    expect(
      (await resolvePoolParams({ ...env, POOL_MODEL: 'vendor/unpriced' } as AppEnv, null)).price,
    ).toBeNull();
  });
});
