// The community pool's public surfaces (docs/pool/PLAN.md §S6): the meter
// (`GET /api/pool/status`, also on the landing page), the caller's standing
// (`GET /api/pool/me`), the transparency page `/pool`, and the copy rule.
import {
  FORBIDDEN_POOL_COPY,
  POOL_NOTICE_VERSION,
  type PoolMeResponse,
  type PoolStatusResponse,
} from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { appConfig } from '../src/config.js';
import type { AppEnv } from '../src/env.js';
import { LANDING_STYLE } from '../src/http/landing.js';
import { LEGAL_STYLE } from '../src/http/legal.js';
import { poolStatus, weekStart } from '../src/pool/status.js';
import { envWithFailingDb, uniq } from './mocks/billing-helpers.js';
import { fundPool, poolReadyUser } from './pool-helpers.js';
import { authEnv, ORIGIN } from './session-client.js';

const env = rawEnv as unknown as AppEnv;

/** A request without a session, as a visitor's browser sends it. */
function visitor(e: AppEnv) {
  const app = createApp();
  return (path: string) => app.request(`${ORIGIN}${path}`, {}, e);
}

/** An env (auth configured) whose pool is `poolId`, with the deployed 20% revenue share. */
function poolEnv(poolId: string, overrides: Partial<AppEnv> = {}): AppEnv {
  return authEnv({ POOL_ACCOUNT_ID: poolId, POOL_REVENUE_SHARE_BPS: '2000', ...overrides });
}

/** The public commitment, exactly as every page states it at 20%. */
const COMMITMENT =
  "The community pool is free credit Tangent provides. Tangent puts 20% of what it earns into it: 20% of each membership payment after payment fees, and 20% of the markup on credit as it's used.";

