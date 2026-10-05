// The pool notice's acknowledgments (spec §9 "Consent", docs/pool/PLAN.md
// §S8a). A pool request needs the user's acknowledgment of the current
// notice version (`PoolParams.noticeVersion`, resolved Worker-side); a new
// version asks again. Rows are only ever added (`ON CONFLICT DO NOTHING`), so
// the first acknowledgment of each version keeps its time, and they go with
// the account (auth/delete-account.ts).
import type { PoolConsentResponse } from '@tangent/shared';

/** True when `userId` acknowledged notice `version` (or a later one). */
export async function hasCurrentConsent(
  db: D1Database,
  userId: string,
  version: number,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS ok FROM pool_consents WHERE user_id = ? AND notice_version >= ? LIMIT 1')
    .bind(userId, version)
    .first<{ ok: number }>();
  return row !== null;
}

/** The latest notice version `userId` acknowledged; null = none. */
export async function consentVersion(db: D1Database, userId: string): Promise<number | null> {
  const row = await db
    .prepare('SELECT MAX(notice_version) AS version FROM pool_consents WHERE user_id = ?')
    .bind(userId)
    .first<{ version: number | null }>();
  return row?.version ?? null;
}

/**
 * Records that `userId` acknowledged notice `version` at `now`. Idempotent:
 * a repeat keeps (and returns) the first acknowledgment.
 */
export async function recordConsent(
  db: D1Database,
  userId: string,
  version: number,
  now = new Date(),
): Promise<PoolConsentResponse> {
  const [, row] = await db.batch<{ notice_version: number; acknowledged_at: string }>([
    db
      .prepare(
        `INSERT INTO pool_consents (user_id, notice_version, acknowledged_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id, notice_version) DO NOTHING`,
      )
      .bind(userId, version, now.toISOString()),
    db
      .prepare(
        'SELECT notice_version, acknowledged_at FROM pool_consents WHERE user_id = ? AND notice_version = ?',
      )
      .bind(userId, version),
  ]);
  const stored = row?.results[0];
  if (!stored) throw new Error('Recording the pool consent failed');
  return { version: stored.notice_version, acknowledgedAt: stored.acknowledged_at };
}
