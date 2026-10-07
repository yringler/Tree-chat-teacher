// The public pages' claims that depend on the deployment's settings
// (http/landing.ts, http/pricing-page.ts, http/pool-page.ts): each one is
// worded from the config, so it stays true whatever the operator sets.
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AppEnv } from '../src/env.js';
import { uniq } from './mocks/billing-helpers.js';
import { authEnv, ORIGIN } from './session-client.js';

const SMART = 'deepseek/deepseek-v4-pro';
const FAST = 'deepseek/deepseek-v4-flash';

/**
 * As deployed: the real built-in provider (OpenRouter, with web search) with
 * the Smart and Simple tiers, the default own-key providers, the pool on its
 * Simple model, automatic search, credit sold (the fake payment provider).
 */
const BASE: Partial<AppEnv> = {
  POOL_REVENUE_SHARE_BPS: '2000',
  POOL_MAX_OUTPUT_TOKENS: '1024',
  PROVIDERS: '',
  SIMPLE_PROVIDER: '',
  SIMPLE_SMART_MODEL: SMART,
  SIMPLE_FAST_MODEL: FAST,
  POOL_MODEL: '',
  GROUNDING: 'auto',
};
const MEMBERSHIP: Partial<AppEnv> = { ANNUAL_FEE_ENABLED: 'true' };
/** Polar without its secrets (vitest.config.ts pins them empty): nothing is sold. */
const NO_CREDIT: Partial<AppEnv> = { PAYMENT_PROVIDER: 'polar' };
const NO_POOL: Partial<AppEnv> = { POOL_ENABLED: 'false' };

async function page(path: string, overrides: Partial<AppEnv> = {}): Promise<string> {
  const res = await createApp().request(`${ORIGIN}${path}`, {}, authEnv({ ...BASE, ...overrides }));
  expect(res.status).toBe(200);
  return res.text();
}

/** A built-in provider config (SIMPLE_PROVIDER) on the operator's key. */
function builtIn(config: {
  baseUrl: string;
  models: { id: string; label: string }[];
  webSearch?: boolean;
}): string {
  return JSON.stringify({
    id: 'openrouter',
    kind: 'openai-compatible',
    label: 'Tangent',
    baseUrl: config.baseUrl,
    apiKeySecret: 'OPENROUTER_SIMPLE_API_KEY',
    defaultModel: config.models[0]!.id,
    models: config.models,
    ...(config.webSearch ? { options: { webSearch: true } } : {}),
  });
}

/** The chart row whose heading starts with `label`: its heading and cells, as HTML. */
function row(html: string, label: string): string {
  const start = html.indexOf(`<th scope="row">${label}`);
  expect(start, `row "${label}"`).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</tr>', start));
}

describe('the pricing headline', () => {
  it.each([
    [
      'pool, credit and a membership',
      MEMBERSHIP,
      'Learn free, pay for what you use, or bring your own key.',
    ],
    [
      'a membership without the pool',
      { ...MEMBERSHIP, ...NO_POOL },
      'Pay for what you use, or bring your own key.',
    ],
    [
      'the pool and a membership, no credit',
      { ...MEMBERSHIP, FAKE_PAYMENTS: '{"topUps":false}' },
      'Learn free, or bring your own key for $10 a year.',
    ],
    [
      'only a membership',
      { ...MEMBERSHIP, ...NO_POOL, FAKE_PAYMENTS: '{"topUps":false}' },
      'Bring your own key for $10 a year.',
    ],
    ['pool and credit, no membership', {}, 'Learn free. Pay only for what you use.'],
    ['pool, nothing sold', NO_CREDIT, 'Learn free, or on your own key.'],
    ['credit without the pool', NO_POOL, 'Pay only for what you use.'],
    ['neither pool nor credit', { ...NO_POOL, ...NO_CREDIT }, 'Free on your own key.'],
  ])('with %s', async (_, env, h1) => {
    const html = await page('/pricing', env);
    expect(html).toContain(`<h1>${h1}</h1>`);
  });

  it('never says own keys are free while they need a membership; credit never needs one', async () => {
    for (const env of [MEMBERSHIP, { ...MEMBERSHIP, ...NO_POOL }]) {
      const html = await page('/pricing', env);
      expect(html).not.toMatch(
        /Pay only for what you use|nothing to cancel|Tangent charges nothing|Free on your own key/,
      );
      expect(html).not.toContain('Buying credit needs a membership');
      expect(html).toContain('Buying and spending credit never needs a membership.');
    }
  });
});

