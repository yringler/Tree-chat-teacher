// `/pricing` (http/pricing-page.ts): the plan cards, the comparison chart and
// its numbered notes, worded for what this deployment sells.
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { appConfig } from '../src/config.js';
import type { AppEnv } from '../src/env.js';
import { formatMicros } from '@tangent/shared';
import { PRICING_STYLE } from '../src/http/pricing-page.js';
import { uniq } from './mocks/billing-helpers.js';
import { fundPool } from './pool-helpers.js';
import { authEnv, ORIGIN } from './session-client.js';

/**
 * The pool on with a 20% revenue share and 1,024-token replies, credit sold
 * (the fake payment provider), the default own-key and built-in providers,
 * no membership (MEMBERSHIP adds it, as deployed).
 */
const DEPLOYED: Partial<AppEnv> = {
  POOL_REVENUE_SHARE_BPS: '2000',
  POOL_MAX_OUTPUT_TOKENS: '1024',
  PROVIDERS: '',
  // The real built-in provider (OpenRouter, with web search), not the test suite's fake,
  // and the pool on its default model (the background model: Normal's, so labelled Normal).
  SIMPLE_PROVIDER: '',
  POOL_MODEL: '',
};

/** The page as a visitor sees it, with `overrides` on the deployed env. */
async function pricing(overrides: Partial<AppEnv> = {}): Promise<{ res: Response; html: string }> {
  const res = await createApp().request(
    `${ORIGIN}/pricing`,
    {},
    authEnv({ ...DEPLOYED, ...overrides }),
  );
  return { res, html: await res.text() };
}

/** No payment provider configured: Polar without its secrets (vitest.config.ts pins them empty). */
const NO_CREDIT: Partial<AppEnv> = { PAYMENT_PROVIDER: 'polar' };
const MEMBERSHIP: Partial<AppEnv> = { ANNUAL_FEE_ENABLED: 'true' };
const NO_POOL: Partial<AppEnv> = { POOL_ENABLED: 'false' };

/** The chart row whose heading starts with `label`, from its heading to its last cell. */
function row(html: string, label: string): string {
  const start = html.indexOf(`<th scope="row">${label}`);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</tr>', start));
}

