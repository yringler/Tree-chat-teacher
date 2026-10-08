// The public pages' claims that depend on the deployment's settings
// (http/landing.ts, http/pricing-page.ts, http/pool-page.ts): each one is
// worded from the config, so it stays true whatever the operator sets.
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AppEnv } from '../src/env.js';
import { uniq } from './mocks/billing-helpers.js';
import { authEnv, ORIGIN } from './session-client.js';

const NORMAL = 'deepseek/deepseek-v4.1-flash';
const MAX = 'anthropic/claude-sonnet-5.5';
/** The background model: today Normal's model (the pool asks it with less thinking). */
const FAST = 'deepseek/deepseek-v4.1-flash';

/**
 * As deployed: the real built-in provider (OpenRouter, with web search) with
 * the Normal and Max tiers, the default own-key providers, the pool on its
 * default model (the background model, Normal's), automatic search, credit sold
 * (the fake payment provider).
 */
const BASE: Partial<AppEnv> = {
  POOL_REVENUE_SHARE_BPS: '2000',
  POOL_MAX_OUTPUT_TOKENS: '1024',
  PROVIDERS: '',
  SIMPLE_PROVIDER: '',
  SIMPLE_NORMAL_MODEL: NORMAL,
  SIMPLE_MAX_MODEL: MAX,
  SIMPLE_FAST_MODEL: FAST,
  POOL_MODEL: '',
  GROUNDING: 'auto',
};
const MEMBERSHIP: Partial<AppEnv> = { ANNUAL_FEE_ENABLED: 'true' };
/** Polar without its secrets (vitest.config.ts pins them empty): nothing is sold. */
const NO_CREDIT: Partial<AppEnv> = { PAYMENT_PROVIDER: 'polar' };
const NO_POOL: Partial<AppEnv> = { POOL_ENABLED: 'false' };
/** The pool asking a custom tier's (plain) model like the tier: no effort, a plain reply's cap. */
const ASKED_LIKE_ITS_TIER: Partial<AppEnv> = { POOL_EFFORT: '', POOL_MAX_OUTPUT_TOKENS: '4096' };

async function page(path: string, overrides: Partial<AppEnv> = {}): Promise<string> {
  const res = await createApp().request(`${ORIGIN}${path}`, {}, authEnv({ ...BASE, ...overrides }));
  expect(res.status).toBe(200);
  return res.text();
}

/** A built-in provider config (SIMPLE_PROVIDER) on the operator's key. */
function builtIn(config: {
  baseUrl: string;
  models: { id: string; label: string; tier?: 'normal' | 'max' }[];
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
  it('with a membership: credit and your own key each cover the Max tier and search; Free does not', async () => {
    const html = await page('/pricing', MEMBERSHIP);
    for (const label of ['The Max tier', 'Web search, with sources'])
      expect(row(html, label)).toMatch(
        /<td class="no">[^]*<\/td><td class="yes">[^]*<\/td><td class="yes">[^]*<\/td>$/,
      );
  });

  it('pay as you go is the credit itself: included', async () => {
    const html = await page('/pricing');
    expect(row(html, 'The Max tier')).toMatch(/<td class="yes">[^]*Included<\/span><\/td>$/);
    expect(row(html, 'Web search, with sources')).toMatch(/<td class="yes">/);
  });

  it('a membership that sells no credit: only your own key', async () => {
    const html = await page('/pricing', { ...MEMBERSHIP, FAKE_PAYMENTS: '{"topUps":false}' });
    expect(row(html, 'The Max tier')).toMatch(/<td class="no">[^]*<td class="yes">[^]*<\/td>$/);
    expect(html).not.toMatch(/prepaid credit|Pay as you go/);
  });
});

