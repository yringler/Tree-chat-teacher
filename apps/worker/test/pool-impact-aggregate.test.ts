// The community pool's weekly impact snapshot, its review queue and the
// public feed (docs/pool/PLAN.md §S8b; spec §9 "Weekly aggregation",
// "Moderation" and "UI").
//
// Rows are written straight into usage_events and pool_topic_tags, as the
// pool's meter and pool/tagging.ts write them, for weeks long past: each test
// takes the next week (`nextWeek`), so snapshots (one per week) never collide.
// Review decisions are per topic and global, so each test uses its own topics.
// The tests run in order: the first checks the pages with no snapshot at all.
import {
  FORBIDDEN_POOL_COPY,
  type AdminPoolTopic,
  type AdminPoolTopicsResponse,
  type ApiError,
  type MeResponse,
  type PoolImpactResponse,
  type PoolImpactWeeksResponse,
} from '@tangent/shared';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { CRON_DAILY, CRON_FREQUENT, CRON_WEEKLY, cronTasks, type CronJobs } from '../src/cron.js';
import type { AppEnv } from '../src/env.js';
import { LANDING_STYLE } from '../src/http/landing.js';
import { aggregatePoolImpact, isBlocklisted, previousWeek, weekKey } from '../src/pool/impact.js';
import { SENSITIVE_TOPIC_ID } from '../src/pool/taxonomy.js';
import worker from '../src/index.js';
import { envWithFailingDb, uniq } from './mocks/billing-helpers.js';
import { fundPool } from './pool-helpers.js';
import { authEnv, client, ORIGIN } from './session-client.js';

const env = rawEnv as unknown as AppEnv;

const DAY = 24 * 60 * 60_000;
/** The Monday of the first test week (UTC). */
const FIRST_MONDAY = Date.UTC(2021, 0, 4);
let weekSeq = 0;

/** A fresh past week: its start, a time inside it, and when its Monday cron runs. */
function nextWeek() {
  const start = FIRST_MONDAY + weekSeq++ * 7 * DAY;
  return weekAt(start);
}

function weekAt(start: number) {
  return {
    key: weekKey(new Date(start)),
    /** Tuesday noon of the week. */
    during: (offsetMs = 0) => new Date(start + DAY + 12 * 60 * 60_000 + offsetMs).toISOString(),
    /** The Monday cron after the week: 04:17 UTC. */
    cron: new Date(start + 7 * DAY + (4 * 60 + 17) * 60_000),
  };
}
type Week = ReturnType<typeof weekAt>;

interface ReplyOpts {
  charge?: number;
  funding?: 'pool' | 'personal';
  purpose?: string;
  status?: 'settled' | 'pending';
  reason?: string;
  accountId?: string;
}

/** A usage row of `userId` on `branchId`, by default a funded pool reply. */
function replyStatement(
  poolId: string,
  userId: string,
  branchId: string,
  createdAt: string,
  opts: ReplyOpts = {},
): D1PreparedStatement {
  const charge = opts.charge ?? 1_500;
  return env.DB.prepare(
    `INSERT INTO usage_events (id, account_id, funding, user_id, branch_id, purpose, provider_id,
       model, status, hold_micros, markup_bps, fee_bps, charge_micros, settle_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'openrouter', 'simple', ?, 5000, 0, 0, ?, ?, ?)`,
  ).bind(
    uniq('use'),
    opts.accountId ?? poolId,
    opts.funding ?? 'pool',
    userId,
    branchId,
    opts.purpose ?? 'reply',
    opts.status ?? 'settled',
    opts.status === 'pending' ? null : charge,
    opts.status === 'pending' ? null : (opts.reason ?? (charge > 0 ? 'cost' : 'released')),
    createdAt,
  );
}

function tagStatement(
  branchId: string,
  topicId: string,
  depth: number,
  createdAt: string,
): D1PreparedStatement {
  return env.DB.prepare(
    'INSERT INTO pool_topic_tags (branch_id, topic_id, branch_depth, created_at) VALUES (?, ?, ?, ?)',
  ).bind(branchId, topicId, depth, createdAt);
}

/**
 * `learners` distinct users, each on a branch of their own tagged `topicId` at
 * `depth`, each with `perUser` pool replies there during `week`. Returns the
 * users and branches.
 */
