// The public pages (http/landing.tsx, pricing-page.tsx, pool-page.tsx,
// legal.tsx) as a visitor gets them from the deployment wrangler.jsonc ships,
// and from the configs a self-hoster can choose: with or without the pool,
// credit for sale and the membership. The tests hold invariants (the CSP,
// no script, consistent notes, no forbidden claim) and the facts each config
// states (columns, prices, caps, yes/no rows), not the wording.
import {
  FORBIDDEN_POOL_COPY,
  formatBps,
  formatCents,
  formatMicros,
  POOL_EMPTY_TEXT,
  poolModelText,
  roughWords,
} from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ownKeyProviders } from '../src/availability.js';
import { appConfig, DEFAULT_BACKGROUND_MODEL } from '../src/config.js';
import type { AppEnv } from '../src/env.js';
import { POOL_SESSION_ESTIMATE_MICROS } from '../src/pool/params.js';
import { poolModelInfo } from '../src/pool/status.js';
import { envWithFailingDb, uniq } from './mocks/billing-helpers.js';
import { shippedEnv } from './mocks/wrangler-vars.js';
import { fundPool } from './pool-helpers.js';

const env = rawEnv as unknown as AppEnv;
const PAGES = ['/welcome', '/pricing', '/pool', '/privacy', '/terms'] as const;

const NO_POOL: Partial<AppEnv> = { POOL_ENABLED: 'false' };
/** Polar sells no top-ups without a credits product. */
const NO_CREDIT: Partial<AppEnv> = { POLAR_CREDITS_PRODUCT_ID: '' };
const NO_MEMBERSHIP: Partial<AppEnv> = { ANNUAL_FEE_ENABLED: 'false' };

/** What a self-hoster can sell and offer, each on or off. */
const CONFIGS: Record<string, Partial<AppEnv>> = {
  'as shipped': {},
  'no membership': NO_MEMBERSHIP,
  'no credit': NO_CREDIT,
  'no pool': NO_POOL,
  'only the pool': { ...NO_CREDIT, ...NO_MEMBERSHIP },
  'only the membership': { ...NO_POOL, ...NO_CREDIT },
  'only credit': { ...NO_POOL, ...NO_MEMBERSHIP },
  'nothing sold, no pool': { ...NO_POOL, ...NO_CREDIT, ...NO_MEMBERSHIP },
};

/** wrangler.jsonc's deployment (Polar's secrets set, a pool of its own) with `overrides`. */
function deployment(overrides: Partial<AppEnv> = {}): AppEnv {
  return shippedEnv(env, {
    POLAR_ACCESS_TOKEN: 'oat',
    POLAR_WEBHOOK_SECRET: 'whsec',
    TEST_POOL_ACCOUNT_ID: uniq('pool'),
    ...overrides,
  });
}

async function get(e: AppEnv, path: string): Promise<{ res: Response; html: string }> {
  const res = await createApp().request(`https://tangentailearning.com${path}`, {}, e);
  return { res, html: await res.text() };
}