describe('read-only power without a membership (the power-read note)', () => {
  /** The note's text, up to its back link. */
  const note = (html: string) => {
    const start = html.indexOf('<li id="note-power-read">');
    expect(start, 'the power-read note').toBeGreaterThan(-1);
    return html.slice(start, html.indexOf('<a class="back"', start));
  };
  const NO_TOP_UPS: Partial<AppEnv> = { FAKE_PAYMENTS: '{"topUps":false}' };

  it('offers a copy in Learn only where Learn can reply without a membership: the pool or credit', async () => {
    expect(note(await page('/pricing', MEMBERSHIP))).toContain(
      'and use <strong>Create a copy in Learn</strong> to continue a power-mode conversation there, on the open pool or on Tangent credit. Power mode on Tangent credit needs no membership.',
    );
    expect(note(await page('/pricing', { ...MEMBERSHIP, ...NO_TOP_UPS }))).toContain(
      'to continue a power-mode conversation there, on the open pool.',
    );
    expect(note(await page('/pricing', { ...MEMBERSHIP, ...NO_POOL }))).toContain(
      'to continue a power-mode conversation there, on Tangent credit.',
    );
    // The fee on, no pool and no credit: a copy in Learn would need the membership too.
    const neither = note(await page('/pricing', { ...MEMBERSHIP, ...NO_POOL, ...NO_TOP_UPS }));
    expect(neither).toContain(
      'Without a membership, you can still open, read and export everything you made on your own keys. ',
    );
    expect(neither).not.toMatch(/Create a copy in Learn|open pool|Tangent credit/);
  });
});

