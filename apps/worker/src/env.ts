import type { BranchFunding, Payer } from '@tangent/shared';
import type { Context } from 'hono';
import type { ConfigVars } from './config.js';
import type { PoolParams } from './pool/params.js';

/**
 * Worker environment: the bindings and vars `wrangler types` generates from
 * wrangler.jsonc (`Env`), plus every var and secret config.ts reads, each
 * optional (secrets and vars left at their default aren't in wrangler.jsonc).
 * Only config.ts reads the vars and secrets (docs/configuration.md); every
 * other module reads bindings alone.
 */
export type AppEnv = Env & ConfigVars;

/** What every account carries, whichever app it is in. */
interface AccountIds {
  /** Owner of trees, shares and settings, the same in every mode: `u_<userId>` | `default_simple`. */
  id: string;
  /** Better Auth user id; null in dev bypass mode. */
  userId: string | null;
  /** Ledger id for credit and usage (`credit_grants`, `usage_events`): the account's `id`. */
  billingAccountId: string;
}

/**
 * The full app (power, Canvas): the user's own keys, plus Tangent credit per
 * route (a branch's or reviewer's funding) where the server offers it. It
 * never uses the pool.
 */
export interface PowerAccount extends AccountIds {
  mode: 'power';
  /**
   * Tangent credit is offered (`builtInAvailable`): a route on `credit` runs
   * on the built-in provider, on the operator's key and metered per call.
   */
  creditOffered: boolean;
  /**
   * Dev bypass only: the power configs' server secrets (ANTHROPIC_API_KEY &
   * co.) may be used. Every signed-in user is bring-your-own-key for those.
   */
  operatorKeys: boolean;
}

/**
 * Tangent Learn, paying per request whatever a branch says: on
 * the user's own OpenRouter key, or on credit (the built-in provider on the
 * operator's key, metered) where it is offered.
 */
export interface LearnAccount extends AccountIds {
  mode: 'simple';
  payer: 'own-key' | 'credit';
}

/** Learn on the open pool: a signed-in user, and what the pool's calls run with. */
export interface PoolAccount extends AccountIds {
  mode: 'simple';
  payer: 'pool';
  userId: string;
  /**
   * Resolved Worker-side from the config (pool/params.ts). The Durable
   * Objects read it from here, never from their own env.
   */
  pool: PoolParams;
}

/**
 * Learn asking for the pool where the pool can't pay: it is off, there is no
 * signed-in user to cap, or its parameters aren't resolved yet
 * (auth/account.ts `withPoolParams`). Such a request generates nothing (the
 * gate refuses it, 403 `pool_unavailable`); everything else reads as on the
 * user's own key.
 */
export interface UnfundedPoolAccount extends AccountIds {
  mode: 'simple';
  payer: 'pool';
  pool: null;
}

/**
 * The account a request acts as (see auth/account.ts): every user's one
 * account, as the request's mode generates and pays for replies.
 */
export type AccountContext = PowerAccount | LearnAccount | PoolAccount | UnfundedPoolAccount;

/** True when the account's metered calls are paid by the open pool. */
export function isPoolFunded(account: AccountContext): account is PoolAccount {
  return account.mode === 'simple' && account.payer === 'pool' && account.pool !== null;
}

/**
 * Who pays for a call on a route of `funding`, decided by the account and
 * never by the provider id (which names only the endpoint):
 * - Learn: the request's payer, whatever the route says (Learn ignores a
 *   branch's funding). A pool request the pool can't fund pays nothing
 *   upstream, so it reads as on the user's own key.
 * - power: the route's funding, `credit` only where the server offers
 *   Tangent credit. A power account mixes its own keys with credit, per call.
 * Every payer but `own-key` is metered, on the operator's key. Power's
 * own-key routes are always on the user's keys, so `callPayer(account,
 * 'own-key') === 'own-key'` says whether a request reads the key cookie at
 * all: always in power, and in Learn on its own key only.
 */
export function callPayer(account: AccountContext, funding: BranchFunding): Payer {
  if (account.mode === 'power')
    return account.creditOffered && funding === 'credit' ? 'credit' : 'own-key';
  if (account.payer === 'pool' && account.pool === null) return 'own-key';
  return account.payer;
}

/** Caller identity established by the session middleware for `/api/*`. */
export interface Identity {
  /** Better Auth user id; null only in dev bypass mode. */
  userId: string | null;
  /** Verified email of the signed-in user; null only in dev bypass mode. */
  email: string | null;
  /** True only when DEV_ALLOW_NO_AUTH is honoured (BETTER_AUTH_SECRET unset). */
  devMode: boolean;
}

export interface AppVariables {
  identity: Identity;
  /** Account the request acts as (see auth/account.ts). */
  account: AccountContext;
  /** Alias of `account.id`. */
  accountId: string;
}

export interface AppBindings {
  Bindings: AppEnv;
  Variables: AppVariables;
}

export type AppContext = Context<AppBindings>;