async function learnersOn(
  poolId: string,
  week: Week,
  topicId: string,
  learners: number,
  opts: { depth?: number; perUser?: number; users?: string[] } = {},
): Promise<{ users: string[]; branches: string[] }> {
  const users = opts.users ?? Array.from({ length: learners }, () => uniq('user'));
  const branches: string[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const user of users) {
    const branch = uniq('branch');
    branches.push(branch);
    statements.push(tagStatement(branch, topicId, opts.depth ?? 1, week.during()));
    for (let i = 0; i < (opts.perUser ?? 1); i++)
      statements.push(replyStatement(poolId, user, branch, week.during(i * 1000)));
  }
  await env.DB.batch(statements);
  return { users, branches };
}

async function setReview(topicId: string, status: 'approved' | 'rejected' | 'pending') {
  await env.DB.prepare(
    `INSERT INTO pool_topic_reviews (topic_id, status, first_seen_week) VALUES (?, ?, '2020-01-06')
     ON CONFLICT(topic_id) DO UPDATE SET status = excluded.status`,
  )
    .bind(topicId, status)
    .run();
}

async function reviewOf(topicId: string) {
  return env.DB.prepare('SELECT status, first_seen_week FROM pool_topic_reviews WHERE topic_id = ?')
    .bind(topicId)
    .first<{ status: string; first_seen_week: string }>();
}

/** A request without a session, as a visitor's browser sends it. */
function visitor(e: AppEnv = env) {
  const app = createApp();
  return (path: string) => app.request(`${ORIGIN}${path}`, {}, e);
}

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function impactOf(week: string): Promise<PoolImpactResponse> {
  return json<PoolImpactResponse>(await visitor()(`/api/pool/impact?week=${week}`));
}

/** A signed-in admin (ADMIN_USER_IDS lists them in the env every call passes). */
async function signedInAdmin(overrides: Partial<AppEnv> = {}) {
  const c = client(authEnv(overrides));
  await c.signIn(`admin-${Math.random().toString(36).slice(2, 8)}@example.org`);
  const me = await json<MeResponse>(await c.call('/api/me'));
  const e = authEnv({ ADMIN_USER_IDS: me.userId!, ...overrides });
  return (path: string, init: Parameters<typeof c.call>[1] = {}) => c.call(path, init, e);
}

describe('the public feed with no snapshot yet', () => {
  it('404s, lists no weeks, and the pages render without it', async () => {
    const res = await visitor()('/api/pool/impact');
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiError).error.code).toBe('not_found');
    expect(await json<PoolImpactWeeksResponse>(await visitor()('/api/pool/impact/weeks'))).toEqual({
      weeks: [],
    });

    const poolId = uniq('pool');
    await fundPool(poolId, 1_000_000);
    const e = authEnv({ POOL_ACCOUNT_ID: poolId });
    const landing = await (await visitor(e)('/welcome')).text();
    expect(landing).toContain('learning sessions left');
    expect(landing).not.toContain('class="impact"');
    const page = await (await visitor(e)('/pool')).text();
    expect(page).toContain('<h2 id="impact">What the pool is funding</h2>');
    expect(page).toContain('The first weekly snapshot appears');
    expect(page).not.toContain('class="impact"');
    expect(page).not.toContain('Past weeks');
  });
});

describe('aggregatePoolImpact: the crowd-size threshold (spec test)', () => {
  it('never names a topic with fewer distinct learners than IMPACT_MIN_DISTINCT_USERS', async () => {
    const poolId = uniq('pool');
    const topic = 'history.ancient-rome';
    await setReview(topic, 'approved');

    // 4 learners, one of them on 10 exchanges: still 4 learners.
    const w1 = nextWeek();
    const { users } = await learnersOn(poolId, w1, topic, 3);
    await learnersOn(poolId, w1, topic, 1, { perUser: 10 });
    const run1 = await aggregatePoolImpact(env, w1.cron, poolId);
    expect(run1).toMatchObject({ week: w1.key, outcome: 'created', named: [], queued: [] });
    const s1 = await impactOf(w1.key);
    expect(s1).toMatchObject({ exchanges: 13, learners: 4, topics: 1, named: [], deepest: null });

    // A fifth learner names it.
    const w2 = nextWeek();
    await learnersOn(poolId, w2, topic, 5, { users: [...users, uniq('user'), uniq('user')] });
    expect((await aggregatePoolImpact(env, w2.cron, poolId)).named).toEqual([topic]);
    const s2 = await impactOf(w2.key);
    expect(s2.named).toEqual([
      { id: topic, label: 'Ancient Rome', learners: 5, exchanges: 5, avgDepth: 1 },
    ]);
  });

  it('a raised threshold applies; it never drops below 3', async () => {
    const poolId = uniq('pool');
    const topic = 'history.ancient-greece';
    await setReview(topic, 'approved');
    const w = nextWeek();
    await learnersOn(poolId, w, topic, 5);
    const run = await aggregatePoolImpact(
      authEnv({ IMPACT_MIN_DISTINCT_USERS: '6' }),
      w.cron,
      poolId,
    );
    expect(run.named).toEqual([]);

    const w2 = nextWeek();
    await learnersOn(poolId, w2, topic, 2);
    const low = await aggregatePoolImpact(
      authEnv({ IMPACT_MIN_DISTINCT_USERS: '1' }),
      w2.cron,
      poolId,
    );
    expect(low.named).toEqual([]);
  });

  it('never rolls children up: a parent is not named because of its leaves', async () => {
    const poolId = uniq('pool');
    for (const id of ['science', 'science.physics', 'science.chemistry'])
      await setReview(id, 'approved');
    const w = nextWeek();
    await learnersOn(poolId, w, 'science.physics', 4);
    await learnersOn(poolId, w, 'science.chemistry', 4);
    const run = await aggregatePoolImpact(env, w.cron, poolId);
    expect(run).toMatchObject({ named: [], queued: [] });
    const s = await impactOf(w.key);
    expect(s).toMatchObject({ learners: 8, topics: 2, named: [] });
    expect(JSON.stringify(s)).not.toContain('"science"');
  });
});

