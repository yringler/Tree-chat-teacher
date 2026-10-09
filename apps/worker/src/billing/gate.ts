// The one gate in front of every route that generates:
// sends, reviews, compare candidates and `context?resolve=true`. It decides who pays (personal
// credit, the open pool or the user's own key) and checks that they can,
// before anything is written or sent upstream.
import { DomainError, PoolBlockedError, poolBlock, ValidationError } from '@tangent/core';
import type { BranchFunding, PoolBlockDetails, ProviderRoute } from '@tangent/shared';
import { clientIp, withPoolParams } from '../auth/account.js';
import { assertGenerationAllowed, enforceRateLimit } from '../byok/guard.js';
import type { UserKeys } from '../byok/keys.js';
import { appConfig } from '../config.js';
import {
  isMetered,
  isPoolFunded,
  type AccountContext,
  type AppContext,
  type AppEnv,
} from '../env.js';
import { claimPoolIdentity, identitySuspended, poolIdentity } from '../pool/identity.js';
import { poolBank } from '../pool/ids.js';
import { poolAdmitRequest, poolBlockDetails } from '../pool/params.js';
import { poolAvailable } from '../availability.js';
import { registryFor, routeRegistryFor } from '../registries.js';
import { LEARN_KEY_LABEL } from '../simple-mode.js';
import { getBalance } from './ledger.js';
import { assertMember, needsMembership } from './membership.js';
import { assertCanSpend, requireCreditPrice, USAGE_HOLD_MICROS } from './service.js';

/** What a generating request is about to do. */
export interface GenerateCheck {
  /**
   * `send` and `resolve` may fall back to the pool; `review` never does, nor
   * does `compare` (a compare candidate, which like a review is refused on the pool).
   */
  purpose: 'send' | 'resolve' | 'review' | 'compare';
  /** The provider the request calls (the endpoint). */
  providerId: string;
  /** How that call is paid in power (the branch's or reviewer's funding); Learn pays per request. */
  funding: BranchFunding;
  /** Checked against the provider's allowlist; null = not checked (a context resolve). */
  model: string | null;
  /** Another route the request may also spend on (a review's or candidate's branch, for its summaries). */
  alsoSpendsOn?: ProviderRoute;
  /** The user's key cookie (power, and Learn on its own key). */
  keys: UserKeys | null;
  /** A send's (or candidate's) message: the pool accepts at most `POOL_MAX_MESSAGE_CHARS`. */
  content?: string;
}

/**
 * Who pays for a generating request, decided by the server. A Learn send or
 * context resolve on personal credit moves to the open pool when the pool
 * is on and the caller can't cover one more call
 * (`available < USAGE_HOLD_MICROS`). Credit needs no membership, to buy or to
 * spend, so anyone holding it keeps spending it until it runs short. A review
 * or a compare candidate never moves, and keeps its 402 `payment_required`;
 * nor does a send while the pool is off.
 */
export async function resolveFunding(
  c: AppContext,
  account: AccountContext,
  purpose: GenerateCheck['purpose'],
): Promise<AccountContext> {
  if (
    purpose === 'review' ||
    purpose === 'compare' ||
    account.mode !== 'simple' ||
    account.funding !== 'personal'
  )
    return account;
  if (!account.userId || !poolAvailable(c.env)) return account;
  const { balanceMicros, heldMicros } = await getBalance(c.env.DB, account.billingAccountId);
  if (balanceMicros - heldMicros >= USAGE_HOLD_MICROS) return account;
  return withPoolParams(c.env, account, clientIp(c.req.raw.headers), true);
}

interface PoolAccessRow {
  email: string;
  created_at: number;
  pool_suspended: number;
  pool_verified_at: string | null;
  pool_identity: string | null;
  /** `pool_identities.suspended` of the user's identity (a deleted holder's suspension). */
  identity_suspended: number | null;
}

const POOL_ACCESS_MESSAGES: Partial<Record<PoolBlockDetails['reason'], string>> = {
  suspended: 'Open pool access is suspended for this account',
  verify: 'Complete the quick human check to use the open pool',
  duplicate_identity: 'Another account with this email address already uses the open pool',
  too_new: 'This account is too new to use the open pool yet',
};

/** The 403 `pool_unavailable` of an account the pool refuses, with its reason. */
export function poolAccessError(reason: PoolBlockDetails['reason']): PoolBlockedError {
  return new PoolBlockedError(poolBlock(reason), POOL_ACCESS_MESSAGES[reason]);
}

function refuseAccess(reason: PoolBlockDetails['reason']): never {
  throw poolAccessError(reason);
}

