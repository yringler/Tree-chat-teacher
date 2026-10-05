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

/** An env (auth configured) whose pool is `poolId`. */
function poolEnv(poolId: string, overrides: Partial<AppEnv> = {}): AppEnv {
  return authEnv({ POOL_ACCOUNT_ID: poolId, ...overrides });
}

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
     VALUES (?, ?, 'pool', ?, ?, 'tangent', 'simple', 'settled', 5000, 0, 0, ?, ?, ?)`,
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
      // vitest.config.ts configures the fake payment provider, which sells credit.
      fundingOpen: true,
      availableMicros: 1_000_000,
      sessionsRemaining: Math.floor(1_000_000 / config.pool.sessionEstimateMicros),
      model: { id: 'simple', label: expect.any(String) },
      week: { start: weekStart(new Date()).toISOString(), exchanges: 0, learners: 0 },
      markupBps: config.pool.markupBps,
      minPurchaseCents: config.pool.minPurchaseCents,
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

  it('says funding is not open yet without payments', async () => {
    const status = await poolStatus(poolEnv(uniq('pool'), { PAYMENT_PROVIDER: 'polar' }));
    expect(status).toMatchObject({ enabled: true, fundingOpen: false });
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
      supporter: false,
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
  it('shows about N learning sessions, the dollars, this week and how to fund it', async () => {
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
    expect(html).toContain('1 learner helped this week · 1 exchange funded this week');
    expect(html).toContain(
      '<a class="btn primary" href="/learn/billing#fund-pool">Fund the pool</a>',
    );
    expect(html).toContain('<a class="btn" href="/pool">How the pool works</a>');
    expect(html).toContain('A pool purchase adds what you paid minus the card processing fee.');
    expect(html).toMatch(/plus a 5% markup/);
    expect(html).not.toContain('÷');
    // Pool purchases are open (the fake provider, POOL_PURCHASES_ENABLED on): buyers fund it.
    expect(html).toContain('Credit anyone can add and any signed-in learner can use in Learn');
    expect(html).toContain('Or learn on the community pool, funded by people who add credit to it');
    // Still one hashed stylesheet and no script.
    expect([...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1])).toEqual([
      LANDING_STYLE,
    ]);
    expect(html).not.toContain('<script');
  });

  it('shows the empty state; while purchases are open, people refill it', async () => {
    const html = await (await visitor(poolEnv(uniq('pool')))('/welcome')).text();
    expect(html).toContain('The community pool is empty. It refills as people fund it.');
  });

  for (const [why, overrides] of [
    ['before payments are set up', { PAYMENT_PROVIDER: 'polar' }],
    ['while pool purchases are off', { POOL_PURCHASES_ENABLED: 'false' }],
  ] as const)
    it(`says Tangent adds the credit and offers nothing to buy ${why}`, async () => {
      const html = await (await visitor(poolEnv(uniq('pool'), overrides))('/welcome')).text();
      expect(html).toContain('The community pool is empty until Tangent adds more credit.');
      expect(html).toContain('Credit Tangent adds and any signed-in learner can use in Learn');
      expect(html).toContain(
        'Or learn on the community pool, free within daily limits, on credit Tangent adds',
      );
      expect(html).toContain("Buying credit for the pool isn't available yet.");
      expect(html).not.toContain('Fund the pool');
      expect(html).not.toContain('opens soon');
      expect(html).not.toMatch(/anyone can add|funded by people|people fund it|Funding the pool/i);
      expect(html).toContain('<a class="btn" href="/pool">How the pool works</a>');
    });

  it('is left out while the pool is off, or when it can’t be read', async () => {
    const off = await (
      await visitor(poolEnv(uniq('pool'), { POOL_ENABLED: 'false' }))('/welcome')
    ).text();
    expect(off).not.toContain('The community pool');
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

  it('states this deployment’s model, markup, minimum, caps and supporter rule', async () => {
    const e = poolEnv(uniq('pool'), { POOL_FREE_REQUESTS_PER_DAY: '30' });
    const html = await (await visitor(e)('/pool')).text();
    expect(html).toContain('<code>simple</code>');
    expect(html).toContain('A pool purchase adds what you paid minus the card processing fee.');
    expect(html).toMatch(/plus a 5% markup/);
    expect(html).not.toContain('÷');
    expect(html).toContain('The smallest pool purchase is $10');
    expect(html).toContain('<td>Replies per learner per day</td><td>30 (supporters: 6)</td>');
    expect(html).toContain('add up to more than $0, after refunds, is a supporter.');
    expect(html).toContain(
      'Credit bought for your own account counts the same as credit bought for the pool.',
    );
    expect(html).not.toMatch(/thank-you|funding Tangent|keeping Tangent running/);
    expect(html).toContain('before later learners that day get to use it');
    expect(html).not.toContain('the people who funded it');
    expect(html).toContain("can't start a new reply");
    const windowed = await (
      await visitor(poolEnv(uniq('pool'), { SUPPORTER_WINDOW_MONTHS: '12' }))('/pool')
    ).text();
    expect(windowed).toContain('is a supporter for 12 months after their latest purchase');
  });

  it('while purchases are open: the buyer adds credit, provider-neutral, priced net of the fee', async () => {
    const e = poolEnv(uniq('pool'));
    const html = await (await visitor(e)('/pool')).text();
    expect(html).toContain(
      'The community pool is credit that anyone can add to and any signed-in learner can use in Tangent Learn, on one economical model, within daily limits. Adding to it is a credit purchase: you choose the pool instead of your own account.',
    );
    // The seller is whoever the terms name (a merchant of record), not the operator.
    expect(html).not.toContain(`credit purchase from`);
    expect(html).toContain('<li>Anyone can fund the pool from the billing page in Tangent.');
    expect(html).toContain('The community pool is empty. It refills as people fund it.');
    expect(html).toContain(
      'you can fund the pool, buy credit for yourself, or use your own OpenRouter key.',
    );
    expect(html).toContain('<h2>What a purchase adds, and what a reply costs</h2>');
    expect(html).toContain("plus a 5% markup, which is Tangent's margin.");
    expect(html).toContain('Pool purchases follow the <a href="/terms">terms of service</a>');
  });

  it('while purchases are closed: Tangent adds the credit, and nothing is for sale', async () => {
    const e = poolEnv(uniq('pool'), { POOL_PURCHASES_ENABLED: 'false' });
    const html = await (await visitor(e)('/pool')).text();
    expect(html).toContain(
      "<strong>The short version.</strong> The community pool is credit Tangent adds so that any signed-in learner can use Tangent Learn, on one economical model, within daily limits. Buying credit for the pool isn't available yet.</p>",
    );
    expect(html).toContain(
      "<li>Tangent adds the pool's credit. Buying credit for the pool isn't available yet.</li>",
    );
    expect(html).toContain('The community pool is empty until Tangent adds more credit.');
    expect(html).toContain('you can buy credit for yourself or use your own OpenRouter key.');
    expect(html).toContain('<h2>What a reply costs</h2>');
    expect(html).toContain('It costs the learner nothing.');
    expect(html).toContain('Buying credit for your own account is enough.');
    expect(html).toContain('The pool is covered by the <a href="/terms">terms of service</a>');
    expect(html).not.toMatch(
      /anyone can add|fund the pool|Funding is a purchase|people fund it|A pool purchase adds|smallest pool purchase|for the pool\.|opens soon/i,
    );
  });

  it('the terms describe pool purchases only as something that may be offered', async () => {
    const html = await (await visitor(poolEnv(uniq('pool')))('/terms')).text();
    expect(html).toContain('We add credit to it at our discretion.');
    expect(html).toContain(
      'When pool credit purchases are offered, you can also buy credit for the pool instead of your own account',
    );
    expect(html).not.toContain('a purchase like any other');
  });

  it('is linked from the landing page and the legal pages', async () => {
    const e = poolEnv(uniq('pool'));
    for (const path of ['/welcome', '/terms', '/privacy'])
      expect(await (await visitor(e)(path)).text()).toContain('<a href="/pool">Community pool</a>');
  });
});

describe('copy rule', () => {
  it('no public page calls funding the pool a donation', async () => {
    const poolId = uniq('pool');
    await fundPool(poolId, 1_000_000);
    const e = poolEnv(poolId);
    for (const path of ['/welcome', '/pool', '/terms', '/privacy', '/api/pool/status']) {
      const text = await (await visitor(e)(path)).text();
      expect(text, path).not.toMatch(FORBIDDEN_POOL_COPY);
    }
  });
});