describe("Learn's tiers", () => {
  it("Normal and Max, with the pool on Normal's model (the default)", async () => {
    const pricing = await page('/pricing');
    expect(row(pricing, 'The Max tier, for the hardest questions')).toContain(
      '<td>On your key</td>',
    );
    expect(pricing).toContain(
      '<li>The Max tier in Learn, and any OpenRouter model in power mode</li>',
    );
    const landing = await page('/welcome');
    expect(landing).toContain(
      '<li>Two tiers: Normal for everyday learning, Max for the hardest questions (the free pool uses Normal&#39;s model with lighter thinking and shorter replies)</li>',
    );
    // The pricing page states the pool's cap, so it names only the thinking there.
    expect(pricing).toContain(
      'Pool replies use Normal&#39;s model with lighter thinking, are at most 1,024 tokens long',
    );
    expect(await page('/pool')).toContain(
      `Every reply on the pool uses Normal's model (<code>${NORMAL}</code>) with lighter thinking, a fixed teaching prompt, replies of at most 1,024 tokens`,
    );
    // No claim about the old models.
    expect(`${pricing}${landing}`).not.toMatch(/V4 Pro|V4 Flash|deepseek-v4-(pro|flash)\b/);
  });

  it('the pool on a background model that is no tier: Lite', async () => {
    // Its own pool account: the landing page's pool status is cached per account.
    const env = { SIMPLE_FAST_MODEL: 'deepseek/deepseek-v4-flash', POOL_ACCOUNT_ID: uniq('pool') };
    expect(await page('/welcome', env)).toContain(
      '<li>Two tiers: Normal for everyday learning, Max for the hardest questions (the free pool uses Lite)</li>',
    );
  });

  it('the pool on the Max model: Max is free on the pool', async () => {
    // Its own pool account: the landing page's pool status is cached per account.
    // Asked like Max: Max's effort (none set) and its reply cap.
    const env = {
      ...MEMBERSHIP,
      POOL_MODEL: MAX,
      POOL_EFFORT: '',
      POOL_MAX_OUTPUT_TOKENS: '16384',
      // A Max reply's ceiling hold is about $0.33, above the default per-network cap: caps that
      // admit one, or the pool reports itself off.
      POOL_SPEND_MICROS_PER_DAY: '5000000',
      POOL_IP_SPEND_MICROS_PER_DAY: '5000000',
      POOL_ACCOUNT_ID: uniq('pool'),
    };
    const pricing = await page('/pricing', env);
    const max = row(pricing, 'The Max tier');
    // Own keys need the membership here, so Free has Max on the pool only.
    expect(max).toContain('<td>On the open pool</td>');
    expect(max).toMatch(/<td class="yes">/);
    const noFee = await page('/pricing', { ...env, ANNUAL_FEE_ENABLED: 'false' });
    expect(row(noFee, 'The Max tier')).toContain('<td>On the open pool or your key</td>');
    expect(await page('/welcome', env)).toContain('(the free pool uses Max)</li>');
  });

  it('the pool asked like Normal: plain Normal; asked otherwise: how', async () => {
    const same = {
      POOL_EFFORT: 'high',
      POOL_MAX_OUTPUT_TOKENS: '16384',
      POOL_ACCOUNT_ID: uniq('pool'),
    };
    expect(await page('/welcome', same)).toContain('(the free pool uses Normal)</li>');
    expect(await page('/pricing', same)).toContain('They use the Normal model, have daily limits');
    const more = {
      POOL_EFFORT: 'high',
      POOL_MAX_OUTPUT_TOKENS: '32000',
      POOL_ACCOUNT_ID: uniq('pool'),
    };
    expect(await page('/welcome', more)).toContain(
      '(the free pool uses Normal&#39;s model with longer replies)</li>',
    );
    const unset = { POOL_EFFORT: 'none', POOL_ACCOUNT_ID: uniq('pool') };
    expect(await page('/welcome', unset)).toContain(
      '(the free pool uses Normal&#39;s model with lighter thinking and shorter replies)</li>',
    );
    // Normal's effort emptied on its default model is its evaluated `high` (withTierDefaults).
    const tierHigher = {
      SIMPLE_NORMAL_EFFORT: 'low',
      POOL_EFFORT: 'high',
      POOL_ACCOUNT_ID: uniq('pool'),
    };
    expect(await page('/welcome', tierHigher)).toContain(
      '(the free pool uses Normal&#39;s model with more thinking and shorter replies)</li>',
    );
  });

  it('one model: no tier to choose, so no tier is named', async () => {
    const env = { SIMPLE_MAX_MODEL: NORMAL };
    const pricing = await page('/pricing', env);
    expect(pricing).not.toContain('<th scope="row">The Max tier');
    expect(pricing).not.toContain('<th scope="row">The Normal tier');
    expect(pricing).toContain('<li>Learn on credit, and any OpenRouter model in power mode</li>');
    const landing = await page('/welcome', env);
    expect(landing).not.toMatch(/Two tiers|A choice of models/);
  });

  it('custom tiers are named as configured', async () => {
    const env = {
      SIMPLE_PROVIDER: builtIn({
        baseUrl: 'https://openrouter.ai/api/v1',
        models: [
          { id: 'a/quick', label: 'Quick', tier: 'normal' },
          { id: 'a/deep', label: 'Deep', tier: 'max' },
        ],
        webSearch: true,
      }),
      POOL_MODEL: 'a/quick',
      ...ASKED_LIKE_ITS_TIER,
      POOL_ACCOUNT_ID: uniq('pool'),
    };
    const pricing = await page('/pricing', env);
    expect(pricing).toContain('<th scope="row">The Deep tier, for the hardest questions</th>');
    expect(pricing).toContain(
      '<li>The Deep tier in Learn, and any OpenRouter model in power mode</li>',
    );
    expect(await page('/welcome', env)).toContain(
      '<li>Two tiers: Quick for everyday learning, Deep for the hardest questions (the free pool uses Quick)</li>',
    );
  });

  it('an override that names no tiers offers none', async () => {
    const env = {
      SIMPLE_PROVIDER: builtIn({
        baseUrl: 'https://openrouter.ai/api/v1',
        models: [
          { id: 'a/smart', label: 'Smart' },
          { id: 'a/simple', label: 'Simple' },
        ],
      }),
      POOL_ACCOUNT_ID: uniq('pool'),
    };
    const pricing = await page('/pricing', env);
    expect(pricing).not.toContain('<th scope="row">The Simple tier');
    expect(await page('/welcome', env)).not.toContain('Two tiers');
  });

  it('more models than the two tiers: a choice of models', async () => {
    const env = {
      SIMPLE_PROVIDER: builtIn({
        baseUrl: 'https://openrouter.ai/api/v1',
        models: [
          { id: 'a/quick', label: 'Quick', tier: 'normal' },
          { id: 'a/deep', label: 'Deep', tier: 'max' },
          { id: 'a/other', label: 'Other' },
        ],
      }),
      POOL_MODEL: 'a/quick',
      ...ASKED_LIKE_ITS_TIER,
      POOL_ACCOUNT_ID: uniq('pool'),
    };
    expect(await page('/pricing', env)).toContain(
      '<th scope="row">The Deep tier, for the hardest questions</th>',
    );
    expect(await page('/welcome', env)).toContain(
      '<li>A choice of models: Quick, Deep and Other (the free pool uses Quick)</li>',
    );
  });
});

