// Who may use the open pool: one pool identity
// per mailbox, claimed when the user first passes Turnstile. An email's
// identity is the SHA-256 of its normalised form, so the aliases one inbox
// receives (`A.B+pool@gmail.com`, `ab@googlemail.com`) are one free tier.
import { logEvent } from '../log.js';
import { DAY_USAGE_COLUMNS, dayStart } from './pool-bank.js';
import type { SqlRow } from '../db/rows.js';
import type { authUsers, poolIdentities } from '../db/schema.js';

/** Domains whose mailboxes ignore dots in the local part, mapped to one domain. */
const DOTLESS_DOMAINS: Readonly<Record<string, string>> = {
  'gmail.com': 'gmail.com',
  'googlemail.com': 'gmail.com',
};

/**
 * The mailbox an email address reaches: lower-cased, its `+tag` stripped,
 * and for Gmail its dots removed and `googlemail.com` mapped to `gmail.com`.
 * An address with no `@` is only lower-cased.
 */
export function normaliseEmail(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at <= 0) return lower;
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  const dotless = DOTLESS_DOMAINS[domain];
  if (dotless) {
    local = local.replace(/\./g, '');
    domain = dotless;
  }
  return `${local}@${domain}`;
}

/** `auth_users.pool_identity` of an email: SHA-256 (hex) of its normalised form. */
export async function poolIdentity(email: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(normaliseEmail(email)),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * How long a pool identity outlives the deletion of the account that held it
 * (`pool_identities.deleted_at`), so that deleting the account and signing up
 * again with the same mailbox can't start a fresh free tier. Then the daily
 * cron purges it (`purgeReleasedPoolIdentities`). The privacy policy states it.
 */
export const POOL_IDENTITY_RETENTION_DAYS = 90;

/**
 * Claims `email`'s pool identity for `userId`. `ok` when the user holds it
 * (now or already), `duplicate` when another user does. A user holds one
 * identity: it is set once and never moves to a changed email. An identity
 * released by a deleted account within `POOL_IDENTITY_RETENTION_DAYS` comes
 * back with its suspension and that day's usage (`pool_identities`).
 */
export async function claimPoolIdentity(
  db: D1Database,
  userId: string,
  email: string,
): Promise<'ok' | 'duplicate'> {
  const identity = await poolIdentity(email);
  // The unique index is the arbiter; a holder other than the user means it's taken.
  const holder = await db
    .prepare('SELECT id FROM auth_users WHERE pool_identity = ?')
    .bind(identity)
    .first<Pick<SqlRow<typeof authUsers>, 'id'>>();
  if (holder) return holder.id === userId ? 'ok' : 'duplicate';
  try {
    // A user who holds another identity keeps it.
    await db
      .prepare('UPDATE auth_users SET pool_identity = ?1 WHERE id = ?2 AND pool_identity IS NULL')
      .bind(identity, userId)
      .run();
  } catch (err) {
    // Lost a race to another account with the same mailbox.
    if (/UNIQUE/i.test(String(err))) return 'duplicate';
    throw err;
  }
  return 'ok';
}

/**
 * True when the pool identity `identity` is suspended: an admin suspended an
 * account that held it, which may since have been deleted.
 */
export async function identitySuspended(db: D1Database, identity: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT suspended FROM pool_identities WHERE identity = ?')
    .bind(identity)
    .first<Pick<SqlRow<typeof poolIdentities>, 'suspended'>>();
  return row?.suspended === 1;
}

/**
 * The statement that records `userId`'s pool suspension on their pool identity
 * too, if they hold one, so it survives the account's deletion; `false` lifts
 * it, including one inherited from a deleted account with the same mailbox.
 * Run it with the update of `auth_users.pool_suspended`.
 */
export function identitySuspensionStatement(
  db: D1Database,
  userId: string,
  suspended: boolean,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO pool_identities (identity, suspended)
       SELECT pool_identity, ?2 FROM auth_users WHERE id = ?1 AND pool_identity IS NOT NULL
       ON CONFLICT(identity) DO UPDATE SET suspended = excluded.suspended`,
    )
    .bind(userId, suspended ? 1 : 0);
}

/**
 * Records a Turnstile pass: sets `pool_verified_at` (once; the first pass is
 * kept) and claims the pool identity of the user's email. Verified either
 * way; `duplicate` when the identity belongs to another account, which the
 * pool gate then refuses (`duplicate_identity`).
 */
export async function markPoolVerified(
  db: D1Database,
  userId: string,
  email: string,
  now = new Date(),
): Promise<'ok' | 'duplicate'> {
  await db
    .prepare('UPDATE auth_users SET pool_verified_at = COALESCE(pool_verified_at, ?) WHERE id = ?')
    .bind(now.toISOString(), userId)
    .run();
  return claimPoolIdentity(db, userId, email);
}

/**
 * Account deletion: the statement that keeps `identity` (the deleted user's
 * pool identity, claimed or not) for `POOL_IDENTITY_RETENTION_DAYS` from
 * `now`, suspended if the user was or the identity already is, with the
 * user's pool usage of `now`'s UTC day on `poolId` added to that of a
 * deletion earlier the same day, which the next holder's caps count until
 * the day ends. A row still pending counts at its ceiling hold, though it
 * may settle lower: the carry errs toward the cap. Run it in the deletion's
 * batch before the user's usage rows lose their user id.
 */
export function releasePoolIdentityStatement(
  db: D1Database,
  r: { identity: string; userId: string; poolId: string; suspended: boolean; now: Date },
): D1PreparedStatement {
  // SET reads the row as it was, so `deleted_at` below is the earlier deletion's.
  return db
    .prepare(
      `INSERT INTO pool_identities
         (identity, suspended, deleted_at, deleted_day_requests, deleted_day_spend_micros)
       SELECT ?4, ?5, ?6, requests, spend FROM (SELECT ${DAY_USAGE_COLUMNS} FROM usage_events
         WHERE account_id = ?1 AND user_id = ?2 AND created_at >= ?3)
       WHERE true
       ON CONFLICT(identity) DO UPDATE SET
         suspended = MAX(suspended, excluded.suspended),
         deleted_at = excluded.deleted_at,
         deleted_day_requests = excluded.deleted_day_requests
           + CASE WHEN deleted_at >= ?3 THEN deleted_day_requests ELSE 0 END,
         deleted_day_spend_micros = excluded.deleted_day_spend_micros
           + CASE WHEN deleted_at >= ?3 THEN deleted_day_spend_micros ELSE 0 END`,
    )
    .bind(
      r.poolId,
      r.userId,
      dayStart(r.now).toISOString(),
      r.identity,
      r.suspended ? 1 : 0,
      r.now.toISOString(),
    );
}

/**
 * Daily cron: deletes the pool identities whose last holder was deleted
 * more than `POOL_IDENTITY_RETENTION_DAYS` before `now` and that no account
 * holds again, suspension and all; that mailbox then starts afresh.
 * Idempotent. Returns how many it deleted.
 */
export async function purgeReleasedPoolIdentities(
  db: D1Database,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - POOL_IDENTITY_RETENTION_DAYS * 86_400_000);
  const result = await db
    .prepare(
      `DELETE FROM pool_identities WHERE deleted_at < ?
         AND NOT EXISTS (SELECT 1 FROM auth_users u WHERE u.pool_identity = pool_identities.identity)`,
    )
    .bind(cutoff.toISOString())
    .run();
  const purged = result.meta.changes;
  if (purged > 0) logEvent('info', 'pool_identities_purged', { purged });
  return purged;
}
