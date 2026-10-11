import { DomainError } from '@tangent/core';
import { isAdminUserId } from '../auth/admin.js';
import { canShare } from '../availability.js';
import { appConfig } from '../config.js';
import type { SqlRow } from '../db/rows.js';
import type { authUsers } from '../db/schema.js';
import type { AppEnv } from '../env.js';
import { publishesCountedSince } from './audit.js';

const DAY_MS = 86_400_000;

/**
 * Checks that the user may publish a link (create, edit or republish one),
 * in order, each refusal its own error:
 * - `canShare`: SHARING, the allowlist and `sharing_suspended` (403);
 * - older than `SHARE_MIN_ACCOUNT_AGE_MS`, unless an admin (403): a fresh
 *   throwaway account can't publish at once;
 * - fewer than `SHARE_CREATES_PER_DAY` publishes in the last 24 hours
 *   (429): refused ones of any kind, so a flagged conversation can't be
 *   retried against the classifier, and, when `creating`, new links. It is
 *   counted from the audit log so deleting links doesn't reset it.
 * The dev bypass (`userId` null) has no account to age or count.
 */
export async function assertMayPublish(
  env: AppEnv,
  userId: string | null,
  { creating }: { creating: boolean },
  now = new Date(),
): Promise<void> {
  if (!(await canShare(env, userId))) {
    throw new DomainError(
      'forbidden',
      "Public share links aren't enabled for your account. Download the conversation instead.",
    );
  }
  if (!userId) return;
  const { shareMinAccountAgeMs, shareCreatesPerDay } = appConfig(env).site;
  if (shareMinAccountAgeMs > 0 && !isAdminUserId(env, userId)) {
    const row = await env.DB.prepare('SELECT created_at FROM auth_users WHERE id = ?')
      .bind(userId)
      .first<Pick<SqlRow<typeof authUsers>, 'created_at'>>();
    if (!row || now.getTime() - row.created_at < shareMinAccountAgeMs) {
      throw new DomainError(
        'forbidden',
        'This account is too new to publish share links yet. Download the conversation instead.',
      );
    }
  }
  const since = new Date(now.getTime() - DAY_MS);
  if ((await publishesCountedSince(env.DB, userId, since, { creating })) >= shareCreatesPerDay) {
    throw new DomainError(
      'rate_limited',
      "You've reached today's limit for publishing share links. Try again tomorrow.",
    );
  }
}
