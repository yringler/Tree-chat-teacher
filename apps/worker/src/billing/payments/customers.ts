// `billing_customers`: who each user is at a payment provider. Written by the
// domain from any event (or checkout) that carries both ids; read to tell
// account deletion whether a provider holds a customer, and by adapters that
// need a stored customer id. Polar addresses customers by our user id
// (external_id), so for it this is informational (02 §5, D6).
import type { ProviderId } from './port.js';

/**
 * Records `customerRef` as `userId`'s customer at `provider` (the latest one
 * wins). Ignored for a user who no longer exists, so a late webhook can't
 * bring a deleted account's row back. Resolves true when a row changed.
 */
export async function rememberCustomer(
  db: D1Database,
  provider: ProviderId,
  userId: string,
  customerRef: string,
  now = new Date(),
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO billing_customers (provider, user_id, customer_ref, created_at)
       SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM auth_users WHERE id = ?2)
       ON CONFLICT(provider, user_id) DO UPDATE SET customer_ref = excluded.customer_ref
       WHERE billing_customers.customer_ref <> excluded.customer_ref`,
    )
    .bind(provider, userId, customerRef, now.toISOString())
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** `userId`'s customer id at `provider`, if one was recorded. */
export async function customerRefFor(
  db: D1Database,
  provider: ProviderId,
  userId: string,
): Promise<string | null> {
  const row = await db
    .prepare('SELECT customer_ref FROM billing_customers WHERE provider = ? AND user_id = ?')
    .bind(provider, userId)
    .first<{ customer_ref: string }>();
  return row?.customer_ref ?? null;
}

/** The providers that hold a customer record of `userId` (any provider, current or not). */
export async function customerProvidersOf(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT provider FROM billing_customers WHERE user_id = ? ORDER BY provider')
    .bind(userId)
    .all<{ provider: string }>();
  return results.map((r) => r.provider);
}

/** Deletes every customer row of `userId` (for the account-deletion batch). */
export function forgetCustomersStatement(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM billing_customers WHERE user_id = ?').bind(userId);
}