describe('credit on another endpoint than OpenRouter', () => {
  const OPENAI: Partial<AppEnv> = {
    SIMPLE_PROVIDER: builtIn({
      baseUrl: 'https://api.openai.com/v1',
      models: [
        { id: 'gpt-5-mini', label: 'Normal' },
        { id: 'gpt-5', label: 'Max' },
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

describe('the privacy policy names who handles Tangent-paid requests from the config', () => {
  /** The policy's item on Tangent credit and the open pool. */
  const item = (html: string) => {
    const start = html.indexOf('<li>Tangent credit and the open pool:');
    expect(start, 'the hosted AI item').toBeGreaterThan(-1);
    return html.slice(start, html.indexOf('</ul></li>', start));
  };

  it('as deployed: Normal, the pool and summaries on their pinned hosts, Max and power on OpenRouter’s choice', async () => {
    const html = await page('/privacy');
    expect(html).not.toContain('currently DeepSeek models');
    const ai = item(html);
    expect(ai).toContain(
      'OpenRouter (USA), which forwards each request to a company that hosts the model: the company that made it or another hosting company, which may be in the USA, China or elsewhere.',
    );
    expect(ai).toContain(
      `<li>Learn&#39;s Normal tier, the open pool, and summaries and titles of conversations: <code>${NORMAL}</code> (made by DeepSeek), sent first to StreamLake, then to DeepInfra, and to another host only if they are unavailable.</li>`,
    );
    expect(ai).toContain(
      `<li>Learn&#39;s Max tier: <code>${MAX}</code> (made by Anthropic), on a host OpenRouter chooses.</li>`,
    );
    expect(ai).toContain(
      '<li>Power mode on Tangent credit: the model you choose, on a host OpenRouter chooses.</li>',
    );
    expect(html).toContain(
      'In Learn, your OpenRouter key runs the same models, sent to the same hosts, as Learn on Tangent credit.',
    );
  });

  it('follows a changed model, pinning or pool model', async () => {
    const ai = item(
      await page('/privacy', {
        SIMPLE_NORMAL_PROVIDER_ORDER: 'deepinfra/fp8',
        // wrangler.jsonc pins the pool's hosts explicitly; on Max they are OpenRouter's choice.
        POOL_PROVIDER_ORDER: '',
        POOL_MODEL: MAX,
        POOL_ACCOUNT_ID: uniq('pool'),
      }),
    );
    // Summaries run on Normal's listing of the background model, so they move with it.
    expect(ai).toContain(
      `<li>Learn&#39;s Normal tier and summaries and titles of conversations: <code>${NORMAL}</code> (made by DeepSeek), sent to DeepInfra, and to another host only if it is unavailable.</li>`,
    );
    expect(ai).toContain(`<li>Learn&#39;s Max tier and the open pool: <code>${MAX}</code>`);
  });

  it('without credit: only the open pool', async () => {
    const ai = item(await page('/privacy', NO_CREDIT));
    expect(ai).not.toMatch(/Learn&#39;s|Power mode on Tangent credit/);
    expect(ai).toContain(`<li>The open pool: <code>${NORMAL}</code>`);
  });

  it('pinned hosts without fallbacks, when the operator turns them off', async () => {
    const ai = item(
      await page('/privacy', {
        SIMPLE_PROVIDER: JSON.stringify({
          id: 'openrouter',
          kind: 'openai-compatible',
          label: 'Tangent',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKeySecret: 'OPENROUTER_SIMPLE_API_KEY',
          defaultModel: 'a/quick',
          models: [
            { id: 'a/quick', label: 'Quick', tier: 'normal', providerOrder: ['some-host/fp8'] },
          ],
          options: { extraBody: { provider: { allow_fallbacks: false } } },
        }),
        POOL_MODEL: 'a/quick',
        POOL_ACCOUNT_ID: uniq('pool'),
      }),
    );
    expect(ai).toContain(
      '<li>Learn&#39;s Quick tier and summaries and titles of conversations: <code>a/quick</code> (made by a), sent to some-host only.</li>',
    );
  });

  it('another endpoint than OpenRouter is named by its host, with no hosting claims', async () => {
    const html = await page('/privacy', {
      SIMPLE_PROVIDER: builtIn({
        baseUrl: 'https://api.openai.com/v1',
        models: [
          { id: 'gpt-5-mini', label: 'Normal', tier: 'normal' },
          { id: 'gpt-5', label: 'Max', tier: 'max' },
        ],
      }),
      POOL_MODEL: 'gpt-5-mini',
      POOL_ACCOUNT_ID: uniq('pool'),
    });
    const ai = item(html);
    expect(ai).toContain(
      'Tangent credit and the open pool: api.openai.com, which runs the models.',
    );
    expect(ai).toContain('<li>Learn&#39;s Max tier: <code>gpt-5</code>.</li>');
    expect(ai).not.toContain('OpenRouter');
    expect(html).not.toContain('In Learn, your OpenRouter key runs the same models');
  });
});