/** The chart's column headings. */
function columns(html: string): string[] {
  const head = /<thead>([\s\S]*?)<\/thead>/.exec(html)?.[1] ?? '';
  return [...head.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((m) => m[1]!);
}

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

describe('/pricing', () => {
  it('is a public, script-free page allowed only its own stylesheet', async () => {
    const { res, html } = await pricing();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toBe(
      `default-src 'none'; style-src 'sha256-${await sha256Base64(PRICING_STYLE)}'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    expect([...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1])).toEqual([
      PRICING_STYLE,
    ]);
    expect(html).not.toMatch(/<script|\son\w+=|\sstyle=/i);
    expect(html).toContain('<title>Pricing · Tangent</title>');
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/pricing">`);
  });

  it('numbers its notes in reading order, and every citation has a note and every note a citation', async () => {
    for (const env of [{}, MEMBERSHIP, NO_CREDIT, NO_POOL, { ...NO_POOL, ...NO_CREDIT }]) {
      const { html } = await pricing(env);
      const cited = [
        ...html.matchAll(/<a href="#note-([a-z-]+)"[^>]*aria-label="Note (\d+)">(\d+)<\/a>/g),
      ];
      expect(cited.length).toBeGreaterThan(0);
      const order: string[] = [];
      for (const [, id, label, n] of cited) {
        if (!order.includes(id!)) order.push(id!);
        expect(Number(n)).toBe(order.indexOf(id!) + 1);
        expect(label).toBe(n);
      }
      const notes = [...html.matchAll(/<li id="note-([a-z-]+)">/g)].map((m) => m[1]);
      expect(notes).toEqual(order);
      // Each note's back link has one anchor to return to.
      for (const id of order) expect(html.split(`id="ref-${id}"`).length).toBe(2);
    }
  });

  it('pool on, credit sold, no membership: Free and Pay as you go, with the fine print in notes', async () => {
    const { pool, billing } = appConfig(authEnv(DEPLOYED));
    const { html } = await pricing();
    expect(html).toContain('<h1>Learn free. Pay only for what you use.</h1>');
    expect(html).toContain('No subscription, nothing to cancel.');
    expect(columns(html)).toEqual(['Free', 'Pay as you go']);
    expect(html).toContain('<h3>Free</h3>\n<p class="price">$0</p>');
    expect(html).toContain('<a class="btn primary" href="/learn/login">Start learning free</a>');
    expect(html).toContain(`${pool.caps.user.requestsPerDay} free replies a day on the open pool`);
    expect(html).toContain('<li>Every power-mode control, on your own keys</li>');
    expect(billing.markupBps).toBe(1000);
    expect(html).toContain('<p class="price">At cost<small> + 10% a reply</small>');
    // The notes: the pool's limits, at-cost pricing with both fees, top-ups and tax.
    expect(html).toContain('Tangent puts 20% of what it earns into it');
    expect(html).toContain(
      `While the pool has credit, each learner can use up to ${pool.caps.user.requestsPerDay} replies or ${formatMicros(pool.caps.user.spendMicrosPerDay)} of AI cost a day, whichever comes first.`,
    );
    expect(html).toContain('are at most 1,024 tokens long (roughly 750 words)');
    expect(html).toContain('<a href="/pool">How the pool works, with every limit</a>');
    expect(html).toContain(
      'You pay what each reply costs Tangent, plus Tangent’s 10% markup. Tangent’s cost is OpenRouter’s price plus the 5.5% fee OpenRouter charges on credit purchases. So for every 1¢ OpenRouter charges, you pay about 1.16¢.',
    );
    expect(html).toContain('Tangent puts 20% of its markup into the open pool as credit is used.');
    // Why there's a free plan: Tangent's own policy, with its catch, not tied to the reader's purchase.
    expect(html).toContain('<h2 id="why">Why there’s a free plan</h2>');
    expect(html).toContain(
      'Free replies come from the open pool: credit Tangent sets aside from what it earns. They use Normal&#39;s model with lighter thinking and shorter replies, have daily limits and are available only while the pool has credit.',
    );
    expect(html).toContain(
      '<li>Tangent earns money from the credit people buy, like any software business.</li>',
    );
    expect(html).toContain('Top up $5 to $500 at a time. Tax is added at checkout.');
    expect(html).toContain('comes out of the credit you receive');
    expect(html).toContain('Credit doesn’t expire while your account exists');
    expect(html).toContain('<th scope="row">Any OpenRouter model, on prepaid credit</th>');
    expect(html).toContain('<th scope="row">Your own Anthropic, OpenAI and OpenRouter keys</th>');
    expect(html).toContain(
      '<th scope="row">Tangent’s charge on your own key</th><td>Nothing</td><td>Nothing</td>',
    );
    // Nothing needs a membership (the pool's funding sentence still names membership payments).
    expect(html).not.toMatch(/needs? a membership|a year \+ tax|Membership</);
  });

  it('with the membership required: a third column, Your own key, which own keys in both apps need', async () => {
    const { pool } = appConfig(authEnv({ ...DEPLOYED, ...MEMBERSHIP }));
    const { html } = await pricing(MEMBERSHIP);
    expect(columns(html)).toEqual(['Free', 'Pay as you go', 'Your own key']);
    expect(html).toContain('<div class="plans three">');
    expect(html).toContain('<h1>Learn free, pay for what you use, or bring your own key.</h1>');
    expect(html).toContain(
      `Anyone signed in can learn free on the open pool: up to ${pool.caps.user.requestsPerDay} replies a day, the same limits for everyone, while the pool has credit. For more replies or power mode, buy prepaid credit, with no subscription, and pay for each reply at what it costs Tangent, plus 10%. With your own API key, your AI provider bills you directly, and a $10 yearly membership covers Tangent itself.`,
    );
    // $10 a year over a 10% markup: the AI spend where the two cost the same.
    expect(html).toContain(
      'A rule of thumb: if you’d spend less than about $100 a year on AI, credit costs you less; if more, your own key does.',
    );
    expect(html).not.toMatch(/pay for Tangent once|Either way you pay/i);
    // Credit needs no membership, to buy or to spend.
    expect(html).toContain('<p class="price">At cost<small> + 10% a reply</small>');
    expect(html).toContain('no subscription, no membership.</p>');
    expect(html).toContain('Buying and spending credit never needs a membership.');
    expect(html).toContain('Credit is separate: anyone can buy it, member or not.');
    expect(html).not.toMatch(/Buying credit needs a membership|buy prepaid credit for/i);
    // The membership is for own keys, in Learn and power mode alike.
    expect(html).toContain(
      '<h3>Your own key</h3>\n<p class="price">$10<small> a year + tax</small>',
    );
    expect(html).toContain('<li>Learn and power mode on your own API keys<sup');
    expect(html).toContain('Your own keys need the membership, in Learn and in power mode alike.');
    expect(html).toContain('one membership covers your own keys in both Learn and power mode.');
    expect(html).not.toContain('Your own OpenRouter key in Learn, with nothing added by Tangent');
    expect(html).not.toContain('Every power-mode control, on your own keys');
    expect(row(html, 'Your own OpenRouter key')).toMatch(
      /<td class="no">[^]*<td class="no">[^]*<td class="yes">/,
    );
    expect(html).toContain(
      '<th scope="row">Your own Anthropic, OpenAI and OpenRouter keys</th><td class="no">',
    );
    expect(html).toContain(
      'you can still open, read and export everything you made on your own keys, and use <strong>Create a copy in Learn</strong>',
    );
    expect(html).toContain('Power mode on Tangent credit needs no membership.');
    // One set of pool limits: the same in every column, and no member caps anywhere.
    const perDay = `<td>${pool.caps.user.requestsPerDay} a day</td>`;
    expect(row(html, 'Free replies on the open pool')).toContain(perDay.repeat(3));
    expect(html).toContain('The limits are the same for everyone, whatever else they pay for');
    expect(html).not.toMatch(/members:|instead of|raises your pool limit|more free replies/);
    // No credit is included at the default MEMBERSHIP_CREDIT_CENTS (0).
    expect(html).not.toMatch(/credit included|a year included|comes with/);
    expect(row(html, 'Prepaid credit')).toMatch(/<td>Bought separately<\/td>$/);
    expect(html).toContain(
      '<li>Tangent earns money from memberships and credit, like any software business.</li>',
    );
  });

  it('still names credit included with the membership when MEMBERSHIP_CREDIT_CENTS is set', async () => {
    const { html } = await pricing({ ...MEMBERSHIP, MEMBERSHIP_CREDIT_CENTS: '200' });
    expect(html).toContain('<li>$2 of credit included each year');
    expect(html).toContain('Each paid year comes with $2 of credit.');
    expect(row(html, 'Prepaid credit')).toMatch(/<td>\$2 a year included<\/td>$/);
  });

  it('without credit for sale: no paid column unless there is a membership, and no credit fine print', async () => {
    const { html } = await pricing(NO_CREDIT);
    expect(html).toContain('<h1>Learn free, or on your own key.</h1>');
    expect(columns(html)).toEqual(['Free']);
    expect(html).toContain('<div class="plans one">');
    expect(html).not.toMatch(/Pay as you go|top up|Prepaid credit|Tangent’s \d+% markup|Polar/i);
    expect(html).toContain('<th scope="row">The Max tier, for the hardest questions</th>');

    // A provider that sells the membership but no top-ups.
    const member = (await pricing({ ...MEMBERSHIP, FAKE_PAYMENTS: '{"topUps":false}' })).html;
    expect(columns(member)).toEqual(['Free', 'Your own key']);
    expect(member).toContain('<h1>Learn free, or bring your own key for $10 a year.</h1>');
    expect(member).not.toMatch(/credit included|top up|Tangent’s \d+% markup|rule of thumb/i);
  });

  it('says on each pool line of the cards that it lasts while the pool has credit, with the balance now', async () => {
    const poolId = uniq('pool');
    await fundPool(poolId, 12_340_000);
    const funded = (await pricing({ ...MEMBERSHIP, POOL_ACCOUNT_ID: poolId })).html;
    const pill = '<span class="while">While the pool has credit · currently $12.34</span></li>';
    // One pool line on the cards: the limits are the same whatever you pay with.
    expect(funded.split(pill).length).toBe(2);
    expect(funded).toMatch(
      /free replies a day on the open pool<sup[^]*?<\/sup><span class="while">/,
    );

    const empty = (await pricing({ POOL_ACCOUNT_ID: uniq('pool') })).html;
    expect(empty).toContain(
      '<span class="while">While the pool has credit · empty right now</span></li>',
    );
  });

  it('without the pool: no free replies are promised', async () => {
    const { html } = await pricing(NO_POOL);
    expect(html).toContain('<h1>Pay only for what you use.</h1>');
    expect(html).not.toMatch(/open pool|Start learning free/);
    expect(html).toContain('<a class="btn" href="/learn/login">Start learning</a>');
    expect(html).toContain('<p class="for">Learn on your own OpenRouter key.</p>');

    const neither = (await pricing({ ...NO_POOL, ...NO_CREDIT })).html;
    expect(neither).toContain('<h1>Free on your own key.</h1>');
    expect(columns(neither)).toEqual(['Free']);
  });

  it('describes web search as the GROUNDING ceiling allows, and leaves it out when off', async () => {
    const auto = (await pricing({ GROUNDING: 'auto' })).html;
    expect(auto).toContain('<th scope="row">Web search, with sources');
    expect(auto).toContain('When a reply probably needs checking');
    expect(auto).toContain('On credit, automatic searches stop after 40 a day');
    expect(auto).toContain('It isn’t available with OpenAI keys, and it’s off on the open pool.');
    const explicit = (await pricing({ GROUNDING: 'explicit' })).html;
    expect(explicit).toContain('<strong>Check sources</strong> under an answer');
    expect(explicit).toContain('<li>Web search to check any answer</li>');
    const off = (await pricing({ GROUNDING: 'off' })).html;
    expect(off).not.toMatch(/web search/i);
  });

  it('names share links only while sharing is on', async () => {
    const on = (await pricing({ DMCA_AGENT_REGISTERED: 'true' })).html;
    expect(on).toContain('Read-only share links, Markdown and HTML export');
    const off = (await pricing({ DMCA_AGENT_REGISTERED: 'false' })).html;
    expect(off).not.toContain('share links');
    expect(off).toContain('<th scope="row">Markdown and HTML export</th>');
  });
});