describe('what each way to pay covers, by column', () => {
  it('with a membership: credit and your own key each cover the Smart tier and search; Free does not', async () => {
    const html = await page('/pricing', MEMBERSHIP);
    for (const label of ['The Smart tier', 'Web search, with sources'])
      expect(row(html, label)).toMatch(
        /<td class="no">[^]*<\/td><td class="yes">[^]*<\/td><td class="yes">[^]*<\/td>$/,
      );
  });

  it('pay as you go is the credit itself: included', async () => {
    const html = await page('/pricing');
    expect(row(html, 'The Smart tier')).toMatch(/<td class="yes">[^]*Included<\/span><\/td>$/);
    expect(row(html, 'Web search, with sources')).toMatch(/<td class="yes">/);
  });

  it('a membership that sells no credit: only your own key', async () => {
    const html = await page('/pricing', { ...MEMBERSHIP, FAKE_PAYMENTS: '{"topUps":false}' });
    expect(row(html, 'The Smart tier')).toMatch(/<td class="no">[^]*<td class="yes">[^]*<\/td>$/);
    expect(html).not.toMatch(/prepaid credit|Pay as you go/);
  });
});

describe("Learn's tiers", () => {
  it('Smart and Simple, with the pool on Simple', async () => {
    const pricing = await page('/pricing');
    expect(row(pricing, 'The Smart tier, for deeper explanations')).toContain(
      '<td>On your key</td>',
    );
    expect(pricing).toContain(
      '<li>The Smart tier in Learn, and any OpenRouter model in power mode</li>',
    );
    const landing = await page('/welcome');
    expect(landing).toContain(
      '<li>Two tiers: Smart for deeper explanations, Simple for quicker, cheaper answers (the free pool uses Simple)</li>',
    );
  });

  it('the pool on the Smart model: Smart is free on the pool', async () => {
    // Its own pool account: the landing page's pool status is cached per account.
    const env = { ...MEMBERSHIP, POOL_MODEL: SMART, POOL_ACCOUNT_ID: uniq('pool') };
    const pricing = await page('/pricing', env);
    const smart = row(pricing, 'The Smart tier');
    // Own keys need the membership here, so Free has Smart on the pool only.
    expect(smart).toContain('<td>On the open pool</td>');
    expect(smart).toMatch(/<td class="yes">/);
    const noFee = await page('/pricing', { ...env, ANNUAL_FEE_ENABLED: 'false' });
    expect(row(noFee, 'The Smart tier')).toContain('<td>On the open pool or your key</td>');
    expect(await page('/welcome', env)).toContain('(the free pool uses Smart)</li>');
  });

  it('one model: no tier to choose, so no tier is named', async () => {
    const env = { SIMPLE_FAST_MODEL: SMART };
    const pricing = await page('/pricing', env);
    expect(pricing).not.toContain('<th scope="row">The Smart tier');
    expect(pricing).toContain('<li>Learn on credit, and any OpenRouter model in power mode</li>');
    const landing = await page('/welcome', env);
    expect(landing).not.toMatch(/Two tiers|A choice of models/);
  });

  it('custom tiers are named as configured', async () => {
    const env = {
      SIMPLE_PROVIDER: builtIn({
        baseUrl: 'https://openrouter.ai/api/v1',
        models: [
          { id: 'a/deep', label: 'Deep' },
          { id: 'a/quick', label: 'Quick' },
        ],
        webSearch: true,
      }),
      POOL_MODEL: 'a/quick',
      POOL_ACCOUNT_ID: uniq('pool'),
    };
    const pricing = await page('/pricing', env);
    expect(pricing).toContain('<th scope="row">The Deep tier</th>');
    expect(pricing).toContain(
      '<li>The Deep tier in Learn, and any OpenRouter model in power mode</li>',
    );
    expect(await page('/welcome', env)).toContain(
      '<li>A choice of models: Deep and Quick (the free pool uses Quick)</li>',
    );
  });
});