describe('aggregatePoolImpact: sensitive topics (spec test)', () => {
  it('are counted in the totals but never named, queued or the deepest', async () => {
    const poolId = uniq('pool');
    const w = nextWeek();
    await learnersOn(poolId, w, SENSITIVE_TOPIC_ID, 50, { depth: 9 });
    // Only the sentinel is ever stored, but a specific sensitive id is refused all the same.
    await setReview('health.conditions', 'approved');
    await learnersOn(poolId, w, 'health.conditions', 50, { depth: 9 });
    await setReview('math.geometry', 'approved');
    await learnersOn(poolId, w, 'math.geometry', 5, { depth: 2 });

    const run = await aggregatePoolImpact(env, w.cron, poolId);
    expect(run.named).toEqual(['math.geometry']);
    expect(run.queued).toEqual([]);
    expect(await reviewOf(SENSITIVE_TOPIC_ID)).toBeNull();
    const s = await impactOf(w.key);
    expect(s).toMatchObject({ exchanges: 105, learners: 105, topics: 3, maxDepth: 9 });
    expect(s.named.map((t) => t.id)).toEqual(['math.geometry']);
    expect(s.deepest).toEqual({ id: 'math.geometry', label: 'Geometry', avgDepth: 2 });
    expect(JSON.stringify(s)).not.toMatch(/sensitive|health/i);
  });
});

