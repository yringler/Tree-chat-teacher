import { DEFAULT_SYSTEM_PROMPT } from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appConfig,
  boolVar,
  ConfigError,
  DEFAULT_MODEL_PRICES,
  enumVar,
  intVar,
  POOL_ACCOUNT_ID,
  strictFlagVar,
} from '../src/config.js';
import type { AppEnv } from '../src/env.js';
import {
  POOL_CALL_TIMEOUT_MS,
  POOL_GIVE_UP_MS,
  POOL_RESERVATION_TTL_MS,
  poolConfigProblem,
  poolModel,
  replyCeilingMicros,
  resolvePoolParams,
} from '../src/pool/params.js';
import { poolStatus } from '../src/pool/status.js';
import { poolAvailable } from '../src/availability.js';
import { simpleMaxInputTokens } from '../src/simple-mode.js';

const env = rawEnv as unknown as AppEnv;

/** The deployed defaults: every pool var empty. */
const POOL_VARS = Object.keys(env).filter((k) => k.startsWith('POOL_') || k === 'MODEL_PRICES');
const blank = (overrides: Record<string, string> = {}): AppEnv =>
  ({ ...env, ...Object.fromEntries(POOL_VARS.map((k) => [k, ''])), ...overrides }) as AppEnv;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('config parsers', () => {
  it('intVar: empty is the default; anything but an integer in range throws', () => {
    expect(intVar('N', '42', 7)).toBe(42);
    expect(intVar('N', ' 0 ', 7)).toBe(0);
    for (const empty of [undefined, '', '  ']) expect(intVar('N', empty, 7)).toBe(7);
    for (const bad of ['-1', '1.5', '1e3', 'x', '99999999999999999999'])
      expect(() => intVar('N', bad, 7)).toThrow(ConfigError);
    expect(() => intVar('N', '0', 5, { min: 1 })).toThrow(
      'Invalid N="0": expected an integer from 1',
    );
    expect(() => intVar('N', '26', 5, { min: 1, max: 25 })).toThrow(ConfigError);
  });

  it('boolVar: true/false in any case; empty is the default; anything else throws', () => {
    expect(boolVar('B', 'TRUE', false)).toBe(true);
    expect(boolVar('B', ' False ', true)).toBe(false);
    expect(boolVar('B', undefined, true)).toBe(true);
    expect(boolVar('B', '', false)).toBe(false);
    for (const bad of ['yes', '1', 'on', 'ture'])
      expect(() => boolVar('B', bad, false)).toThrow('Invalid B=');
  });

  it('strictFlagVar: on only for exactly "true"; a near miss throws', () => {
    expect(strictFlagVar('F', 'true')).toBe(true);
    for (const off of [undefined, '', 'false']) expect(strictFlagVar('F', off)).toBe(false);
    for (const bad of ['TRUE', ' true', 'true ', 'yes', '1'])
      expect(() => strictFlagVar('F', bad)).toThrow(ConfigError);
  });

  it('enumVar: one of the values, in any case; empty is the default', () => {
    expect(enumVar('E', ' LOG ', ['resend', 'log'], 'resend')).toBe('log');
    expect(enumVar('E', '', ['resend', 'log'], 'resend')).toBe('resend');
    expect(() => enumVar('E', 'smtp', ['resend', 'log'], 'resend')).toThrow(
      'Invalid E="smtp": expected resend, log',
    );
  });

  it('AUTO_TITLE="False" turns titles off, and DEV_ALLOW_NO_AUTH is exact', () => {
    expect(appConfig(blank({ AUTO_TITLE: 'False' })).power.autoTitle).toBe(false);
    expect(appConfig(blank({ AUTO_TITLE: '' })).power.autoTitle).toBe(true);
    expect(appConfig(blank({ DEV_ALLOW_NO_AUTH: 'true' })).auth.devAllowNoAuth).toBe(true);
    expect(appConfig(blank({ DEV_ALLOW_NO_AUTH: '' })).auth.devAllowNoAuth).toBe(false);
    expect(() => appConfig(blank({ DEV_ALLOW_NO_AUTH: 'True' }))).toThrow(
      'Invalid DEV_ALLOW_NO_AUTH="True"',
    );
  });

  it('a malformed var fails the whole config, naming it', () => {
    expect(() => appConfig(blank({ DMCA_AGENT_REGISTERED: 'yes' }))).toThrow(
      'Invalid DMCA_AGENT_REGISTERED="yes": expected true or false',
    );
    expect(() => appConfig(blank({ POLAR_SERVER: 'live' }))).toThrow('Invalid POLAR_SERVER="live"');
    expect(() => appConfig(blank({ GROUNDING: 'sometimes' }))).toThrow('Invalid GROUNDING=');
    expect(() => appConfig(blank({ POOL_USER_PER_MINUTE: '0' }))).toThrow(
      'Invalid POOL_USER_PER_MINUTE="0"',
    );
  });

  it('the fake payment provider and the test vars need TEST_SEAMS', () => {
    expect(() => appConfig(blank({ TEST_SEAMS: '', PAYMENT_PROVIDER: 'fake' }))).toThrow(
      'PAYMENT_PROVIDER=fake is only allowed in tests (TEST_SEAMS)',
    );
    const deployed = blank({
      TEST_SEAMS: '',
      PAYMENT_PROVIDER: 'polar',
      TEST_POOL_ACCOUNT_ID: 'p',
    });
    expect(appConfig(deployed).pool.accountId).toBe(POOL_ACCOUNT_ID);
    expect(appConfig(blank({ TEST_POOL_ACCOUNT_ID: 'p' })).pool.accountId).toBe('p');
  });
});