describe('credit on another endpoint than OpenRouter', () => {
  const OPENAI: Partial<AppEnv> = {
    SIMPLE_PROVIDER: builtIn({
      baseUrl: 'https://api.openai.com/v1',
      models: [
        { id: 'gpt-5', label: 'Smart' },
        { id: 'gpt-5-mini', label: 'Simple' },
      ],
    }),
    POOL_MODEL: 'gpt-5-mini',
  };

  it('promises no OpenRouter model and prices against that provider', async () => {
    const pricing = await page('/pricing', OPENAI);
    expect(pricing).not.toContain('OpenRouter model');
    expect(pricing).toContain('<th scope="row">Your choice of model, on prepaid credit</th>');
    expect(pricing).toContain(
      'Tangent’s cost is the AI provider’s price plus the 5.5% fee the AI provider charges on credit purchases. So for every 1¢ the AI provider charges, you pay about 1.16¢.',
    );
    const landing = await page('/welcome', OPENAI);
    expect(landing).toContain('<li>Your choice of model, on prepaid credit</li>');
    expect(landing).not.toContain('OpenRouter model');
  });

  it('describes no web search when Learn’s provider can’t search, whatever GROUNDING says', async () => {
    expect(await page('/pricing', OPENAI)).not.toMatch(/web search|Check sources/i);
    expect(await page('/welcome', OPENAI)).not.toMatch(/Check sources|against the web/);
  });
});

describe('the cost of a reply on credit', () => {
  it('works the example out from the fee and the markup', async () => {
    const html = await page('/pricing', { MARKUP_BPS: '2000', OPENROUTER_FEE_BPS: '0' });
    expect(html).toContain(
      'You pay what each reply costs Tangent, plus Tangent’s 20% markup. Tangent’s cost is OpenRouter’s price. So for every 1¢ OpenRouter charges, you pay about 1.20¢.',
    );
    expect(html).not.toContain('fee OpenRouter charges');
  });
});

describe('web search', () => {
  it('costs about 1¢ only at OpenRouter’s Exa price (up to 10 results)', async () => {
    expect(await page('/pricing')).toContain('A search adds about 1¢ to the cost of that reply.');
    for (const env of [{ GROUNDING_MAX_RESULTS: '20' }, { GROUNDING_ENGINE: 'parallel' }]) {
      const html = await page('/pricing', env);
      expect(html).toContain('A search adds to the cost of that reply.');
      expect(html).not.toContain('about 1¢');
    }
  });

  it('states the daily cap on automatic searches only when there is one', async () => {
    expect(await page('/pricing')).toContain('On credit, automatic searches stop after 40 a day');
    expect(await page('/pricing', { GROUNDING_AUTO_DAILY_CAP: '0' })).not.toContain(
      'automatic searches stop',
    );
    expect(await page('/pricing', { GROUNDING: 'explicit' })).not.toContain(
      'automatic searches stop',
    );
  });

  it('names exactly the own-key providers that can’t search', async () => {
    const providers = (configs: object[]) => ({ PROVIDERS: JSON.stringify(configs) });
    const searching = {
      id: 'openrouter',
      kind: 'openai-compatible',
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeySecret: 'OPENROUTER_API_KEY',
      defaultModel: 'x/y',
      models: [{ id: 'x/y', label: 'Y' }],
      options: { webSearch: true },
    };
    const mistral = { ...searching, id: 'mistral', label: 'Mistral', options: {} };
    const some = await page('/pricing', providers([searching, mistral]));
    expect(some).toContain('It isn’t available with Mistral keys, and it’s off on the open pool.');
    expect(some).toContain('; power mode also takes Mistral keys.');
    const all = await page('/pricing', providers([searching]));
    expect(all).not.toContain('isn’t available with');
    expect(all).toContain('It’s off on the open pool.');
    expect(all).not.toContain('power mode also takes');
  });
});

describe('own-key providers', () => {
  it('are named from PROVIDERS, with a generic phrase when it can’t be read', async () => {
    const pricing = await page('/pricing');
    expect(pricing).toContain(
      '<th scope="row">Your own Anthropic, OpenAI and OpenRouter keys</th>',
    );
    expect(await page('/welcome')).toContain(
      '<li>Your own API keys for Anthropic, OpenAI or OpenRouter</li>',
    );
    const broken = { PROVIDERS: 'not json' };
    expect(await page('/pricing', broken)).toContain('<th scope="row">Your own API keys</th>');
    expect(await page('/welcome', broken)).toContain(
      '<li>Your own API keys for any provider this server offers</li>',
    );
  });
});

describe('pool reply length', () => {
  it('converts the token cap to rough words from the config', async () => {
    const env = { POOL_MAX_OUTPUT_TOKENS: '2048' };
    expect(await page('/pricing', env)).toContain('2,048 tokens long (roughly 1,550 words)');
    expect(await page('/pool', env)).toContain('2,048 tokens (roughly 1,550 words)');
  });
});