describe('aggregatePoolImpact: the review queue (spec test)', () => {
  it('queues a new topic instead of naming it, publishes it the week after approval, never a rejected one', async () => {
    const asAdmin = await signedInAdmin();
    const poolId = uniq('pool');
    const fresh = 'computing.programming';
    const rejected = 'arts.music';

    const w1 = nextWeek();
    await learnersOn(poolId, w1, fresh, 5, { depth: 3 });
    await learnersOn(poolId, w1, rejected, 6);
    const run1 = await aggregatePoolImpact(env, w1.cron, poolId);
    expect(run1.named).toEqual([]);
    expect(run1.queued.sort()).toEqual([rejected, fresh].sort());
    expect((await impactOf(w1.key)).named).toEqual([]);
    expect(await reviewOf(fresh)).toEqual({ status: 'pending', first_seen_week: w1.key });

    // The queue, oldest first, for the admin.
    const queue = await json<AdminPoolTopicsResponse>(await asAdmin('/api/admin/pool/topics'));
    expect(queue.topics.filter((t) => t.firstSeenWeek === w1.key)).toEqual([
      expect.objectContaining({ id: rejected, label: 'Music', group: 'Arts', status: 'pending' }),
      expect.objectContaining({
        id: fresh,
        status: 'pending',
        decidedAt: null,
        decidedBy: null,
        blocklisted: false,
      }),
    ]);

    // Still pending a week later: still not published, and not queued twice.
    const w2 = nextWeek();
    await learnersOn(poolId, w2, fresh, 5);
    const run2 = await aggregatePoolImpact(env, w2.cron, poolId);
    expect(run2).toMatchObject({ named: [], queued: [] });
    expect(await reviewOf(fresh)).toEqual({ status: 'pending', first_seen_week: w1.key });

    const approved = await json<AdminPoolTopic>(
      await asAdmin(`/api/admin/pool/topics/${fresh}`, {
        method: 'POST',
        json: { decision: 'approved' },
      }),
    );
    expect(approved).toMatchObject({ id: fresh, status: 'approved' });
    expect(approved.decidedAt).not.toBeNull();
    expect(approved.decidedBy).not.toBeNull();
    await json(
      await asAdmin(`/api/admin/pool/topics/${rejected}`, {
        method: 'POST',
        json: { decision: 'rejected' },
      }),
    );
    // Snapshots are immutable: approval doesn't rewrite the past.
    expect((await impactOf(w2.key)).named).toEqual([]);

    // Published automatically from the next week on; the rejected topic never.
    for (const w of [nextWeek(), nextWeek()]) {
      await learnersOn(poolId, w, fresh, 5, { depth: 3 });
      await learnersOn(poolId, w, rejected, 9);
      const run = await aggregatePoolImpact(env, w.cron, poolId);
      expect(run).toMatchObject({ named: [fresh], queued: [] });
      const s = await impactOf(w.key);
      expect(s.named.map((t) => t.id)).toEqual([fresh]);
      expect(s.deepest).toEqual({ id: fresh, label: 'Programming', avgDepth: 3 });
    }
    const rejectedList = await json<AdminPoolTopicsResponse>(
      await asAdmin('/api/admin/pool/topics?status=rejected'),
    );
    expect(rejectedList.topics.map((t) => t.id)).toContain(rejected);
  });

  it('never queues or names a blocklisted topic (or a leaf of a blocklisted root)', async () => {
    const poolId = uniq('pool');
    const e = authEnv({ POOL_TOPIC_BLOCKLIST: 'games.chess, languages' });
    expect(isBlocklisted('languages.spanish', ['languages'])).toBe(true);
    await setReview('games.chess', 'approved');
    const w = nextWeek();
    await learnersOn(poolId, w, 'games.chess', 8);
    await learnersOn(poolId, w, 'languages.spanish', 8);
    await learnersOn(poolId, w, 'games.sports', 8);
    const run = await aggregatePoolImpact(e, w.cron, poolId);
    expect(run.named).toEqual([]);
    expect(run.queued).toEqual(['games.sports']);
    expect(await reviewOf('languages.spanish')).toBeNull();
    const s = await impactOf(w.key);
    expect(s).toMatchObject({ learners: 24, topics: 3, named: [] });
  });

  it('the review routes are admins only, validated, same-origin and 404 for unqueued topics', async () => {
    const asAdmin = await signedInAdmin();
    const user = client(authEnv());
    await user.signIn(`plain-${Math.random().toString(36).slice(2, 8)}@example.org`);
    expect((await user.call('/api/admin/pool/topics')).status).toBe(404);
    expect(
      (
        await user.call('/api/admin/pool/topics/arts.music', {
          method: 'POST',
          json: { decision: 'approved' },
        })
      ).status,
    ).toBe(404);
    expect((await asAdmin('/api/admin/pool/topics?status=maybe')).status).toBe(400);
    const decide = (id: string, body: unknown, headers: HeadersInit = {}) =>
      asAdmin(`/api/admin/pool/topics/${id}`, { method: 'POST', json: body, headers });
    expect((await decide('arts.music', { decision: 'maybe' })).status).toBe(400);
    expect((await decide('history.medieval', { decision: 'approved' })).status).toBe(404);
    expect((await decide(SENSITIVE_TOPIC_ID, { decision: 'approved' })).status).toBe(404);
    expect(
      (await decide('arts.music', { decision: 'approved' }, { 'Sec-Fetch-Site': 'cross-site' }))
        .status,
    ).toBe(403);
  });
});