describe('appConfig', () => {
  it('has the documented defaults', () => {
    const c = appConfig(blank({ POOL_ENABLED: '', ANNUAL_FEE_ENABLED: '' }));
    expect(c.flags).toEqual({
      poolEnabled: false,
      annualFeeEnabled: false,
      personalCreditEnabled: false,
      devPurchasesEnabled: false,
    });
    expect(c.prices).toEqual(DEFAULT_MODEL_PRICES);
    expect(c.pool).toMatchObject({
      accountId: 'pool',
      model: null,
      maxInputTokens: 16_000,
      maxOutputTokens: 8192,
      maxMessageChars: 4000,
      limits: { userPerMinute: 6, ipPerMinute: 20 },
      minAccountAgeMs: 0,
    });
    // One set of caps for everyone: no member tier.
    expect(c.pool.caps).toEqual({
      user: { requestsPerDay: 30, spendMicrosPerDay: 100_000 },
      global: { spendMicrosPerDay: 5_000_000, bpsOfMorningBalance: 2_000 },
      ip: { requestsPerDay: 60, spendMicrosPerDay: 300_000 },
    });
    expect(c.billing).toEqual({
      markupBps: 1000,
      openRouterFeeBps: 550,
      membershipPriceCents: 1000,
      membershipWaiverCode: null,
    });
  });

  it('applies overrides, and is parsed once per env object and frozen', () => {
    const custom = blank({
      POOL_ENABLED: 'true',
      ANNUAL_FEE_ENABLED: 'true',
      PERSONAL_CREDIT_ENABLED: 'TRUE',
      DEV_PURCHASES_ENABLED: 'true',
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
    });
    expect(c.pool.caps.user).toEqual({ requestsPerDay: 9, spendMicrosPerDay: 12 });
    expect(c.pool.caps.global).toEqual({ spendMicrosPerDay: 700, bpsOfMorningBalance: 50 });
    expect(c.pool.systemPrompt).toBe('Teach.');
    expect(Object.isFrozen(c.pool.caps.user)).toBe(true);
    expect(() => appConfig(blank({ POOL_REQUESTS_PER_DAY: 'lots' }))).toThrow(
      'Invalid POOL_REQUESTS_PER_DAY="lots"',
    );
  });

  it('falls back to the Learn prompt, then the built-in one, for the locked pool prompt', () => {
    expect(appConfig(blank({ LEARN_SYSTEM_PROMPT: 'Learn.' })).pool.systemPrompt).toBe('Learn.');
    expect(appConfig(blank({ LEARN_SYSTEM_PROMPT: '' })).pool.systemPrompt).toBe(
      DEFAULT_SYSTEM_PROMPT,
    );
  });

  it('merges valid MODEL_PRICES over the defaults and refuses invalid ones', () => {
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
      expect(() => appConfig(blank({ MODEL_PRICES: bad }))).toThrow('Invalid MODEL_PRICES=');
    }
  });

  it("the pool's timings leave the expiry its slack", () => {
    // A call times out a minute or more before its reservation may expire, and a generation
    // lookup gives up no earlier than the reservation could.
    expect(POOL_CALL_TIMEOUT_MS).toBeLessThanOrEqual(POOL_RESERVATION_TTL_MS - 60_000);
    expect(POOL_GIVE_UP_MS).toBeGreaterThanOrEqual(POOL_RESERVATION_TTL_MS);
  });

  it('BUILT_IN_MAX_INPUT_TOKENS is positive', () => {
    expect(() => simpleMaxInputTokens({ ...env, BUILT_IN_MAX_INPUT_TOKENS: '0' })).toThrow(
      ConfigError,
    );
    expect(simpleMaxInputTokens({ ...env, BUILT_IN_MAX_INPUT_TOKENS: '' })).toBe(60_000);
    expect(simpleMaxInputTokens({ ...env, BUILT_IN_MAX_INPUT_TOKENS: '1234' })).toBe(1234);
  });
});

describe('resolvePoolParams', () => {
  it('prices the pool model, filling in the default fee', async () => {
    const p = await resolvePoolParams(env, 'ipk');
    expect(p).toMatchObject({
      accountId: 'pool',
      model: 'normal',
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
      TEST_POOL_ACCOUNT_ID: `pool-synced-${Date.now()}`,
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
    // BACKGROUND_MODEL when the fake config lists it, else that config's default.
    expect(poolModel({ ...noModel, BACKGROUND_MODEL: 'normal' } as AppEnv)).toBe('normal');
    expect(poolModel(noModel)).toBe('max');
    expect(
      (await resolvePoolParams({ ...env, POOL_MODEL: 'vendor/unpriced' } as AppEnv, null)).price,
    ).toBeNull();
  });
});
