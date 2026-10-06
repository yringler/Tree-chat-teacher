// The community pool's weekly impact snapshot (spec §9 "Weekly aggregation"
// and "Moderation", docs/pool/PLAN.md §S8b). The Monday cron aggregates the
// ISO week just ended from the pool's usage rows and the request-time topic
// tags (pool/tagging.ts) into one immutable public snapshot, then deletes
// tags whose branch has gone unused by the pool for `tagRetentionDays`.
//
// What counts: pool replies settled at a charge above 0 (`BASE`). Released and
// free replies never reached the model or cost nothing; summaries, titles and
// tagging are not exchanges. Per-topic counts join the tags on the branch, so a
// mixed branch's personal or own-key exchanges never count, and a tree
// deleted mid-week still counts (no `nodes` join).
//
// Who is named: a topic (a taxonomy leaf; no roll-up to parents, so a parent
// is never named because of its children) with at least `minDistinctUsers`
// distinct learners that week, not sensitive (the `sensitive` sentinel never
// is), not blocklisted, and approved in the review queue. A topic that
// qualifies but has never been reviewed is queued `pending` instead; once
// approved it publishes automatically from the next snapshot on. Totals count
// everything.
import type { PoolImpactResponse, PoolImpactTopic } from '@tangent/shared';
import { POOL_IMPACT_WEEKS_MAX } from '@tangent/shared';
import { appConfig } from '../config.js';
import type { AppEnv } from '../env.js';
import { weekStart } from './status.js';
import { isSensitive, topicById } from './taxonomy.js';

const DAY_MS = 24 * 60 * 60_000;
const WEEK_MS = 7 * DAY_MS;

/** D1's limit on bound parameters per statement. */
const D1_MAX_PARAMS = 100;

/**
 * The week's funded pool exchanges (`u`): pool replies settled above 0,
 * created in [?2, ?3). `?1` is the pool's account id.
 */
const BASE = `u.account_id = ?1 AND u.funding = 'pool' AND u.purpose = 'reply'
  AND u.status = 'settled' AND u.charge_micros > 0
  AND u.created_at >= ?2 AND u.created_at < ?3`;

/** `YYYY-MM-DD` (UTC) of `date`. */
export function weekKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The ISO week that ended most recently before `now`: [start, end). */
export function previousWeek(now: Date): { start: Date; end: Date } {
  const end = weekStart(now);
  return { start: new Date(end.getTime() - WEEK_MS), end };
}

/** On POOL_TOPIC_BLOCKLIST, itself or through its root (`history` blocks every `history.*`). */
export function isBlocklisted(topicId: string, blocklist: readonly string[]): boolean {
  const parent = topicById(topicId)?.parent;
  return blocklist.includes(topicId) || (!!parent && blocklist.includes(parent));
}

/**
 * Whether `topicId` may ever be named: a taxonomy leaf that is neither
 * sensitive nor blocklisted. The review queue decides the rest.
 */
export function isNameable(topicId: string, blocklist: readonly string[]): boolean {
  const topic = topicById(topicId);
  return (
    !!topic && topic.parent !== null && !isSensitive(topicId) && !isBlocklisted(topicId, blocklist)
  );
}

interface TotalsRow {
  exchanges: number;
  learners: number;
}

interface DepthRow {
  topics: number;
  avg_depth: number | null;
  max_depth: number | null;
}

interface TopicRow {
  topic_id: string;
  learners: number;
  exchanges: number;
  avg_depth: number;
}

export interface ImpactRunResult {
  /** The week aggregated, `YYYY-MM-DD`. */
  week: string;
  /**
   * `exists`: a snapshot of that week was already there, nothing was written.
   * `pool_off`: POOL_ENABLED is false, so no snapshot is written (a week
   * before launch would otherwise be published, immutably, as a zero week).
   */
  /** `no_exchanges`: the pool funded nothing that week, so there is nothing to publish. */
  outcome: 'created' | 'exists' | 'pool_off' | 'no_exchanges';
  /** Topics the snapshot names. */
  named: string[];
  /** Topics queued for review by this run. */
  queued: string[];
  /** Tags deleted by the retention pass. */
  tagsDeleted: number;
}