describe('aggregatePoolImpact: what counts', () => {
  it('only funded pool replies of the week, of this pool', async () => {
    const poolId = uniq('pool');
    const topic = 'math.calculus';
    await setReview(topic, 'approved');
    const w = nextWeek();
    const { users, branches } = await learnersOn(poolId, w, topic, 5);
    const [user, branch] = [users[0]!, branches[0]!];
    const other = uniq('user');
    await env.DB.batch([
      // A mixed branch: the same branch's personal exchanges don't count.
      replyStatement(poolId, other, branch, w.during(), {
        funding: 'personal',
        accountId: `u_${other}`,
      }),
      // Not replies, or not funded: summaries, titles, tagging, released, settled at 0, pending.
      replyStatement(poolId, other, branch, w.during(), { purpose: 'summary' }),
      replyStatement(poolId, other, branch, w.during(), { purpose: 'title' }),
      replyStatement(poolId, other, branch, w.during(), { purpose: 'tagging' }),
      replyStatement(poolId, other, branch, w.during(), { charge: 0, reason: 'released' }),
      replyStatement(poolId, other, branch, w.during(), { charge: 0, reason: 'cost' }),
      replyStatement(poolId, other, branch, w.during(), { status: 'pending' }),
      // Another pool, the week before and the week after.
      replyStatement(uniq('pool'), other, branch, w.during()),
      replyStatement(poolId, other, branch, w.during(-7 * DAY)),
      replyStatement(poolId, other, branch, w.during(7 * DAY)),
      // An untagged exchange counts in the totals only.
      replyStatement(poolId, user, uniq('branch'), w.during()),
    ]);
    await aggregatePoolImpact(env, w.cron, poolId);
    const s = await impactOf(w.key);
    expect(s).toMatchObject({ exchanges: 6, learners: 5, topics: 1 });
    expect(s.named).toEqual([expect.objectContaining({ id: topic, learners: 5, exchanges: 5 })]);
  });

  it('a tree deleted mid-week still counts in its topic (tags and usage outlive the tree)', async () => {
    const poolId = uniq('pool');
    const topic = 'math.statistics';
    await setReview(topic, 'approved');
    const w = nextWeek();
    // No `branches`, `nodes` or `trees` rows exist for these branch ids: as after deletion.
    const { branches } = await learnersOn(poolId, w, topic, 5);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM branches WHERE id = ?')
      .bind(branches[0]!)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
    expect((await aggregatePoolImpact(env, w.cron, poolId)).named).toEqual([topic]);
  });

  it('averages depth per exchange and picks the deepest named topic', async () => {
    const poolId = uniq('pool');
    for (const id of ['science.astronomy', 'science.biology']) await setReview(id, 'approved');
    const w = nextWeek();
    await learnersOn(poolId, w, 'science.astronomy', 5, { depth: 1 });
    await learnersOn(poolId, w, 'science.astronomy', 1, { depth: 4, perUser: 4 });
    await learnersOn(poolId, w, 'science.biology', 6, { depth: 2 });
    await aggregatePoolImpact(env, w.cron, poolId);
    const s = await impactOf(w.key);
    // Astronomy: (5 × 1 + 4 × 4) / 9 = 2.333; biology 2.
    expect(s.named.map((t) => [t.id, t.learners, t.exchanges, t.avgDepth])).toEqual([
      ['science.astronomy', 6, 9, 2.333],
      ['science.biology', 6, 6, 2],
    ]);
    expect(s.deepest?.id).toBe('science.astronomy');
    expect(s).toMatchObject({ exchanges: 15, learners: 12, maxDepth: 4 });
    expect(s.avgDepth).toBeCloseTo(33 / 15, 3);
  });

  it('writes many named topics in chunks under D1’s parameter limit', async () => {
    const poolId = uniq('pool');
    const topics = [
      'arts.visual-arts',
      'arts.architecture',
      'arts.film',
      'arts.design',
      'history.modern-europe',
      'history.americas',
      'history.asia',
      'history.africa',
      'history.world-wars',
      'history.jewish',
      'history.early-modern',
      'history.ancient-egypt',
      'history.ancient-near-east',
      'science.genetics',
      'science.earth-science',
      'science.ecology',
      'science.organic-chemistry',
      'math.arithmetic',
      'math.linear-algebra',
      'math.number-theory',
      'math.logic',
      'games.board-games',
    ];
    const w = nextWeek();
    for (const t of topics) {
      await setReview(t, 'approved');
      await learnersOn(poolId, w, t, 5);
    }
    const run = await aggregatePoolImpact(env, w.cron, poolId);
    expect(run.named.sort()).toEqual([...topics].sort());
    expect((await impactOf(w.key)).named).toHaveLength(topics.length);
  });
});

