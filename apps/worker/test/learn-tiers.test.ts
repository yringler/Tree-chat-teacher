// The built-in provider's models: Learn's one model, Normal; power's Normal and Max, tagged with
// their `tier`; the env vars, the background model, and the Max usage factor `/api/providers` sends.
import { MAX_USAGE_FACTOR_FALLBACK, usageFactorOf, type ProviderInfo } from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_PRICES } from '../src/config.js';
import type { AppEnv } from '../src/env.js';
import {
  builtInPowerConfig,
  DEFAULT_BACKGROUND_MODEL,
  DEFAULT_LEARN_NORMAL_MODEL,
  DEFAULT_POOL_MODEL,
  DEFAULT_POWER_MAX_MODEL,
  learnOffer,
  poolProviderConfig,
  POOL_MODEL_LABEL,
  simpleChatSettings,
  simpleFastModel,
  simpleProviderConfig,
  suggestedModels,
} from '../src/simple-mode.js';
import { withUsageFactors } from '../src/tiers.js';
import { resolvePoolParams } from '../src/pool/params.js';
import { uniq } from './mocks/billing-helpers.js';

const env = rawEnv as unknown as AppEnv;
/** As deployed: no BUILT_IN_PROVIDER override, the tier vars unset (their defaults apply). */
const deployed = (overrides: Partial<AppEnv> = {}) =>
  ({
    ...env,
    BUILT_IN_PROVIDER: '',
    LEARN_NORMAL_MODEL: '',
    POWER_MAX_MODEL: '',
    BACKGROUND_MODEL: '',
    POOL_MODEL: '',
    MODEL_PRICES: '',
    LEARN_NORMAL_EFFORT: '',
    LEARN_NORMAL_REPLY_TOKENS: '',
    LEARN_NORMAL_PROVIDER_ORDER: '',
    BACKGROUND_EFFORT: '',
    POOL_EFFORT: '',
    POOL_PROVIDER_ORDER: '',
    ...overrides,
  }) as AppEnv;
/** Where Normal's Haiku and the pool's V4.1 Flash are pinned (config.ts `DEFAULT_TIER_REQUESTS`). */
const HAIKU_PINNED = ['anthropic'];
const FLASH_PINNED = ['streamlake/fp8', 'deepinfra/fp8'];

