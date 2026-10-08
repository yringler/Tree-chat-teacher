// Learn's tiers, Normal and Max (docs/DECISIONS.md "Learn tiers: Normal and
// Max"): the built-in provider's models and their `tier`, the env vars, the
// background model, and the Max usage factor `/api/providers` sends.
import { MAX_USAGE_FACTOR_FALLBACK, usageFactorOf, type ProviderInfo } from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_PRICES } from '../src/config.js';
import type { AppEnv } from '../src/env.js';
import {
  builtInPowerConfig,
  DEFAULT_SIMPLE_FAST_MODEL,
  DEFAULT_SIMPLE_MAX_MODEL,
  DEFAULT_SIMPLE_NORMAL_MODEL,
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
/** As deployed: no SIMPLE_PROVIDER override, the tier vars unset (their defaults apply). */
const deployed = (overrides: Partial<AppEnv> = {}) =>
  ({
    ...env,
    SIMPLE_PROVIDER: '',
    SIMPLE_NORMAL_MODEL: '',
    SIMPLE_MAX_MODEL: '',
    SIMPLE_FAST_MODEL: '',
    POOL_MODEL: '',
    MODEL_PRICES: '',
    SIMPLE_NORMAL_EFFORT: '',
    SIMPLE_NORMAL_REPLY_TOKENS: '',
    SIMPLE_NORMAL_PROVIDER_ORDER: '',
    SIMPLE_MAX_EFFORT: '',
    SIMPLE_MAX_REPLY_TOKENS: '',
    SIMPLE_MAX_PROVIDER_ORDER: '',
    SIMPLE_FAST_EFFORT: '',
    POOL_EFFORT: '',
    POOL_PROVIDER_ORDER: '',
    ...overrides,
  }) as AppEnv;
/** V4.1 Flash's pinned providers (config.ts `DEFAULT_TIER_REQUESTS`). */
const PINNED = ['streamlake/fp8', 'deepinfra/fp8'];

describe("Learn's tiers", () => {
  it('Normal (the default) then Max, tagged with their tier', () => {
    const config = simpleProviderConfig(deployed());
    expect(config.defaultModel).toBe(DEFAULT_SIMPLE_NORMAL_MODEL);
    // Each with its evaluated request settings (docs/DECISIONS.md "Hosted models from the eval").
    expect(config.models).toEqual([
      {
        id: 'deepseek/deepseek-v4.1-flash',
        label: 'Normal',
        tier: 'normal',
        effort: 'high',
        maxOutputTokens: 16_384,
        providerOrder: PINNED,
      },
      { id: 'anthropic/claude-sonnet-5.5', label: 'Max', tier: 'max', maxOutputTokens: 16_384 },
    ]);
    expect(DEFAULT_SIMPLE_MAX_MODEL).toBe('anthropic/claude-sonnet-5.5');
    // The background model is no tier, but today it is Normal's model, asked differently.
    expect(DEFAULT_SIMPLE_FAST_MODEL).toBe(DEFAULT_SIMPLE_NORMAL_MODEL);
  });

  it('SIMPLE_NORMAL_MODEL and SIMPLE_MAX_MODEL choose them; one model when they are the same', () => {
    const config = simpleProviderConfig(
      deployed({ SIMPLE_NORMAL_MODEL: 'a/normal', SIMPLE_MAX_MODEL: 'b/max' }),
    );
    expect(config.models.map((m) => [m.id, m.tier])).toEqual([
      ['a/normal', 'normal'],
      ['b/max', 'max'],
    ]);
    const same = simpleProviderConfig(
      deployed({ SIMPLE_NORMAL_MODEL: 'a/one', SIMPLE_MAX_MODEL: 'a/one' }),
    );
    expect(same.models).toEqual([{ id: 'a/one', label: 'Normal', tier: 'normal' }]);
  });

  it('summaries and titles stay on the background model, at low effort, never on Max', () => {
    expect(simpleFastModel(deployed())).toBe(DEFAULT_SIMPLE_FAST_MODEL);
    const settings = simpleChatSettings(deployed());
    expect(settings.summaryModel).toBe(DEFAULT_SIMPLE_FAST_MODEL);
    // Not Normal's `high`, which its listing of the same model carries.
    expect(settings.summaryEffort).toBe('low');
    expect(simpleFastModel(deployed({ SIMPLE_FAST_MODEL: 'c/fast' }))).toBe('c/fast');
    // The default effort belongs to the default model.
    expect(simpleChatSettings(deployed({ SIMPLE_FAST_MODEL: 'c/fast' })).summaryEffort).toBeNull();
    expect(simpleChatSettings(deployed({ SIMPLE_FAST_EFFORT: 'none' })).summaryEffort).toBe('none');
  });

  it('a SIMPLE_PROVIDER override: its models name their own tiers; its background model', () => {
    const override = (models: object[], fast = '') =>
      deployed({
        SIMPLE_FAST_MODEL: fast,
        SIMPLE_PROVIDER: JSON.stringify({
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
      { id: 'a', label: 'A', tier: 'max' },
      { id: 'b', label: 'B' },
    ]);
    expect(simpleProviderConfig(named).models.map((m) => [m.id, m.tier])).toEqual([
      ['a', 'max'],
      ['b', undefined],
    ]);
    // An override is a closed list: the background model must be in it, else its default
    // (never another listed model, which could be Max).
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
      { id: DEFAULT_SIMPLE_NORMAL_MODEL, label: 'Normal (suggested)', tier: 'normal' },
      { id: DEFAULT_SIMPLE_MAX_MODEL, label: 'Max (suggested)', tier: 'max' },
    ]);
    expect(builtInPowerConfig(deployed()).models).toEqual([
      { id: DEFAULT_SIMPLE_NORMAL_MODEL, label: 'Normal (suggested)', tier: 'normal' },
      { id: DEFAULT_SIMPLE_MAX_MODEL, label: 'Max (suggested)', tier: 'max' },
    ]);
  });

  it('the public pages list Normal, then Max, then models that are no tier', () => {
    const offer = learnOffer(
      deployed({
        SIMPLE_PROVIDER: JSON.stringify({
          id: 'openrouter',
          kind: 'fake',
          label: 'Tangent',
          defaultModel: 'c',
          models: [
            { id: 'c', label: 'C' },
            { id: 'm', label: 'M', tier: 'max' },
            { id: 'n', label: 'N', tier: 'normal' },
          ],
        }),
      }),
    );
    expect(offer?.tiers).toEqual([
      { id: 'n', label: 'N', tier: 'normal' },
      { id: 'm', label: 'M', tier: 'max' },
      { id: 'c', label: 'C' },
    ]);
  });

  it("the pool runs the background model by default: Normal's model, asked the pool's way", async () => {
    const e = deployed({ POOL_ACCOUNT_ID: uniq('pool') });
    const pool = await resolvePoolParams(e, null);
    expect(pool.model).toBe(DEFAULT_SIMPLE_FAST_MODEL);
    expect(pool).toMatchObject({ effort: 'low', providerOrder: PINNED, summaryEffort: 'low' });
    expect(poolProviderConfig(e, pool).models).toEqual([
      { id: DEFAULT_SIMPLE_FAST_MODEL, label: 'Normal', effort: 'low', providerOrder: PINNED },
    ]);
  });

  it('a pool model Learn does not list is labelled Lite, with its own defaults', async () => {
    const e = deployed({ POOL_ACCOUNT_ID: uniq('pool'), SIMPLE_FAST_MODEL: 'c/fast' });
    const pool = await resolvePoolParams(e, null);
    expect(pool).toMatchObject({ model: 'c/fast', effort: null, providerOrder: [] });
    expect(poolProviderConfig(e, pool).models).toEqual([{ id: 'c/fast', label: POOL_MODEL_LABEL }]);
    expect(POOL_MODEL_LABEL).toBe('Lite');
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

  it('is set on the Max model from the two prices: about 14 for V4.1 Flash and Sonnet 5.5', async () => {
    const [info] = await withUsageFactors(deployed(), [
      tiers(DEFAULT_SIMPLE_NORMAL_MODEL, DEFAULT_SIMPLE_MAX_MODEL),
    ]);
    expect(info!.models).toEqual([
      { id: DEFAULT_SIMPLE_NORMAL_MODEL, label: 'Normal', tier: 'normal' },
      { id: DEFAULT_SIMPLE_MAX_MODEL, label: 'Max', tier: 'max', usageFactor: 14 },
    ]);
  });

  it("the fallback is the default models' factor from the built-in prices", () => {
    const normal = DEFAULT_MODEL_PRICES[DEFAULT_SIMPLE_NORMAL_MODEL]!;
    const max = DEFAULT_MODEL_PRICES[DEFAULT_SIMPLE_MAX_MODEL]!;
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
