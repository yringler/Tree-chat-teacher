// Who may use the open pool: one pool identity
// per mailbox, claimed when the user first passes Turnstile. An email's
// identity is the SHA-256 of its normalised form, so the aliases one inbox
// receives (`A.B+pool@gmail.com`, `ab@googlemail.com`) are one free tier.
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
 * Claims `email`'s pool identity for `userId`. `ok` when the user holds it
 * (now or already), `duplicate` when another user does. A user holds one
 * identity: it is set once and never moves to a changed email. A claim is
 * recorded in `pool_identity_holders`, which outlives the account, so an
 * identity released by a deleted account comes back with its suspension
 * (`pool_identities`) and its day's usage (the caps count every holder).
 */
export async function claimPoolIdentity(
  db: D1Database,
  userId: string,
  email: string,
  now = new Date(),
): Promise<'ok' | 'duplicate'> {
  const identity = await poolIdentity(email);
  // The unique index is the arbiter; a holder other than the user means it's taken.
  const holder = await db
    .prepare('SELECT id FROM auth_users WHERE pool_identity = ?')
    .bind(identity)
    .first<Pick<SqlRow<typeof authUsers>, 'id'>>();
  if (holder) return holder.id === userId ? 'ok' : 'duplicate';
  try {
    await db.batch([
      db
        .prepare('UPDATE auth_users SET pool_identity = ?1 WHERE id = ?2 AND pool_identity IS NULL')
        .bind(identity, userId),
      // Only when the claim above took (a user who holds another identity keeps it).
      db
        .prepare(
          `INSERT INTO pool_identity_holders (user_id, identity, claimed_at)
           SELECT ?2, ?1, ?3 WHERE EXISTS
             (SELECT 1 FROM auth_users WHERE id = ?2 AND pool_identity = ?1)
           ON CONFLICT(user_id) DO NOTHING`,
        )
        .bind(identity, userId, now.toISOString()),
    ]);
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
  return claimPoolIdentity(db, userId, email, now);
}
