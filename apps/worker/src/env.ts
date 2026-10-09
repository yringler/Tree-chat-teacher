import type { AccountMode, BranchFunding, Payer } from '@tangent/shared';
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

/**
 * The account a request acts as (see auth/account.ts). Every user has one per mode,
 * each with its own conversations:
 * - `power`: `p_<userId>`, the full app (own keys, plus the built-in provider on credit).
 * - `simple`: `u_<userId>`, Tangent Learn.
 * Credit is per user: both accounts spend the one ledger at `billingAccountId`.
 */
export interface AccountContext {
  /** Owner of trees, shares and settings: `p_<userId>` | `u_<userId>` | `default` | `default_simple`. */
  id: string;
  mode: AccountMode;
  /** Better Auth user id; null in dev bypass mode. */
  userId: string | null;
  /**
   * Ledger id for credit and usage (`credit_grants`, `usage_events`), the
   * same in both modes: `u_<userId>`, or `default_simple` in the dev bypass.
   * It is the Learn account's id, so Learn balances from before credit was
   * shared carry over without a migration.
   */
  billingAccountId: string;
  /**
   * The built-in provider (`tangent`, on BUILT_IN_API_KEY) is in this
   * account's registry, on the operator's key and metered per call:
   * - power: whenever the server offers it (`builtInAvailable`), next to the
   *   user's own providers;
   * - simple: when the request asks to pay with credit and it is offered;
   *   Learn then ignores the user's keys.
   */
  builtIn: boolean;
  /**
   * Dev bypass only: the power configs' server secrets (ANTHROPIC_API_KEY &
   * co.) may be used. Every signed-in user is bring-your-own-key for those.
   */
  operatorKeys: boolean;
  /**
   * Who pays for the built-in provider's calls (auth/account.ts): `credit`
   * (the ledger at `billingAccountId`), `pool` (the open pool; Learn
   * only, `builtIn` when the pool is on) or `own-key` (Learn on the user's
   * key, where `builtIn` is false). Power is always `credit`.
   */
  funding: Payer;
  /**
   * Pool funding only: what pool calls run with, resolved Worker-side from
   * the config (pool/params.ts). The Durable Objects read it from here, never
   * from their own env.
   */
  pool?: PoolParams;
}

/** True when the account's metered calls are paid by the open pool. */
export function isPoolFunded(
  account: AccountContext,
): account is AccountContext & { funding: 'pool'; pool: PoolParams } {
  return account.funding === 'pool' && account.builtIn && account.pool !== undefined;
}

/**
 * True when a call is metered: paid on the operator's key from the user's
 * credit or the open pool, never on the user's own key. Decided by
 * funding, never by the provider id (which names only the endpoint):
 * - Learn: by the request's payment (`account.builtIn`: credit or the pool),
 *   whatever the branch says; Learn ignores a branch's funding.
 * - power: by the funding of the route the call is on (the branch's, or a
 *   reviewer's), `credit`, and only where the server offers Tangent credit
 *   (`account.builtIn`). Metering is per call, not per account: a power
 *   account mixes its own keys with credit.
 */
export function isMetered(account: AccountContext, funding: BranchFunding): boolean {
  if (account.mode === 'simple') return account.builtIn;
  return account.builtIn && funding === 'credit';
}

/**
 * Whether the request uses the user's key cookie. Learn on credit runs on the
 * operator's key alone and never reads it; power always does, since its other
 * providers need it even when the built-in one is present.
 */
export function usesUserKeys(account: AccountContext): boolean {
  return !(account.mode === 'simple' && account.builtIn);
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