describe('aggregatePoolImpact: idempotence and tag retention', () => {
  it('a re-run of a week is a no-op', async () => {
    const poolId = uniq('pool');
    const topic = 'math.algebra';
    await setReview(topic, 'approved');
    const w = nextWeek();
    await learnersOn(poolId, w, topic, 5);
    expect((await aggregatePoolImpact(env, w.cron, poolId)).outcome).toBe('created');
    const before = await impactOf(w.key);
    await learnersOn(poolId, w, topic, 7);
    const again = await aggregatePoolImpact(env, new Date(w.cron.getTime() + 60 * 60_000), poolId);
    expect(again).toMatchObject({ week: w.key, outcome: 'exists', named: [], queued: [] });
    expect(await impactOf(w.key)).toEqual(before);
  });

  it('deletes tags whose branch had no pool reply in IMPACT_TAG_RETENTION_DAYS', async () => {
    const poolId = uniq('pool');
    const w = nextWeek();
    const old = w.during(-20 * DAY);
    const [stale, personalOnly, usedAgain] = [uniq('branch'), uniq('branch'), uniq('branch')];
    const user = uniq('user');
    await env.DB.batch([
      tagStatement(stale, 'literature.fiction', 0, old),
      replyStatement(poolId, user, stale, old),
      tagStatement(personalOnly, 'literature.fiction', 0, old),
      replyStatement(poolId, user, personalOnly, old),
      replyStatement(poolId, user, personalOnly, w.during(), {
        funding: 'personal',
        accountId: `u_${user}`,
      }),
      tagStatement(usedAgain, 'literature.fiction', 0, old),
      replyStatement(poolId, user, usedAgain, old),
      replyStatement(poolId, user, usedAgain, w.during()),
    ]);
    const run = await aggregatePoolImpact(env, w.cron, poolId);
    expect(run.tagsDeleted).toBeGreaterThanOrEqual(2);
    const { results } = await env.DB.prepare(
      'SELECT branch_id FROM pool_topic_tags WHERE branch_id IN (?, ?, ?)',
    )
      .bind(stale, personalOnly, usedAgain)
      .all<{ branch_id: string }>();
    expect(results.map((r) => r.branch_id)).toEqual([usedAgain]);
  });
});

describe('aggregatePoolImpact: a week without funded exchanges', () => {
  it('publishes nothing, and a zero snapshot stored earlier is never served', async () => {
    const poolId = uniq('pool');
    const w = nextWeek();
    const run = await aggregatePoolImpact(env, w.cron, poolId);
    expect(run).toMatchObject({ week: w.key, outcome: 'no_exchanges', named: [], queued: [] });
    expect(
      await env.DB.prepare('SELECT 1 FROM pool_impact_snapshots WHERE week_start = ?')
        .bind(w.key)
        .first(),
    ).toBeNull();

    // A zero week written before this rule (e.g. right after launch) stays out of the feed.
    await env.DB.prepare(
      `INSERT INTO pool_impact_snapshots (week_start, exchanges, learners, topics,
         avg_depth_milli, max_depth, deepest_topic_id, created_at)
       VALUES (?, 0, 0, 0, 0, 0, NULL, ?)`,
    )
      .bind(w.key, new Date().toISOString())
      .run();
    expect((await visitor(authEnv())(`/api/pool/impact?week=${w.key}`)).status).toBe(404);
    const weeks = (await (await visitor(authEnv())('/api/pool/impact/weeks')).json()) as {
      weeks: string[];
    };
    expect(weeks.weeks).not.toContain(w.key);
  });
});

describe('aggregatePoolImpact: while the pool is off', () => {
  it('writes no snapshot (a pre-launch zero week is never published) but still expires tags', async () => {
    const poolId = uniq('pool');
    const w = nextWeek();
    await learnersOn(poolId, w, 'math.geometry', 3);
    const stale = uniq('branch');
    await env.DB.batch([tagStatement(stale, 'literature.fiction', 0, w.during(-20 * DAY))]);
    const off = { ...env, POOL_ENABLED: 'false' } as AppEnv;
    const run = await aggregatePoolImpact(off, w.cron, poolId);
    expect(run).toMatchObject({ week: w.key, outcome: 'pool_off', named: [], queued: [] });
    expect(run.tagsDeleted).toBeGreaterThanOrEqual(1);
    const row = await env.DB.prepare('SELECT 1 FROM pool_impact_snapshots WHERE week_start = ?')
      .bind(w.key)
      .first();
    expect(row).toBeNull();
    expect(
      await env.DB.prepare('SELECT 1 FROM pool_topic_tags WHERE branch_id = ?').bind(stale).first(),
    ).toBeNull();

    // The public routes answer 404 while off, even with snapshots stored.
    const offEnv = authEnv({ POOL_ENABLED: 'false' });
    expect((await visitor(offEnv)('/api/pool/impact')).status).toBe(404);
    expect((await visitor(offEnv)('/api/pool/impact/weeks')).status).toBe(404);

    // Turned on, the same week is written by the next run.
    expect((await aggregatePoolImpact(env, w.cron, poolId)).outcome).toBe('created');
  });
});