describe("the built-in provider's models", () => {
  it('Learn has one model, Normal, with the request settings the model eval picked', () => {
    const config = simpleProviderConfig(deployed());
    expect(config.defaultModel).toBe(DEFAULT_LEARN_NORMAL_MODEL);
    expect(config.models).toEqual([
      {
        id: 'anthropic/claude-haiku-5.5',
        label: 'Normal',
        tier: 'normal',
        effort: 'high',
        maxOutputTokens: 16_384,
        providerOrder: HAIKU_PINNED,
      },
    ]);
    expect(DEFAULT_POWER_MAX_MODEL).toBe('anthropic/claude-sonnet-5.5');
    // The background model is no tier, but today it is Normal's model, asked differently.
    expect(DEFAULT_BACKGROUND_MODEL).toBe(DEFAULT_LEARN_NORMAL_MODEL);
    // The free pool stays on the model its eval picked, not the paid tiers' Haiku.
    expect(DEFAULT_POOL_MODEL).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('LEARN_NORMAL_MODEL and POWER_MAX_MODEL choose them; power has one model when they are the same', () => {
    const e = deployed({ LEARN_NORMAL_MODEL: 'a/normal', POWER_MAX_MODEL: 'b/max' });
    expect(simpleProviderConfig(e).models.map((m) => [m.id, m.tier])).toEqual([
      ['a/normal', 'normal'],
    ]);
    expect(builtInPowerConfig(e).models.map((m) => [m.id, m.tier])).toEqual([
      ['a/normal', 'normal'],
      ['b/max', 'max'],
    ]);
    const same = deployed({ LEARN_NORMAL_MODEL: 'a/one', POWER_MAX_MODEL: 'a/one' });
    expect(simpleProviderConfig(same).models).toEqual([
      { id: 'a/one', label: 'Normal', tier: 'normal' },
    ]);
    expect(suggestedModels(same)).toEqual([
      { id: 'a/one', label: 'Normal (suggested)', tier: 'normal' },
    ]);
  });

  it('summaries and titles stay on the background model, at low effort, never on Max', () => {
    expect(simpleFastModel(deployed())).toBe(DEFAULT_BACKGROUND_MODEL);
    const settings = simpleChatSettings(deployed(), 'openrouter');
    expect(settings.summaryModel).toBe(DEFAULT_BACKGROUND_MODEL);
    // Not Normal's `high`, which its listing of the same model carries.
    expect(settings.summaryEffort).toBe('low');
    expect(simpleFastModel(deployed({ BACKGROUND_MODEL: 'c/fast' }))).toBe('c/fast');
    // The default effort belongs to the default model.
    expect(
      simpleChatSettings(deployed({ BACKGROUND_MODEL: 'c/fast' }), 'openrouter').summaryEffort,
    ).toBeNull();
    expect(
      simpleChatSettings(deployed({ BACKGROUND_EFFORT: 'none' }), 'openrouter').summaryEffort,
    ).toBe('none');
  });

  it('a BUILT_IN_PROVIDER override: its models name their own tiers, Max is power’s; its background model', () => {
    const override = (models: object[], fast = '') =>
      deployed({
        BACKGROUND_MODEL: fast,
        BUILT_IN_PROVIDER: JSON.stringify({
          id: 'openrouter',
          kind: 'fake',
          label: 'Tangent',
          defaultModel: 'a',
          models,
        }),
      });
    // An override that names no tiers offers none.
    const untiered = override([
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ]);
    expect(simpleProviderConfig(untiered).models.map((m) => [m.id, m.tier])).toEqual([
      ['a', undefined],
      ['b', undefined],
      ['c', undefined],
    ]);
    const named = override([
      { id: 'a', label: 'A', tier: 'normal' },
      { id: 'b', label: 'B' },
      { id: 'm', label: 'M', tier: 'max' },
    ]);
    // Learn drops the Max models; power keeps every one.
    expect(simpleProviderConfig(named).models.map((m) => [m.id, m.tier])).toEqual([
      ['a', 'normal'],
      ['b', undefined],
    ]);
    expect(builtInPowerConfig(named).models.map((m) => [m.id, m.tier])).toEqual([
      ['a', 'normal'],
      ['b', undefined],
      ['m', 'max'],
    ]);
    // Learn runs on the default, so it can't be a Max model.
    expect(() => simpleProviderConfig(override([{ id: 'a', label: 'A', tier: 'max' }]))).toThrow(
      /default model must not be a Max model/,
    );
    // An override is a closed list: the background model must be in Learn's models, else its
    // default.
    expect(simpleFastModel(untiered)).toBe('a');
    const listed = override(
      [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
      ],
      'c',
    );
    expect(simpleFastModel(listed)).toBe('c');
    expect(() =>
      simpleProviderConfig(override([{ id: 'a', label: 'A', tier: 'premium' }])),
    ).toThrow(/tier must be "normal" or "max"/);
  });

  it('power suggests both tiers, and Tangent credit keeps their tier', () => {
    expect(suggestedModels(deployed())).toEqual([
      { id: DEFAULT_LEARN_NORMAL_MODEL, label: 'Normal (suggested)', tier: 'normal' },
      { id: DEFAULT_POWER_MAX_MODEL, label: 'Max (suggested)', tier: 'max' },
    ]);
    expect(builtInPowerConfig(deployed()).models).toEqual([
      { id: DEFAULT_LEARN_NORMAL_MODEL, label: 'Normal (suggested)', tier: 'normal' },
      { id: DEFAULT_POWER_MAX_MODEL, label: 'Max (suggested)', tier: 'max' },
    ]);
  });

  it("the public pages name power's Max, when the provider lists one", () => {
    expect(learnOffer(deployed())?.powerMax).toBe('Max');
    const one = deployed({ POWER_MAX_MODEL: DEFAULT_LEARN_NORMAL_MODEL });
    expect(learnOffer(one)?.powerMax).toBeNull();
    const override = learnOffer(
      deployed({
        BUILT_IN_PROVIDER: JSON.stringify({
          id: 'openrouter',
          kind: 'fake',
          label: 'Tangent',
          defaultModel: 'c',
          models: [
            { id: 'c', label: 'C' },
            { id: 'm', label: 'M', tier: 'max' },
          ],
        }),
      }),
    );
    expect(override?.powerMax).toBe('M');
  });

  it('the pool runs V4.1 Flash by default, while Normal and the background model run Haiku', async () => {
    const e = deployed({ TEST_POOL_ACCOUNT_ID: uniq('pool') });
    const pool = await resolvePoolParams(e, null);
    expect(pool.model).toBe(DEFAULT_POOL_MODEL);
    expect(pool.model).not.toBe(DEFAULT_LEARN_NORMAL_MODEL);
    expect(simpleFastModel(e)).toBe(DEFAULT_LEARN_NORMAL_MODEL);
    // Its summaries take the pool listing's effort (null = the listing's `low`).
    expect(pool).toMatchObject({ effort: 'low', providerOrder: FLASH_PINNED, summaryEffort: null });
    // Learn doesn't list it, so it is labelled Lite.
    expect(poolProviderConfig(e, pool).models).toEqual([
      {
        id: DEFAULT_POOL_MODEL,
        label: POOL_MODEL_LABEL,
        effort: 'low',
        providerOrder: FLASH_PINNED,
      },
    ]);
    expect(POOL_MODEL_LABEL).toBe('Lite');
  });

  it('BACKGROUND_MODEL leaves the pool alone; POOL_MODEL moves it, with its own defaults', async () => {
    const background = deployed({ TEST_POOL_ACCOUNT_ID: uniq('pool'), BACKGROUND_MODEL: 'c/fast' });
    expect((await resolvePoolParams(background, null)).model).toBe(DEFAULT_POOL_MODEL);
    const e = deployed({ TEST_POOL_ACCOUNT_ID: uniq('pool'), POOL_MODEL: 'c/fast' });
    const pool = await resolvePoolParams(e, null);
    expect(pool).toMatchObject({ model: 'c/fast', effort: null, providerOrder: [] });
    expect(poolProviderConfig(e, pool).models).toEqual([{ id: 'c/fast', label: POOL_MODEL_LABEL }]);
  });

  it("a pool on Normal's model is labelled Normal, asked the pool's way", async () => {
    const e = deployed({
      TEST_POOL_ACCOUNT_ID: uniq('pool'),
      POOL_MODEL: DEFAULT_LEARN_NORMAL_MODEL,
    });
    const pool = await resolvePoolParams(e, null);
    // The pool's defaults belong to its default model, so Haiku there gets none.
    expect(pool).toMatchObject({ effort: null, providerOrder: [] });
    expect(poolProviderConfig(e, pool).models).toEqual([
      { id: DEFAULT_LEARN_NORMAL_MODEL, label: 'Normal' },
    ]);
  });
});

describe('the Max usage factor', () => {
  const provider = (models: ProviderInfo['models']): ProviderInfo => ({
    id: 'openrouter',
    kind: 'openai-compatible',
    label: 'Tangent',
    models,
    defaultModel: models[0]!.id,
    openModels: false,
    available: true,
    acceptsUserKey: true,
    keySource: 'server',
  });
  const tiers = (normal: string, max: string) =>
    provider([
      { id: normal, label: 'Normal', tier: 'normal' },
      { id: max, label: 'Max', tier: 'max' },
    ]);
  const priced = (prices: Record<string, { in: number; out: number }>) =>
    deployed({
      MODEL_PRICES: JSON.stringify(
        Object.fromEntries(
          Object.entries(prices).map(([id, p]) => [id, { ...p, context: 100_000 }]),
        ),
      ),
    });

  it('is set on the Max model from the two prices: 20 for Haiku 5.5 and Sonnet 5.5', async () => {
    const [info] = await withUsageFactors(deployed(), [
      tiers(DEFAULT_LEARN_NORMAL_MODEL, DEFAULT_POWER_MAX_MODEL),
    ]);
    expect(info!.models).toEqual([
      { id: DEFAULT_LEARN_NORMAL_MODEL, label: 'Normal', tier: 'normal' },
      { id: DEFAULT_POWER_MAX_MODEL, label: 'Max', tier: 'max', usageFactor: 20 },
    ]);
  });

  it("the fallback is the default models' factor from the built-in prices", () => {
    const normal = DEFAULT_MODEL_PRICES[DEFAULT_LEARN_NORMAL_MODEL]!;
    const max = DEFAULT_MODEL_PRICES[DEFAULT_POWER_MAX_MODEL]!;
    expect(usageFactorOf(normal, max)).toBe(MAX_USAGE_FACTOR_FALLBACK);
  });

  it('follows the price table', async () => {
    const e = priced({
      'x/n': { in: 1_000_000, out: 1_000_000 },
      'x/m': { in: 5_000_000, out: 5_000_000 },
    });
    const [info] = await withUsageFactors(e, [tiers('x/n', 'x/m')]);
    expect(info!.models[1]!.usageFactor).toBe(5);
  });

  it('falls back when a price is missing or tells nothing', async () => {
    const e = priced({ 'x/n': { in: 0, out: 0 }, 'x/m': { in: 5_000_000, out: 5_000_000 } });
    const [unpriced, free] = await withUsageFactors(e, [
      tiers('x/unpriced', 'x/m'),
      tiers('x/n', 'x/m'),
    ]);
    expect(unpriced!.models[1]!.usageFactor).toBe(MAX_USAGE_FACTOR_FALLBACK);
    expect(free!.models[1]!.usageFactor).toBe(MAX_USAGE_FACTOR_FALLBACK);
  });

  it('leaves an entry without both tiers untouched', async () => {
    const single = provider([
      { id: 'x/n', label: 'Normal', tier: 'normal' },
      { id: 'x/other', label: 'Other' },
    ]);
    const [info] = await withUsageFactors(deployed(), [single]);
    expect(info).toEqual(single);
  });
});
