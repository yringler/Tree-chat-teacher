// The one gate in front of every route that generates (docs/pool/PLAN.md §3):
// sends, reviews and `context?resolve=true`. It decides who pays (personal
// credit, the community pool or the user's own key) and checks that they can,
// before anything is written or sent upstream.
import { DomainError, ValidationError } from '@tangent/core';
import { clientIp, withPoolParams } from '../auth/account.js';
import { assertGenerationAllowed, enforceRateLimit } from '../byok/guard.js';
import type { UserKeys } from '../byok/keys.js';
import { isMetered, isPoolFunded, type AccountContext, type AppContext } from '../env.js';
import { poolAvailable, registryFor } from '../services.js';
import { getBalance } from './ledger.js';
import { assertMember } from './membership.js';
import { assertCanSpend, usageHoldMicros } from './service.js';

/** What a generating request is about to do. */
export interface GenerateCheck {
  /** `send` and `resolve` may fall back to the pool; `review` never does. */
  purpose: 'send' | 'resolve' | 'review';
  /** The provider the request calls. */
  providerId: string;
  /** Checked against the provider's allowlist; null = not checked (a context resolve). */
  model: string | null;
  /** Another provider the request may also spend on (a review's branch, for its summaries). */
  alsoSpendsOn?: string;
  /** The user's key cookie (power, and Learn on its own key). */
  keys: UserKeys | null;
  /** A send's message: the pool accepts at most `POOL_MAX_MESSAGE_CHARS`. */
  content?: string;
}

/**
 * Who pays for a generating request, decided by the server. A Learn send or
 * context resolve on personal credit that can't cover one more call
 * (`available < USAGE_HOLD_MICROS`) moves to the community pool when the pool
 * is on; a review never does, and keeps its 402 `payment_required`.
 */
export async function resolveFunding(
  c: AppContext,
  account: AccountContext,
  purpose: GenerateCheck['purpose'],
): Promise<AccountContext> {
  if (purpose === 'review' || account.mode !== 'simple' || account.funding !== 'personal')
    return account;
  if (!account.userId || !poolAvailable(c.env)) return account;
  const { balanceMicros, heldMicros } = await getBalance(c.env.DB, account.billingAccountId);
  if (balanceMicros - heldMicros >= usageHoldMicros(c.env)) return account;
  return withPoolParams(c.env, account, clientIp(c.req.raw.headers), true);
}

/**
 * Checks that the caller may generate, in order: the membership; who pays
 * (`resolveFunding`); then either the pool's own rules (no reviews, the
 * message length; the reply itself is reserved, or refused with 402/429, by
 * the tree's Durable Object before any node is written) or the existing
 * checks: allowed model, credit, rate limit. Sets `c.var.account` to the
 * account that will pay, so the caller must build its ChatService after this.
 */
export async function assertCanGenerate(
  c: AppContext,
  check: GenerateCheck,
): Promise<AccountContext> {
  await assertMember(c.env, c.var.account);
  const account = await resolveFunding(c, c.var.account, check.purpose);
  c.set('account', account);

  if (account.funding === 'pool') {
    if (check.purpose === 'review')
      throw new DomainError('pool_unavailable', 'Reviews are not available on the community pool');
    if (!isPoolFunded(account))
      throw new DomainError('pool_unavailable', 'The community pool is not available right now');
    const pool = account.pool;
    if (check.content !== undefined && check.content.length > pool.maxMessageChars)
      throw new ValidationError(
        `Messages on the community pool can be at most ${pool.maxMessageChars} characters`,
      );
    // Whatever the branch says, a pool call runs on the pool model (services.ts pins it).
    assertGenerationAllowed(
      registryFor(c.env, account, undefined, { generating: true }),
      check.providerId,
      pool.model,
      { userKeys: false },
    );
    // S4 adds the pool's account gates here, and PoolBank.admit for a context resolve.
    return account;
  }

  if (check.model !== null) {
    const keys = check.keys?.state === 'ok' ? check.keys.keys : undefined;
    assertGenerationAllowed(registryFor(c.env, account, keys), check.providerId, check.model, {
      userKeys: !isMetered(account, check.providerId),
    });
  }
  await assertCanSpend(c.env, account, check.providerId);
  if (check.alsoSpendsOn !== undefined && check.alsoSpendsOn !== check.providerId)
    await assertCanSpend(c.env, account, check.alsoSpendsOn);
  await enforceRateLimit(c, check.keys, 'chat', check.providerId);
  return account;
}
