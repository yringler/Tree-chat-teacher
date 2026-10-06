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

/** As deployed: the pool on with a 20% revenue share, credit sold (the fake provider), no membership. */
const DEPLOYED: Partial<AppEnv> = { POOL_REVENUE_SHARE_BPS: '2000' };

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

  it('as deployed (pool on, credit sold, no membership): Free and Pay as you go, with the fine print in notes', async () => {
    const { pool, billing } = appConfig(authEnv(DEPLOYED));
    const { html } = await pricing();
    expect(html).toContain('<h1>Learn free. Pay only for what you use.</h1>');
    expect(html).toContain('No subscription, nothing to cancel.');
    expect(columns(html)).toEqual(['Free', 'Pay as you go']);
    expect(html).toContain('<h3>Free</h3>\n<p class="price">$0</p>');
    expect(html).toContain('<a class="btn primary" href="/learn/login">Start learning free</a>');
    expect(html).toContain(`${pool.caps.free.requestsPerDay} free replies a day on the open pool`);
    expect(html).toContain('<li>Every power-mode control, on your own keys</li>');
    expect(billing.markupBps).toBe(1000);
    expect(html).toContain('<p class="price">At cost<small> + 10% a reply</small>');
    // The notes: the pool's limits, at-cost pricing with both fees, top-ups and tax.
    expect(html).toContain('Tangent puts 20% of what it earns into it');
    expect(html).toContain(
      `${pool.caps.free.requestsPerDay} replies and ${formatMicros(pool.caps.free.spendMicrosPerDay)} of AI cost a day, while the pool has credit`,
    );
    expect(html).toContain('<a href="/pool">How the pool works, with every limit</a>');
    expect(html).toContain(
      'Each reply costs what OpenRouter charges for it, plus OpenRouter’s 5.5% fee for buying credit, plus Tangent’s 10% markup.',
    );
    expect(html).toContain('Tangent puts 20% of its markup into the open pool as credit is used.');
    // Why there's a free plan: Tangent's own policy, not tied to the reader's purchase.
    expect(html).toContain('<h2 id="why">Why there’s a free plan</h2>');
    expect(html).toContain('Tangent is a business: the credit people buy pays for it.');
    expect(html).toContain(
      '<li>Tangent earns from the credit people buy, like any software business.</li>',
    );
    expect(html).toContain('Top up between $5 and $500 at a time. Tax is added at checkout');
    expect(html).toContain('Credit doesn’t expire while your account exists');
    expect(html).toContain('<th scope="row">Any OpenRouter model, on Tangent credit</th>');
    expect(html).toContain(
      '<th scope="row">What Tangent adds on your own key</th><td>Nothing</td><td>Nothing</td>',
    );
    // Nothing needs a membership (the pool's funding sentence still names membership payments).
    expect(html).not.toMatch(/needs? a membership|a year \+ tax|Membership</);
  });

  it('with the membership required: the paid column is the membership, and own keys in power need it', async () => {
    const { pool } = appConfig(authEnv({ ...DEPLOYED, ...MEMBERSHIP }));
    const { html } = await pricing(MEMBERSHIP);
    expect(columns(html)).toEqual(['Free', 'Membership']);
    expect(html).toContain('<p class="price">$10<small> a year + tax</small>');
    expect(html).toContain(
      `<li>${pool.caps.member.requestsPerDay} pool replies a day instead of ${pool.caps.free.requestsPerDay}<span class="while">While the pool has credit`,
    );
    expect(html).toContain('<li>$2 of credit included each year');
    expect(html).toContain('A yearly membership adds more room on the pool');
    expect(html).toContain('Tangent is a business: memberships and credit pay for it.');
    expect(html).toContain(
      '<li>Tangent earns from memberships and credit, like any software business.</li>',
    );
    expect(html).not.toContain('No subscription');
    expect(html).not.toContain('Every power-mode control, on your own keys');
    expect(html).toContain(
      'In power mode your own keys need a membership; in Learn they never do.',
    );
    expect(html).toContain(
      'Buying credit needs a membership; credit you already have keeps working',
    );
    expect(html).toContain(
      'stay listed, readable and exportable, and you can copy any of them into Learn',
    );
    expect(html).toContain(
      '<th scope="row">Your own API keys, for any provider offered here</th><td class="no">',
    );
    expect(html).toContain('$2 a year included; top up from $5');
    expect(html).toContain('Each paid year includes $2 of credit.');
  });

  it('without credit for sale: no paid column unless there is a membership, and no credit fine print', async () => {
    const { html } = await pricing(NO_CREDIT);
    expect(html).toContain('<h1>Learn free, or on your own key.</h1>');
    expect(columns(html)).toEqual(['Free']);
    expect(html).toContain('<div class="plans one">');
    expect(html).not.toMatch(/Pay as you go|top up|Prepaid credit|Tangent’s \d+% markup|Polar/i);
    expect(html).toContain('<th scope="row">The Smart tier, for deeper answers</th>');

    // A provider that sells the membership but no top-ups.
    const member = (await pricing({ ...MEMBERSHIP, FAKE_PAYMENTS: '{"topUps":false}' })).html;
    expect(columns(member)).toEqual(['Free', 'Membership']);
    expect(member).not.toMatch(/credit included|top up|Tangent’s \d+% markup/i);
  });

  it('says on each pool line of the cards that it lasts while the pool has credit, with the balance now', async () => {
    const poolId = uniq('pool');
    await fundPool(poolId, 12_340_000);
    const funded = (await pricing({ ...MEMBERSHIP, POOL_ACCOUNT_ID: poolId })).html;
    const pill = '<span class="while">While the pool has credit · currently $12.34</span></li>';
    expect(funded.split(pill).length).toBe(3);
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
    expect(auto).toContain('<th scope="row">Web search to check facts');
    expect(auto).toContain('Offered when an answer likely needs it');
    expect(auto).toContain('not on the open pool or on Anthropic or OpenAI keys');
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