describe('the public feed', () => {
  it('serves past weeks by ?week=, the latest without, and lists the weeks newest first', async () => {
    const poolId = uniq('pool');
    const topic = 'computing.web-development';
    await setReview(topic, 'approved');
    const weeks = [nextWeek(), nextWeek()];
    const users: string[] = [];
    const branches: string[] = [];
    for (const [i, w] of weeks.entries()) {
      const made = await learnersOn(poolId, w, topic, 5 + i);
      users.push(...made.users);
      branches.push(...made.branches);
      await aggregatePoolImpact(env, w.cron, poolId);
    }
    const [first, last] = weeks as [Week, Week];
    expect((await impactOf(first.key)).learners).toBe(5);
    const latest = await json<PoolImpactResponse>(await visitor()('/api/pool/impact'));
    expect(latest).toMatchObject({ weekStart: last.key, learners: 6 });
    const res = await visitor()('/api/pool/impact');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');

    const listed = await json<PoolImpactWeeksResponse>(await visitor()('/api/pool/impact/weeks'));
    expect(listed.weeks.slice(0, 2)).toEqual([last.key, first.key]);
    expect(listed.weeks).toEqual([...listed.weeks].sort().reverse());

    expect((await visitor()('/api/pool/impact?week=2019-01-07')).status).toBe(404);
    expect((await visitor()('/api/pool/impact?week=last')).status).toBe(400);

    // Aggregates only: no user, branch or pool ids.
    const body = JSON.stringify(latest) + JSON.stringify(listed);
    for (const id of [...users, ...branches, poolId]) expect(body).not.toContain(id);
    expect(body).not.toMatch(FORBIDDEN_POOL_COPY);
  });

  it('is public: no session, and the same with auth configured', async () => {
    const res = await visitor(authEnv())('/api/pool/impact/weeks');
    expect(res.status).toBe(200);
  });

  it('/pool shows the latest snapshot, a week selector, and "No snapshot for that week"', async () => {
    const poolId = uniq('pool');
    const topic = 'computing.machine-learning';
    await setReview(topic, 'approved');
    const w = nextWeek();
    await learnersOn(poolId, w, topic, 7, { depth: 2 });
    await aggregatePoolImpact(env, w.cron, poolId);
    const weeks = (await json<PoolImpactWeeksResponse>(await visitor()('/api/pool/impact/weeks')))
      .weeks;

    const e = authEnv({ POOL_ACCOUNT_ID: poolId });
    const html = await (await visitor(e)('/pool')).text();
    const label = (key: string) => {
      const [y, m, d] = key.split('-').map(Number);
      const month = new Date(Date.UTC(y!, m! - 1, d!)).toLocaleString('en-US', {
        month: 'long',
        timeZone: 'UTC',
      });
      return `${d} ${month} ${y}`;
    };
    expect(html).toContain(`<h3>The week of ${label(w.key)}</h3>`);
    expect(html).toContain(
      `In the week of ${label(w.key)} the pool funded 7 exchanges for 7 learners across 1 topic.`,
    );
    expect(html).toContain('<li>Machine learning and AI: 7 learners</li>');
    expect(html).toContain('Learners went 2 branches deep on average');
    expect(html).toContain('<nav aria-label="Past weeks"><h3>Past weeks</h3>');
    for (const key of weeks) expect(html).toContain(`href="/pool?week=${key}#impact"`);
    expect(html).toContain(
      `<a href="/pool?week=${w.key}#impact" aria-current="page">Week of ${label(w.key)}</a>`,
    );
    expect(html).toContain('at least 5 different learners');
    expect(html).not.toMatch(FORBIDDEN_POOL_COPY);

    // An older week.
    const older = weeks[3]!;
    const past = await (await visitor(e)(`/pool?week=${older}`)).text();
    expect(past).toContain(`<h3>The week of ${label(older)}</h3>`);
    expect(past).toContain(`<a href="/pool?week=${older}#impact" aria-current="page">`);

    for (const bad of ['2019-01-07', 'nonsense']) {
      const missing = await (await visitor(e)(`/pool?week=${bad}`)).text();
      expect(missing).toContain('No snapshot for that week.');
      expect(missing).not.toContain('class="impact"');
      expect(missing).toContain('<nav aria-label="Past weeks">');
    }
  });

  it('the landing page shows the latest snapshot next to the meter', async () => {
    const poolId = uniq('pool');
    await fundPool(poolId, 1_000_000);
    const latest = await json<PoolImpactResponse>(await visitor()('/api/pool/impact'));
    const html = await (await visitor(authEnv({ POOL_ACCOUNT_ID: poolId }))('/welcome')).text();
    expect(html).toContain('<div class="impact">');
    expect(html).toContain(`the pool funded ${latest.exchanges} exchanges`);
    expect(html).toContain('<li>Machine learning and AI: 7 learners</li>');
    expect(html.indexOf('learning sessions left')).toBeLessThan(html.indexOf('class="impact"'));
    // Still one hashed stylesheet and no script.
    expect([...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1])).toEqual([
      LANDING_STYLE,
    ]);
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(FORBIDDEN_POOL_COPY);
  });

  it('the pages leave the feed out while the pool is off or the snapshot can’t be read', async () => {
    const poolId = uniq('pool');
    await fundPool(poolId, 1_000_000);
    const off = authEnv({ POOL_ACCOUNT_ID: poolId, POOL_ENABLED: 'false' });
    expect(await (await visitor(off)('/welcome')).text()).not.toContain('class="impact"');
    expect(await (await visitor(off)('/pool')).text()).not.toContain('Past weeks');

    const broken = envWithFailingDb(authEnv({ POOL_ACCOUNT_ID: poolId }), /pool_impact/);
    const landing = await visitor(broken)('/welcome');
    expect(landing.status).toBe(200);
    const html = await landing.text();
    expect(html).toContain('learning sessions left');
    expect(html).not.toContain('class="impact"');
    const page = await visitor(broken)('/pool');
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain('Past weeks');
  });
});