/** A settled pool row of `userId` (no pending rows: other suites' crons would expire them). */
async function settledReply(
  poolId: string,
  userId: string,
  chargeMicros: number,
  opts: { createdAt?: string; reason?: string; purpose?: string } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO usage_events (id, account_id, funding, user_id, purpose, provider_id, model, status,
       hold_micros, markup_bps, fee_bps, charge_micros, settle_reason, created_at)
     VALUES (?, ?, 'pool', ?, ?, 'openrouter', 'simple', 'settled', 5000, 0, 0, ?, ?, ?)`,
  )
    .bind(
      uniq('use'),
      poolId,
      userId,
      opts.purpose ?? 'reply',
      chargeMicros,
      opts.reason ?? (chargeMicros > 0 ? 'cost' : 'released'),
      opts.createdAt ?? new Date().toISOString(),
    )
    .run();
}

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

describe('GET /api/pool/status', () => {
  it('is public, edge-cached for a minute (not by browsers), and aggregates only', async () => {
    const poolId = uniq('pool');
    await fundPool(poolId, 1_000_000);
    const res = await visitor(poolEnv(poolId))('/api/pool/status');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
    const status = (await res.json()) as PoolStatusResponse;
    const config = appConfig(poolEnv(poolId));
    expect(status).toEqual({
      enabled: true,
      availableMicros: 1_000_000,
      sessionsRemaining: Math.floor(1_000_000 / config.pool.sessionEstimateMicros),
      model: { id: 'simple', label: expect.any(String) },
      week: { start: weekStart(new Date()).toISOString(), exchanges: 0, learners: 0 },
      revenueShareBps: 2000,
    });
    // The edge copy answers the next minute's visitors, whatever D1 says meanwhile.
    await fundPool(poolId, 2_000_000);
    const again = (await (
      await visitor(poolEnv(poolId))('/api/pool/status')
    ).json()) as PoolStatusResponse;
    expect(again.availableMicros).toBe(1_000_000);
  });

  it('counts this week’s funded exchanges and learners, not released or free replies', async () => {
    const poolId = uniq('pool');
    await fundPool(poolId, 500_000);
    const now = new Date();
    const [a, b, c] = [uniq('user'), uniq('user'), uniq('user')];
    await settledReply(poolId, a, 1_200);
    await settledReply(poolId, a, 900);
    await settledReply(poolId, b, 1_500);
    // Released (never reached the model) and settled at 0: not funded exchanges.
    await settledReply(poolId, c, 0, { reason: 'released' });
    await settledReply(poolId, c, 0, { reason: 'cost' });
    // A summary is not an exchange; last week's reply is not this week's.
    await settledReply(poolId, c, 700, { purpose: 'summary' });
    await settledReply(poolId, c, 700, {
      createdAt: new Date(weekStart(now).getTime() - 1).toISOString(),
    });

    const status = await poolStatus(poolEnv(poolId), now);
    expect(status.week).toEqual({
      start: weekStart(now).toISOString(),
      exchanges: 3,
      learners: 2,
    });
    expect(status.availableMicros).toBe(500_000 - 1_200 - 900 - 1_500 - 700 - 700);
    expect(JSON.stringify(status)).not.toMatch(new RegExp(`${a}|${b}|${c}`));
  });

  it('weeks start on Monday 00:00 UTC', () => {
    expect(weekStart(new Date('2026-10-05T13:00:00Z')).toISOString()).toBe(
      '2026-10-05T00:00:00.000Z',
    );
    expect(weekStart(new Date('2026-10-04T23:59:59Z')).toISOString()).toBe(
      '2026-09-28T00:00:00.000Z',
    );
  });

  it('says the pool is off, with nothing read, while POOL_ENABLED is off', async () => {
    const poolId = uniq('pool');
    await fundPool(poolId, 1_000_000);
    const off = envWithFailingDb(poolEnv(poolId, { POOL_ENABLED: 'false' }), /usage_events/);
    const status = await poolStatus(off);
    expect(status).toMatchObject({ enabled: false, availableMicros: 0, sessionsRemaining: 0 });
  });

  it('reports the configured revenue share, with or without payments', async () => {
    const status = await poolStatus(poolEnv(uniq('pool'), { PAYMENT_PROVIDER: 'polar' }));
    expect(status).toMatchObject({ enabled: true, revenueShareBps: 2000 });
    expect(status).not.toHaveProperty('fundingOpen');
    expect(status).not.toHaveProperty('markupBps');
  });
});

describe('GET /api/pool/me', () => {
  it('reports today’s caps and use, and the caller’s own credit', async () => {
    const { client, poolId, userId } = await poolReadyUser();
    await settledReply(poolId, userId, 2_000);
    await settledReply(poolId, userId, 0, { reason: 'released' });
    const res = await client.call('/api/pool/me', { learn: 'pool' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const me = (await res.json()) as PoolMeResponse;
    const caps = appConfig(client.env).pool.caps.free;
    expect(me).toEqual({
      available: true,
      verified: true,
      member: false,
      suspended: false,
      caps: {
        requestsPerDay: caps.requestsPerDay,
        spendMicrosPerDay: caps.spendMicrosPerDay,
        // The released reply never reached the model: it counts toward neither.
        usedRequests: 1,
        usedSpendMicros: 2_000,
        resetAt: expect.stringMatching(/T00:00:00\.000Z$/),
      },
      personalAvailableMicros: 0,
      // poolReadyUser acknowledged the current notice.
      consentVersion: POOL_NOTICE_VERSION,
      currentNoticeVersion: POOL_NOTICE_VERSION,
    });
  });

  it('needs a session', async () => {
    const res = await visitor(poolEnv(uniq('pool')))('/api/pool/me');
    expect(res.status).toBe(401);
  });
});

describe('the landing page’s pool meter', () => {
  it('shows about N learning sessions, the dollars, this week and where the credit comes from', async () => {
    const poolId = uniq('pool');
    await fundPool(poolId, 2_468_000);
    const learner = uniq('user');
    await settledReply(poolId, learner, 8_000);
    const html = await (await visitor(poolEnv(poolId))('/welcome')).text();
    const sessions = Math.floor(
      (2_468_000 - 8_000) / appConfig(poolEnv(poolId)).pool.sessionEstimateMicros,
    );
    expect(html).toContain(`About ${sessions} learning sessions left`);
    expect(html).toContain('$2.46 in the pool');
    expect(html).toContain('1 learner on the pool this week · 1 exchange funded this week');
    expect(html).toContain('<h2 id="pool">Curiosity shouldn’t need a credit card</h2>');
    expect(html).toContain(
      '<p class="sub">Good AI tutoring costs money to run, so most of it sits behind a paywall. Tangent puts 20% of what it earns into the community pool so that anyone can learn here for free, within daily limits.</p>',
    );
    // Open pool: "free" in the hero, the CTAs and the pricing card.
    expect(html).toContain('<p class="free"><strong>Free to start.</strong>');
    expect(html).toContain('<a class="btn" href="/learn/login">Start learning free</a>');
    expect(html).toContain(
      '<a class="btn primary" href="/learn/login">Start learning free</a>\n</article>',
    );
    expect(html).toContain(
      '<div class="ctas"><a class="btn primary" href="/learn/login">Start learning free</a><a class="btn" href="/pool">How the pool works</a></div>',
    );
    expect(html).toContain('<h3>Free, your key, or pay as you go</h3>');
    // Before the two modes, so the free option comes ahead of the paid ones.
    expect(html.indexOf('aria-labelledby="pool"')).toBeLessThan(
      html.indexOf('aria-labelledby="modes"'),
    );
    expect(html).toContain(
      'Each reply is paid from the pool at the AI provider&#39;s price, with no markup, and costs the learner nothing.',
    );
    expect(html).toContain('<a class="btn" href="/pool">How the pool works</a>');
    expect(html).toContain(
      'Or learn free on the community pool, within daily limits, on credit Tangent provides from its revenue',
    );
    // Nothing to buy for the pool.
    expect(html).not.toContain('fund-pool');
    expect(html).not.toMatch(
      /fund the pool|funded by people|anyone can add|pool purchase|opens soon/i,
    );
    expect(html).not.toContain('÷');
    // Still one hashed stylesheet and no script.
    expect([...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1])).toEqual([
      LANDING_STYLE,
    ]);
    expect(html).not.toContain('<script');
  });

  it('shows the empty state: Tangent refills it', async () => {
    const html = await (await visitor(poolEnv(uniq('pool')))('/welcome')).text();
    expect(html).toContain('The community pool is empty until Tangent adds more credit.');
    // No promise of free learning while there is nothing to learn on.
    expect(html).not.toContain('class="free"');
    expect(html).not.toContain('Start learning free');
    expect(html).toContain('<a class="btn" href="/learn/login">Start learning</a>');
    expect(html).toContain(
      '<div class="ctas"><a class="btn" href="/pool">How the pool works</a></div>',
    );
    // The commitment stands even when the balance is 0.
    expect(html).toContain('Curiosity shouldn’t need a credit card');
  });

  it('reads the share from the config, and states no percentage at 0', async () => {
    const at15 = await (
      await visitor(poolEnv(uniq('pool'), { POOL_REVENUE_SHARE_BPS: '1500' }))('/welcome')
    ).text();
    expect(at15).toContain('Tangent puts 15% of what it earns into the community pool');
    const unshared = uniq('pool');
    await fundPool(unshared, 1_000_000);
    const none = await (
      await visitor(poolEnv(unshared, { POOL_REVENUE_SHARE_BPS: '0' }))('/welcome')
    ).text();
    expect(none).toContain('<p class="free"><strong>Free to start.</strong>');
    expect(none).toContain('free credit Tangent provides so that anyone can learn here');
    expect(none).toContain('Tangent adds free credit to the community pool so that anyone');
    expect(none).not.toContain('of what it earns');
    expect(none).not.toMatch(/from its revenue|part of what it earns/);
  });

  it('is left out while the pool is off, or when it can’t be read', async () => {
    const off = await (
      await visitor(poolEnv(uniq('pool'), { POOL_ENABLED: 'false' }))('/welcome')
    ).text();
    expect(off).not.toContain('The community pool');
    expect(off).not.toMatch(/learning free|Free to start|Free, your key/);
    expect(off).toContain('Follow every tangent');

    const broken = envWithFailingDb(poolEnv(uniq('pool')), /credit_grants|usage_events/);
    const res = await visitor(broken)('/welcome');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('learning sessions');
    expect(html).toContain('Follow every tangent');
  });
});

describe('/pool', () => {
  it('is a public, script-free page allowed only its own stylesheet', async () => {
    const res = await visitor(poolEnv(uniq('pool')))('/pool');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(res.headers.get('Content-Security-Policy')).toContain(
      `style-src 'sha256-${await sha256Base64(LEGAL_STYLE)}'`,
    );
    const html = await res.text();
    expect(html).toContain('<h1>The community pool</h1>');
    expect(html).not.toContain('<script');
  });

  it('states this deployment’s model, revenue share, at-cost replies, caps and member rule', async () => {
    const e = poolEnv(uniq('pool'), { POOL_FREE_REQUESTS_PER_DAY: '30' });
    const html = await (await visitor(e)('/pool')).text();
    expect(html).toContain('<code>simple</code>');
    expect(html).toContain(
      `<strong>The short version.</strong> ${COMMITMENT.replace("it's", 'it&#39;s')} Any signed-in learner can use it in Tangent Learn`,
    );
    expect(html).toContain(
      'Pool credit isn&#39;t sold. Tangent adds 20% of each membership payment, after tax and the payment provider&#39;s fee, when the payment comes in, and once a day 20% of the markup on the credit people used the day before (UTC).',
    );
    expect(html).toContain(
      'If a membership payment is refunded, the same part of its share comes back out of the pool.',
    );
    expect(html).toContain('<h2>What a reply costs</h2>');
    expect(html).toContain(
      'with no markup, and costs the learner nothing. Tangent earns nothing on the pool.',
    );
    expect(html).not.toContain('÷');
    expect(html).toContain('<td>Replies per learner per day</td><td>30 (members: 6)</td>');
    expect(html).toContain('every learner gets the free limits.');
    expect(html).not.toMatch(/thank-you|funding Tangent|keeping Tangent running/);
    expect(html).toContain('before later learners that day get to use it');
    expect(html).not.toContain('the people who funded it');
    expect(html).toContain("can't start a new reply");
    expect(html).toContain('The community pool is empty until Tangent adds more credit.');
    expect(html).toContain('you can buy credit for yourself or use your own OpenRouter key.');
    expect(html).toContain('The pool is covered by the <a href="/terms">terms of service</a>');
    expect(html).not.toMatch(
      /anyone can add|fund the pool|Funding is a purchase|people fund it|A pool purchase|smallest pool purchase|credit for the pool instead|opens soon|% markup/i,
    );
    const sold = await (
      await visitor(poolEnv(uniq('pool'), { ANNUAL_FEE_ENABLED: 'true' }))('/pool')
    ).text();
    expect(sold).toContain('Anyone with a Tangent membership (yearly) is a member');
    expect(sold).toContain('Part of every membership payment goes into the pool.');
  });

  it('names the operator’s contact for questions or arrangements, and sells nothing', async () => {
    const e = poolEnv(uniq('pool'), {
      LEGAL_OPERATOR: 'Example Learning LLC',
      LEGAL_CONTACT_EMAIL: 'hello@example.com',
    });
    const html = await (await visitor(e)('/pool')).text();
    expect(html).toContain(
      'For questions about the pool, or to arrange something with Example Learning LLC directly, email <a href="mailto:hello@example.com">hello@example.com</a>.',
    );
    expect(html).not.toMatch(/buy (pool )?access|sell/i);
  });

  it('shows what the revenue share added this week and month', async () => {
    const poolId = uniq('pool');
    const now = new Date();
    await env.DB.prepare(
      `INSERT INTO credit_grants (id, account_id, kind, amount_micros, provider_ref, created_at)
       VALUES (?1, ?2, 'contribution', 1840000, ?3, ?4), (?5, ?2, 'adjustment', 5000000, ?6, ?4)`,
    )
      .bind(uniq('g'), poolId, uniq('ref'), now.toISOString(), uniq('g'), uniq('ref'))
      .run();
    const html = await (await visitor(poolEnv(poolId))('/pool')).text();
    // Admin top-ups aren't part of the revenue share.
    expect(html).toContain(
      'So far the revenue share has added $1.84 to the pool this week (since Monday, UTC) and $1.84 this month.',
    );
    const off = await (
      await visitor(poolEnv(poolId, { POOL_REVENUE_SHARE_BPS: '0' }))('/pool')
    ).text();
    expect(off).not.toContain('revenue share has added');
  });

  it('the terms: an operator-provided pool funded from revenue, not for sale; refunds as Polar allows', async () => {
    const html = await (await visitor(poolEnv(uniq('pool')))('/terms')).text();
    expect(html).toContain(
      "is free credit we provide, at our discretion, that any signed-in learner may use within its limits. We fund it from our own revenue, as described on the pool page; pool credit isn't for sale.",
    );
    expect(html).toContain('or end it, and it may be empty.');
    expect(html).toContain(
      "It has no cash value and can't be transferred, to another account or to the community pool.",
    );
    expect(html).toContain(
      "not refundable, except where the law requires it or under Polar's terms for buyers: as merchant of record, Polar may refund a purchase",
    );
    expect(html).not.toMatch(
      /pool credit purchases|buy credit for the pool instead|a purchase like any other/,
    );
  });

  it('is linked from the landing page and the legal pages', async () => {
    const e = poolEnv(uniq('pool'));
    for (const path of ['/welcome', '/terms', '/privacy'])
      expect(await (await visitor(e)(path)).text()).toContain('<a href="/pool">Community pool</a>');
  });
});

describe('copy rule', () => {
  it('no public page calls the pool a donation, or offers to sell pool credit', async () => {
    const poolId = uniq('pool');
    await fundPool(poolId, 1_000_000);
    const e = poolEnv(poolId);
    for (const path of ['/welcome', '/pool', '/terms', '/privacy', '/api/pool/status']) {
      const text = await (await visitor(e)(path)).text();
      expect(text, path).not.toMatch(FORBIDDEN_POOL_COPY);
      expect(text, path).not.toMatch(/buy(ing)? (pool )?credit for the pool|fund(ing)? the pool/i);
    }
  });
});