/** INSERTs of `rows` into `table`, as few statements as D1's parameter limit allows. */
function chunkedInserts(
  db: D1Database,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
  conflict: string,
): D1PreparedStatement[] {
  const perStatement = Math.max(1, Math.floor(D1_MAX_PARAMS / columns.length));
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    const values = chunk.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
    out.push(
      db
        .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${values} ${conflict}`)
        .bind(...chunk.flat()),
    );
  }
  return out;
}

/**
 * Deletes the topic tags of branches with no pool reply since `now − days`
 * (the branch is re-tagged at its next pool exchange). Tags hold no user id,
 * so this is what keeps them from outliving the pool use they describe.
 */
export async function deleteStaleTags(db: D1Database, now: Date, days: number): Promise<number> {
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
  const res = await db
    .prepare(
      `DELETE FROM pool_topic_tags
       WHERE created_at < ?1 AND NOT EXISTS (
         SELECT 1 FROM usage_events u
         WHERE u.branch_id = pool_topic_tags.branch_id AND u.funding = 'pool'
           AND u.purpose = 'reply' AND u.created_at >= ?1)`,
    )
    .bind(cutoff)
    .run();
  return res.meta.changes ?? 0;
}

/**
 * Writes the snapshot of the ISO week that ended before `now` for `poolId`,
 * unless one exists (snapshots are immutable, so a re-run or a retried cron is
 * a no-op), the pool is off or it funded no exchange that week, then runs the tag retention pass (always). The snapshot, its named topics
 * and the newly queued topics are one D1 batch (a transaction).
 */
export async function aggregatePoolImpact(
  env: AppEnv,
  now: Date = new Date(),
  poolId: string = appConfig(env).pool.accountId,
): Promise<ImpactRunResult> {
  const config = appConfig(env);
  const impact = config.impact;
  const db = env.DB;
  const { start, end } = previousWeek(now);
  const week = weekKey(start);
  const result: ImpactRunResult = {
    week,
    outcome: 'exists',
    named: [],
    queued: [],
    tagsDeleted: 0,
  };

  const existing =
    !config.flags.poolEnabled ||
    (await db
      .prepare('SELECT 1 AS x FROM pool_impact_snapshots WHERE week_start = ?')
      .bind(week)
      .first());
  if (!config.flags.poolEnabled) result.outcome = 'pool_off';
  if (!existing) {
    const range = [poolId, start.toISOString(), end.toISOString()] as const;
    const [totalsRes, depthRes, topicsRes, reviewsRes] = await db.batch<Record<string, unknown>>([
      db
        .prepare(
          `SELECT COUNT(*) AS exchanges, COUNT(DISTINCT u.user_id) AS learners
           FROM usage_events u WHERE ${BASE}`,
        )
        .bind(...range),
      db
        .prepare(
          `SELECT COUNT(DISTINCT t.topic_id) AS topics, AVG(t.branch_depth) AS avg_depth,
             MAX(t.branch_depth) AS max_depth
           FROM usage_events u JOIN pool_topic_tags t ON t.branch_id = u.branch_id
           WHERE ${BASE}`,
        )
        .bind(...range),
      db
        .prepare(
          `SELECT t.topic_id, COUNT(DISTINCT u.user_id) AS learners, COUNT(*) AS exchanges,
             AVG(t.branch_depth) AS avg_depth
           FROM usage_events u JOIN pool_topic_tags t ON t.branch_id = u.branch_id
           WHERE ${BASE}
           GROUP BY t.topic_id`,
        )
        .bind(...range),
      db.prepare('SELECT topic_id, status FROM pool_topic_reviews'),
    ]);
    const totals = totalsRes!.results[0] as unknown as TotalsRow | undefined;
    if (Number(totals?.exchanges ?? 0) === 0) {
      // A week without funded exchanges (before launch, or a quiet week) is never published.
      result.outcome = 'no_exchanges';
      result.tagsDeleted = await deleteStaleTags(db, now, impact.tagRetentionDays);
      console.log(JSON.stringify({ event: 'pool_impact', ...result, queued: 0 }));
      return result;
    }
    const depth = depthRes!.results[0] as unknown as DepthRow | undefined;
    const reviews = new Map(
      (reviewsRes!.results as unknown as { topic_id: string; status: string }[]).map((r) => [
        r.topic_id,
        r.status,
      ]),
    );

    const published: TopicRow[] = [];
    for (const row of topicsRes!.results as unknown as TopicRow[]) {
      if (Number(row.learners) < impact.minDistinctUsers) continue;
      if (!isNameable(row.topic_id, impact.topicBlocklist)) continue;
      const status = reviews.get(row.topic_id);
      if (status === 'approved') published.push(row);
      else if (status === undefined) result.queued.push(row.topic_id);
    }
    published.sort(
      (a, b) =>
        Number(b.learners) - Number(a.learners) ||
        Number(b.exchanges) - Number(a.exchanges) ||
        a.topic_id.localeCompare(b.topic_id),
    );
    const milli = (avg: number | null | undefined) => Math.round(Number(avg ?? 0) * 1000);
    // The deepest rabbit hole: published topics only, so never a sensitive or unreviewed one.
    const deepest = published.reduce<TopicRow | null>(
      (best, t) =>
        !best ||
        milli(t.avg_depth) > milli(best.avg_depth) ||
        (milli(t.avg_depth) === milli(best.avg_depth) && Number(t.learners) > Number(best.learners))
          ? t
          : best,
      null,
    );

    await db.batch([
      db
        .prepare(
          `INSERT INTO pool_impact_snapshots (week_start, exchanges, learners, topics,
             avg_depth_milli, max_depth, deepest_topic_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(week_start) DO NOTHING`,
        )
        .bind(
          week,
          Number(totals?.exchanges ?? 0),
          Number(totals?.learners ?? 0),
          Number(depth?.topics ?? 0),
          milli(depth?.avg_depth),
          Number(depth?.max_depth ?? 0),
          deepest?.topic_id ?? null,
          now.toISOString(),
        ),
      ...chunkedInserts(
        db,
        'pool_impact_topics',
        ['week_start', 'topic_id', 'learners', 'exchanges', 'avg_depth_milli'],
        published.map((t) => [
          week,
          t.topic_id,
          Number(t.learners),
          Number(t.exchanges),
          milli(t.avg_depth),
        ]),
        'ON CONFLICT(week_start, topic_id) DO NOTHING',
      ),
      ...chunkedInserts(
        db,
        'pool_topic_reviews',
        ['topic_id', 'status', 'first_seen_week'],
        result.queued.map((id) => [id, 'pending', week]),
        'ON CONFLICT(topic_id) DO NOTHING',
      ),
    ]);
    result.outcome = 'created';
    result.named = published.map((t) => t.topic_id);
  }

  result.tagsDeleted = await deleteStaleTags(db, now, impact.tagRetentionDays);
  console.log(JSON.stringify({ event: 'pool_impact', ...result, queued: result.queued.length }));
  return result;
}

interface SnapshotRow {
  week_start: string;
  exchanges: number;
  learners: number;
  topics: number;
  avg_depth_milli: number;
  max_depth: number;
  deepest_topic_id: string | null;
}

interface ImpactTopicRow {
  topic_id: string;
  learners: number;
  exchanges: number;
  avg_depth_milli: number;
}

/** A label for a stored topic id (a retired id falls back to itself). */
function labelOf(id: string): string {
  return topicById(id)?.label ?? id;
}

/**
 * A snapshot as `GET /api/pool/impact` serves it: `week` (`YYYY-MM-DD`) or
 * the latest; null when there is none. Snapshots name only published topics,
 * so this reads them as stored.
 */
export async function readPoolImpact(
  db: D1Database,
  week?: string,
): Promise<PoolImpactResponse | null> {
  const snapshot = await db
    .prepare(
      `SELECT week_start, exchanges, learners, topics, avg_depth_milli, max_depth, deepest_topic_id
       FROM pool_impact_snapshots
       WHERE exchanges > 0 ${week ? 'AND week_start = ?' : 'ORDER BY week_start DESC LIMIT 1'}`,
    )
    .bind(...(week ? [week] : []))
    .first<SnapshotRow>();
  if (!snapshot) return null;
  const { results } = await db
    .prepare(
      `SELECT topic_id, learners, exchanges, avg_depth_milli FROM pool_impact_topics
       WHERE week_start = ? ORDER BY learners DESC, exchanges DESC, topic_id`,
    )
    .bind(snapshot.week_start)
    .all<ImpactTopicRow>();
  const named = results.map((t): PoolImpactTopic => ({
    id: t.topic_id,
    label: labelOf(t.topic_id),
    learners: Number(t.learners),
    exchanges: Number(t.exchanges),
    avgDepth: Number(t.avg_depth_milli) / 1000,
  }));
  const deepest = named.find((t) => t.id === snapshot.deepest_topic_id);
  return {
    weekStart: snapshot.week_start,
    exchanges: Number(snapshot.exchanges),
    learners: Number(snapshot.learners),
    topics: Number(snapshot.topics),
    avgDepth: Number(snapshot.avg_depth_milli) / 1000,
    maxDepth: Number(snapshot.max_depth),
    deepest: deepest ? { id: deepest.id, label: deepest.label, avgDepth: deepest.avgDepth } : null,
    named,
  };
}

/** The weeks with a snapshot, newest first (at most `POOL_IMPACT_WEEKS_MAX`). */
export async function poolImpactWeeks(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      'SELECT week_start FROM pool_impact_snapshots WHERE exchanges > 0 ORDER BY week_start DESC LIMIT ?',
    )
    .bind(POOL_IMPACT_WEEKS_MAX)
    .all<{ week_start: string }>();
  return results.map((r) => r.week_start);
}
