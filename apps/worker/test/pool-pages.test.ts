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
      // vitest.config.ts configures Stripe and its credits product.
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

  it('says funding is not open yet without Stripe', async () => {
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
    // Still one hashed stylesheet and no script.
    expect([...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1])).toEqual([
      LANDING_STYLE,
    ]);
    expect(html).not.toContain('<script');
  });

  it('shows the empty state, and "Funding opens soon" before Stripe is set up', async () => {
    const poolId = uniq('pool');
    const html = await (
      await visitor(poolEnv(poolId, { PAYMENT_PROVIDER: 'polar' }))('/welcome')
    ).text();
    expect(html).toContain('The community pool is empty. It refills as people fund it.');
    expect(html).toContain('Funding opens soon');
    expect(html).not.toContain('Fund the pool</a>');
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
    expect(html).toContain("can't start a new reply");
    const windowed = await (
      await visitor(poolEnv(uniq('pool'), { SUPPORTER_WINDOW_MONTHS: '12' }))('/pool')
    ).text();
    expect(windowed).toContain('is a supporter for 12 months after their latest purchase');
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