describe('cron dispatch', () => {
  function spies() {
    const jobs = {
      reconcile: vi.fn(() => Promise.resolve()),
      poolExpiry: vi.fn(() => Promise.resolve()),
      poolImpact: vi.fn(() => Promise.resolve()),
      paymentDisputes: vi.fn(() => Promise.resolve()),
      poolRevenueShare: vi.fn(() => Promise.resolve()),
      priceSync: vi.fn(() => Promise.resolve()),
    } satisfies CronJobs;
    return jobs;
  }

  it('runs each schedule’s own jobs only, and logs an unknown one', async () => {
    const now = new Date();
    const frequent = spies();
    await Promise.all(cronTasks(CRON_FREQUENT, env, now, frequent));
    expect(frequent.reconcile).toHaveBeenCalledOnce();
    expect(frequent.poolExpiry).toHaveBeenCalledWith(env, now);
    expect(frequent.paymentDisputes).toHaveBeenCalledWith(env, now);
    expect(frequent.poolRevenueShare).toHaveBeenCalledWith(env, now);
    expect(frequent.poolImpact).not.toHaveBeenCalled();

    const weekly = spies();
    await Promise.all(cronTasks(CRON_WEEKLY, env, now, weekly));
    expect(weekly.poolImpact).toHaveBeenCalledWith(env, now);
    expect(weekly.reconcile).not.toHaveBeenCalled();
    expect(weekly.poolExpiry).not.toHaveBeenCalled();
    expect(weekly.paymentDisputes).not.toHaveBeenCalled();
    expect(weekly.poolRevenueShare).not.toHaveBeenCalled();
    expect(weekly.priceSync).not.toHaveBeenCalled();
    expect(frequent.priceSync).not.toHaveBeenCalled();

    const daily = spies();
    await Promise.all(cronTasks(CRON_DAILY, env, now, daily));
    expect(daily.priceSync).toHaveBeenCalledWith(env, now);
    expect(daily.reconcile).not.toHaveBeenCalled();
    expect(daily.poolImpact).not.toHaveBeenCalled();

    // A failed sync is logged, not thrown into the scheduled handler.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = spies();
    failing.priceSync.mockImplementation(() => Promise.reject(new Error('down')));
    await expect(Promise.all(cronTasks(CRON_DAILY, env, now, failing))).resolves.toBeDefined();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('price sync failed'),
      expect.any(Error),
    );
    error.mockRestore();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unknown = spies();
    expect(cronTasks('0 0 * * *', env, now, unknown)).toEqual([]);
    expect(Object.values(unknown).every((f) => f.mock.calls.length === 0)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cron_unknown'));
    warn.mockRestore();
  });

  it('the Worker’s weekly cron writes the snapshot of the week before its scheduled time', async () => {
    // A week before every other test's, so the latest snapshot stays theirs.
    const w = weekAt(Date.UTC(2020, 5, 1));
    await learnersOn(env.POOL_ACCOUNT_ID ?? 'pool', w, 'arts.film', 3);
    const ctx = createExecutionContext();
    worker.scheduled!(
      { cron: CRON_WEEKLY, scheduledTime: w.cron.getTime(), noRetry: () => undefined },
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(previousWeek(w.cron).start.toISOString().slice(0, 10)).toBe(w.key);
    const s = await impactOf(w.key);
    expect(s).toMatchObject({ weekStart: w.key, exchanges: 3, learners: 3, named: [] });
  });
});