/**
 * The pool's account gates, in order, each a 403
 * `pool_unavailable` with its reason: a real signed-in user (the dev bypass
 * has none to cap); not `suspended` by an admin (the account, or its pool
 * identity, when a suspended account was deleted); a Turnstile pass on record
 * (`verify`; set at sign-in, or by `POST /api/pool/verify` for older
 * accounts); the user's pool identity, claimed here if a sign-in couldn't
 * (`duplicate_identity` when another account holds that mailbox); older than
 * `POOL_MIN_ACCOUNT_AGE_MS` (`too_new`).
 */
export async function assertPoolAccess(
  env: AppEnv,
  userId: string | null,
  now = new Date(),
): Promise<void> {
  if (!userId) throw new DomainError('pool_unavailable', 'The open pool needs a signed-in account');
  const row = await env.DB.prepare(
    `SELECT u.email, u.created_at, u.pool_suspended, u.pool_verified_at, u.pool_identity,
       (SELECT suspended FROM pool_identities WHERE identity = u.pool_identity) AS identity_suspended
       FROM auth_users u WHERE u.id = ?`,
  )
    .bind(userId)
    .first<PoolAccessRow>();
  if (!row) refuseAccess('verify');
  if (row.pool_suspended || row.identity_suspended) refuseAccess('suspended');
  if (!row.pool_verified_at) refuseAccess('verify');
  if (!row.pool_identity) {
    if ((await claimPoolIdentity(env.DB, userId, row.email, now)) === 'duplicate')
      refuseAccess('duplicate_identity');
    // A mailbox whose earlier account was suspended, then deleted.
    if (await identitySuspended(env.DB, await poolIdentity(row.email))) refuseAccess('suspended');
  }
  const minAge = appConfig(env).pool.minAccountAgeMs;
  if (minAge > 0 && now.getTime() - row.created_at < minAge) refuseAccess('too_new');
}

/**
 * Checks that the caller may generate, in order: who pays (`resolveFunding`);
 * then either the pool's own rules, which need no membership (no reviews or compare, the
 * message length, the account gates of `assertPoolAccess`, and for a context
 * resolve PoolBank's rate check; a reply itself is reserved, or refused with
 * 402/429, by the tree's Durable Object before any node is written) or the
 * existing checks: the membership where `needsMembership` says so (the
 * user's own keys, in Learn or power; Tangent credit needs none), allowed
 * model, credit, rate limit. Sets `c.var.account` to the account that will
 * pay, so the caller must build its ChatService after this.
 */
export async function assertCanGenerate(
  c: AppContext,
  check: GenerateCheck,
): Promise<AccountContext> {
  const account = await resolveFunding(c, c.var.account, check.purpose);
  c.set('account', account);

  if (account.funding === 'pool') {
    if (check.purpose === 'review')
      throw new DomainError('pool_unavailable', 'Reviews are not available on the open pool');
    if (check.purpose === 'compare')
      throw new DomainError('pool_unavailable', "Compare isn't available on the open pool");
    if (!isPoolFunded(account))
      throw new DomainError('pool_unavailable', 'The open pool is not available right now');
    const pool = account.pool;
    if (check.content !== undefined && check.content.length > pool.maxMessageChars)
      throw new ValidationError(
        `Messages on the open pool can be at most ${pool.maxMessageChars} characters`,
      );
    // Whatever the branch says, a pool call runs on the pool model (registries.ts pins it).
    assertGenerationAllowed(
      registryFor(c.env, account, undefined, { generating: true }),
      check.providerId,
      pool.model,
      { userKeys: false },
    );
    await assertPoolAccess(c.env, account.userId);
    if (check.purpose === 'resolve') {
      // A send is admitted by its reply's reservation; a resolve reserves nothing itself.
      const admitted = await poolBank(c.env, pool.accountId).admit(
        poolAdmitRequest(pool, account.userId!),
      );
      if (!admitted.ok) throw new PoolBlockedError(poolBlockDetails(admitted));
    }
    return account;
  }

  if (needsMembership(account, check)) await assertMember(c.env, account);
  if (check.model !== null) {
    const keys = check.keys?.state === 'ok' ? check.keys.keys : undefined;
    assertGenerationAllowed(
      routeRegistryFor(c.env, account, check.funding, keys),
      check.providerId,
      check.model,
      {
        userKeys: !isMetered(account, check.funding),
        keyLabel: account.mode === 'simple' ? LEARN_KEY_LABEL : undefined,
      },
    );
  }
  await assertCanSpend(c.env, account, check.funding);
  // A credit call is held at its model's price: one without a known price can't run on credit.
  if (check.model !== null && isMetered(account, check.funding))
    await requireCreditPrice(c.env, check.model);
  if (check.alsoSpendsOn !== undefined && check.alsoSpendsOn.funding !== check.funding)
    await assertCanSpend(c.env, account, check.alsoSpendsOn.funding);
  await enforceRateLimit(c, check.keys, 'chat', check.funding);
  return account;
}