/** `html`'s text as read: tags dropped (block ones as a space), entities decoded, footnote marks dropped. */
function text(html: string): string {
  return html
    .replace(/<style>[^]*?<\/style>/g, '')
    .replace(/<sup class="fn">[^]*?<\/sup>/g, '')
    .replace(/<\/?(?:a|b|i|em|strong|code|span|small|mark)\b[^>]*>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The pricing chart: its column headings, and each row's cells (`✓`, `—` or the cell's text) by row label. */
function chart(html: string): { columns: string[]; rows: Map<string, string[]> } {
  const head = /<thead>([^]*?)<\/thead>/.exec(html)?.[1] ?? '';
  const columns = [...head.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((m) => m[1]!);
  const rows = new Map<string, string[]>();
  for (const [, label, cells] of html.matchAll(/<tr><th scope="row">([^]*?)<\/th>([^]*?)<\/tr>/g)) {
    rows.set(
      text(label!),
      [...cells!.matchAll(/<td( class="(?:yes|no)")?>([^]*?)<\/td>/g)].map(([, cls, body]) =>
        cls === ' class="yes"' ? '✓' : cls === ' class="no"' ? '—' : text(body!),
      ),
    );
  }
  return { columns, rows };
}

/** The chart row whose label starts with `label`. */
function row(html: string, label: string): string[] {
  const rows = chart(html).rows;
  const key = [...rows.keys()].find((k) => k.startsWith(label));
  expect(key, `row "${label}" in ${[...rows.keys()].join(' | ')}`).toBeDefined();
  return rows.get(key!)!;
}

/** The pricing page's notes, by id, as text. */
function notes(html: string): Map<string, string> {
  return new Map(
    [...html.matchAll(/<li id="note-([a-z-]+)">([^]*?)<\/li>/g)].map(([, id, body]) => [
      id!,
      text(body!),
    ]),
  );
}

async function sha256Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

describe('every public page, in every config', () => {
  it('renders as shipped and allows only its own stylesheet: no script, no inline style or handler', async () => {
    for (const [name, overrides] of Object.entries(CONFIGS)) {
      const e = deployment({ ...overrides, LEGAL_OPERATOR: 'Ada <Lovelace> & Co' });
      await fundPool(e.TEST_POOL_ACCOUNT_ID!, 1_000_000);
      for (const path of PAGES) {
        const where = `${name} ${path}`;
        const { res, html } = await get(e, path);
        expect(res.status, where).toBe(200);
        expect(res.headers.get('Content-Type'), where).toBe('text/html; charset=utf-8');
        expect(res.headers.get('X-Content-Type-Options'), where).toBe('nosniff');
        expect(res.headers.get('Referrer-Policy'), where).toBe('same-origin');
        expect(res.headers.get('Cache-Control'), where).toBe('public, max-age=300');
        const styles = [...html.matchAll(/<style>([^]*?)<\/style>/g)].map((m) => m[1]!);
        expect(styles, where).toHaveLength(1);
        expect(res.headers.get('Content-Security-Policy'), where).toBe(
          `default-src 'none'; style-src 'sha256-${await sha256Base64(styles[0]!)}'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        );
        expect(html, where).toMatch(/^<!doctype html>\n<html lang="en">/);
        expect(html.replace(/<style>[^]*?<\/style>/, ''), where).not.toMatch(
          /<script|\son\w+=|\sstyle=|<form/i,
        );
        expect(html, where).toContain(
          `<link rel="canonical" href="https://tangentailearning.com${path === '/welcome' ? '/' : path}"/>`,
        );
        for (const href of ['/pricing', '/pool', '/privacy', '/terms'])
          expect(html, where).toContain(`href="${href}"`);
        // Escaped: the operator's name is text, wherever it appears.
        expect(html, where).toContain('Ada &lt;Lovelace&gt; &amp; Co');
        expect(html, where).not.toContain('<Lovelace>');
      }
    }
  });

  it('never calls the pool a donation, nor offers to sell pool credit', async () => {
    for (const [name, overrides] of Object.entries(CONFIGS)) {
      const e = deployment(overrides);
      for (const path of [...PAGES, '/api/pool/status']) {
        const page = text((await get(e, path)).html);
        expect(page, `${name} ${path}`).not.toMatch(FORBIDDEN_POOL_COPY);
        expect(page, `${name} ${path}`).not.toMatch(
          /buy(ing)? (pool )?credit for the pool|fund(ing)? the pool|anyone can add|pool purchase|revenue share|of what it earns/i,
        );
      }
    }
  });

  it('promises free replies only while the pool is on, and a free sign-up only while it has credit', async () => {
    for (const [name, overrides] of Object.entries(CONFIGS)) {
      const funded = deployment(overrides);
      await fundPool(funded.TEST_POOL_ACCOUNT_ID!, 1_000_000);
      const pool = overrides.POOL_ENABLED !== 'false';
      for (const path of ['/welcome', '/pricing']) {
        const page = text((await get(funded, path)).html);
        expect(/learn(ing)? free|free replies/i.test(page), `${name} ${path}`).toBe(pool);
        expect(page.includes('Start learning free'), `${name} ${path}`).toBe(pool);
      }
    }
    // On, but empty: the landing page says so, and has no free sign-up.
    const empty = text((await get(deployment(), '/welcome')).html);
    expect(empty).toContain(POOL_EMPTY_TEXT);
    expect(empty).not.toMatch(/Start learning free|No credit card needed/);
  });

  it('says Tangent earns money only from what it sells', async () => {
    for (const [name, overrides] of Object.entries(CONFIGS)) {
      if (overrides.POOL_ENABLED === 'false') continue;
      const e = deployment(overrides);
      const membership = overrides.ANNUAL_FEE_ENABLED !== 'false';
      const credit = overrides.POLAR_CREDITS_PRODUCT_ID !== '';
      for (const path of ['/welcome', '/pricing']) {
        const steps = text(/<ol class="steps">[^]*?<\/ol>/.exec((await get(e, path)).html)![0]);
        const where = `${name} ${path}`;
        const earns = /earns money from ([^,]*),/.exec(steps)?.[1] ?? '';
        expect(/membership/.test(earns), where).toBe(membership);
        expect(/credit/.test(earns), where).toBe(credit);
        expect(steps.includes('earns money'), where).toBe(membership || credit);
      }
    }
  });

  it('never calls the own key free while it needs the membership, and offers credit only where it is sold', async () => {
    for (const [name, overrides] of Object.entries(CONFIGS)) {
      const e = deployment(overrides);
      const membership = overrides.ANNUAL_FEE_ENABLED !== 'false';
      const credit = overrides.POLAR_CREDITS_PRODUCT_ID !== '';
      for (const path of ['/welcome', '/pricing']) {
        const page = text((await get(e, path)).html);
        const where = `${name} ${path}`;
        expect(
          /free on your own key|Tangent charges nothing|nothing added by Tangent|On your key/i.test(
            page,
          ),
          where,
        ).toBe(!membership);
        expect(/membership/i.test(page), where).toBe(membership);
        expect(/prepaid credit|pay as you go|top up/i.test(page), where).toBe(credit);
        // Credit never needs the membership.
        expect(page, where).not.toMatch(/credit needs a membership|members only/i);
      }
      const pool = text((await get(e, '/pool')).html);
      expect(/buy credit/.test(pool), name).toBe(credit);
      expect(/with a membership/.test(pool), name).toBe(membership);
    }
  });
});

describe('/pricing', () => {
  it('has a column per way to pay this deployment offers, and a plan card for each', async () => {
    for (const [name, overrides] of Object.entries(CONFIGS)) {
      const { html } = await get(deployment(overrides), '/pricing');
      const columns = [
        'Free',
        ...(overrides.POLAR_CREDITS_PRODUCT_ID === '' ? [] : ['Pay as you go']),
        ...(overrides.ANNUAL_FEE_ENABLED === 'false' ? [] : ['Your own key']),
      ];
      expect(chart(html).columns, name).toEqual(columns);
      expect(html.match(/<article class="plan[ "]/g), name).toHaveLength(columns.length);
      for (const cells of chart(html).rows.values())
        expect(cells, name).toHaveLength(columns.length);
    }
  });

  it('numbers its notes in reading order; every citation has a note and every note a citation', async () => {
    for (const [name, overrides] of Object.entries(CONFIGS)) {
      const { html } = await get(deployment(overrides), '/pricing');
      const cited = [
        ...html.matchAll(
          /<a href="#note-([a-z-]+)"(?: id="ref-[a-z-]+")? aria-label="Note (\d+)">(\d+)<\/a>/g,
        ),
      ];
      expect(cited.length, name).toBeGreaterThan(0);
      const order: string[] = [];
      for (const [, id, label, n] of cited) {
        if (!order.includes(id!)) order.push(id!);
        expect(Number(n), name).toBe(order.indexOf(id!) + 1);
        expect(label, name).toBe(n);
      }
      expect([...notes(html).keys()], name).toEqual(order);
      // Each note's back link has exactly one anchor to return to.
      for (const id of order) expect(html.split(`id="ref-${id}"`).length, `${name} ${id}`).toBe(2);
    }
  });

  it('states the prices from the config', async () => {
    const shipped = deployment();
    const { billing } = appConfig(shipped);
    const { html } = await get(shipped, '/pricing');
    const page = text(html);
    expect(row(html, 'Price')).toEqual([
      '$0',
      `At cost + ${formatBps(billing.markupBps)}`,
      `${formatCents(billing.membershipPriceCents)} a year`,
    ]);
    // 5.5% fee and 10% markup: 1.16¢ per 1¢; $10 over 10%: $100 a year.
    expect(notes(html).get('credit')).toContain('you pay about 1.16¢');
    expect(page).toContain('less than about $100 a year on AI');
    expect(notes(html).get('top-up')).toMatch(/^Top up \$5 to \$500 at a time/);

    const repriced = await get(
      deployment({ MARKUP_BPS: '2000', OPENROUTER_FEE_BPS: '0', MEMBERSHIP_PRICE_CENTS: '1500' }),
      '/pricing',
    );
    expect(row(repriced.html, 'Price')).toEqual(['$0', 'At cost + 20%', '$15 a year']);
    expect(notes(repriced.html).get('credit')).toContain('you pay about 1.20¢');
    expect(notes(repriced.html).get('credit')).not.toContain('fee');
    expect(text(repriced.html)).toContain('less than about $75 a year on AI');
    // No break-even without both the membership and credit.
    for (const overrides of [NO_CREDIT, NO_MEMBERSHIP])
      expect(text((await get(deployment(overrides), '/pricing')).html)).not.toContain(
        'a year on AI',
      );
  });

  it('includes, per column, what each way to pay covers', async () => {
    const member = (await get(deployment(), '/pricing')).html;
    expect(row(member, 'Your own OpenRouter key')).toEqual(['—', '—', '✓']);
    expect(row(member, 'The Max tier')).toEqual(['—', '✓', '✓']);
    expect(row(member, 'Web search')).toEqual(['—', '✓', '✓']);
    expect(row(member, 'Every control')).toEqual(['Read and export', '✓', '✓']);
    expect(row(member, 'Any OpenRouter model, on prepaid credit')).toEqual([
      '—',
      '✓',
      'Bought separately',
    ]);
    expect(row(member, 'Prepaid credit')).toEqual(['—', 'Top up from $5', 'Bought separately']);
    expect(row(member, 'Tangent’s charge on your own key')).toEqual([
      '—',
      '—',
      'Nothing per reply',
    ]);

    const free = (await get(deployment(NO_MEMBERSHIP), '/pricing')).html;
    expect(row(free, 'Your own OpenRouter key')).toEqual(['✓', '✓']);
    expect(row(free, 'The Max tier')).toEqual(['On your key', '✓']);
    expect(row(free, 'Web search')).toEqual(['On your key', '✓']);
    expect(row(free, 'Every control')).toEqual(['On your keys', '✓']);
    expect(row(free, 'Tangent’s charge on your own key')).toEqual(['Nothing', 'Nothing']);

    // Learn with one model has no tier to choose.
    const one = (await get(deployment({ LEARN_MAX_MODEL: DEFAULT_BACKGROUND_MODEL }), '/pricing'))
      .html;
    expect([...chart(one).rows.keys()].some((k) => k.includes('tier'))).toBe(false);
  });

  it('states the pool’s caps, model and reply length from the config, the same in every column', async () => {
    const e = deployment({ POOL_REQUESTS_PER_DAY: '12', POOL_MAX_OUTPUT_TOKENS: '2048' });
    const { pool } = appConfig(e);
    const { html } = await get(e, '/pricing');
    expect(row(html, 'Free replies on the open pool')).toEqual(Array(3).fill('12 a day'));
    const note = notes(html).get('pool')!;
    expect(note).toContain(`up to 12 replies or ${formatMicros(pool.caps.user.spendMicrosPerDay)}`);
    expect(note).toContain(`2,048 tokens long (roughly ${roughWords(2048)} words)`);
    expect(note).toContain(poolModelText(poolModelInfo(e), { replies: false }));
    expect(text(html)).toContain(poolModelText(poolModelInfo(e)));
  });

  it('says on the plan cards that the pool lasts while it has credit, with today’s balance', async () => {
    const e = deployment();
    await fundPool(e.TEST_POOL_ACCOUNT_ID!, 12_340_000);
    const funded = (await get(e, '/pricing')).html;
    expect(funded.match(/<span class="while">[^<]*<\/span>/g)).toEqual([
      '<span class="while">While the pool has credit · currently $12.34</span>',
    ]);
    expect((await get(deployment(), '/pricing')).html).toContain('empty right now</span>');
  });

  it('describes web search as GROUNDING allows, with its daily cap and the providers that can’t search', async () => {
    const auto = await get(deployment(), '/pricing');
    const { grounding } = appConfig(deployment());
    const unable = ownKeyProviders(deployment()).filter((p) => !p.search);
    expect(unable.length).toBeGreaterThan(0);
    const search = notes(auto.html).get('search')!;
    expect(search).toContain(`stop after ${grounding.autoDailyCap} a day`);
    expect(search).toContain('about 1¢');
    for (const p of unable) expect(search).toContain(p.label);
    // Only OpenRouter's Exa price is about 1¢.
    expect(
      notes((await get(deployment({ GROUNDING_ENGINE: 'parallel' }), '/pricing')).html).get(
        'search',
      ),
    ).not.toContain('1¢');
    // On request only: no automatic searches to cap.
    const explicit = notes((await get(deployment({ GROUNDING: 'explicit' }), '/pricing')).html);
    expect(explicit.get('search')).not.toContain('stop after');
    for (const page of ['/pricing', '/welcome'])
      expect(text((await get(deployment({ GROUNDING: 'off' }), page)).html)).not.toMatch(
        /web search|Check sources/i,
      );
  });

  it('names the own-key providers, and share links only while sharing is on', async () => {
    const labels = ownKeyProviders(deployment()).map((p) => p.label);
    const html = (await get(deployment(), '/pricing')).html;
    const keys = [...chart(html).rows.keys()].find(
      (k) => k.startsWith('Your own ') && k.endsWith(' keys'),
    )!;
    for (const label of labels) expect(keys).toContain(label);
    for (const page of ['/welcome', '/pricing']) {
      expect(text((await get(deployment(), page)).html)).not.toMatch(/share link/i);
      expect(text((await get(deployment({ DMCA_AGENT_REGISTERED: 'true' }), page)).html)).toMatch(
        /share links/i,
      );
    }
  });
});

describe('the landing page', () => {
  it('shows the meter: about N learning sessions and the dollars, ahead of the two modes', async () => {
    const e = deployment();
    await fundPool(e.TEST_POOL_ACCOUNT_ID!, 2_468_000);
    const { html } = await get(e, '/welcome');
    const sessions = Math.floor(2_468_000 / POOL_SESSION_ESTIMATE_MICROS);
    expect(text(html)).toContain(`About ${sessions} learning sessions left`);
    expect(text(html)).toContain(`${formatMicros(2_468_000)} in the pool`);
    expect(html.indexOf('aria-labelledby="pool"')).toBeGreaterThan(-1);
    expect(html.indexOf('aria-labelledby="pool"')).toBeLessThan(
      html.indexOf('aria-labelledby="modes"'),
    );
    expect(text(html)).toContain(`the free pool uses ${poolModelText(poolModelInfo(e))}`);
  });

  it('leaves the pool out while it is off or can’t be read', async () => {
    const off = await get(deployment(NO_POOL), '/welcome');
    expect(off.html).not.toContain('aria-labelledby="pool"');
    const broken = await get(
      envWithFailingDb(deployment(), /credit_grants|usage_events/),
      '/welcome',
    );
    expect(broken.res.status).toBe(200);
    expect(broken.html).not.toContain('aria-labelledby="pool"');
  });

  it('states the membership’s price, the markup and Learn’s tiers from the config', async () => {
    const e = deployment({ MEMBERSHIP_PRICE_CENTS: '1500', MARKUP_BPS: '2000' });
    const page = text((await get(e, '/welcome')).html);
    expect(page).toContain('$15 yearly membership');
    expect(page).toContain('plus 20%');
    expect(page).toContain('Two tiers: Normal');
    expect(
      text((await get(deployment({ LEARN_MAX_MODEL: DEFAULT_BACKGROUND_MODEL }), '/welcome')).html),
    ).not.toContain('Two tiers');
  });
});

describe('/pool', () => {
  it('states the model, the reply cap and every limit from the config', async () => {
    const e = deployment({ POOL_REQUESTS_PER_DAY: '12', POOL_MAX_OUTPUT_TOKENS: '2048' });
    const { pool } = appConfig(e);
    const { html } = await get(e, '/pool');
    const limits = new Map(
      [...html.matchAll(/<tr><td>([^<]*)<\/td><td>([^<]*)<\/td><\/tr>/g)].map(([, k, v]) => [
        k!,
        text(v!),
      ]),
    );
    expect(Object.fromEntries(limits)).toEqual({
      'Replies per learner per day': '12',
      'Spending per learner per day': formatMicros(pool.caps.user.spendMicrosPerDay),
      'Replies per minute': String(pool.limits.userPerMinute),
      'Per network per day': `${pool.caps.ip.requestsPerDay} replies, ${formatMicros(pool.caps.ip.spendMicrosPerDay)}`,
      'All learners together, per day': expect.stringContaining(
        `${formatMicros(pool.caps.global.spendMicrosPerDay)} or ${formatBps(pool.caps.global.bpsOfMorningBalance)} of the pool`,
      ),
    });
    expect(html).toContain(`<code>${DEFAULT_BACKGROUND_MODEL}</code>`);
    expect(text(html)).toContain(`2,048 tokens (roughly ${roughWords(2048)} words)`);
    // The ceiling hold of the pool model's longest reply, from its price.
    expect(text(html)).toMatch(/about (\$\d\.\d\d|\d+(\.\d)?¢)\) and settles the real cost/);
  });

  it('names the operator’s contact, and says when the pool isn’t running', async () => {
    const e = deployment({ LEGAL_CONTACT_EMAIL: 'hello@example.com' });
    expect((await get(e, '/pool')).html).toContain('href="mailto:hello@example.com"');
    expect(text((await get(e, '/pool')).html)).not.toContain('isn’t running');
    expect(text((await get(deployment(NO_POOL), '/pool')).html)).toContain('isn’t running');
  });
});
