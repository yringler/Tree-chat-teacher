import type { AccountMode, BranchFunding, FundingSource } from '@tangent/shared';
import type { Context } from 'hono';
import type { PoolParams } from './pool/params.js';

/**
 * Worker environment: generated bindings/vars (`Env`, from wrangler types)
 * plus secrets, which `wrangler types` cannot see. Secrets are optional
 * because only the providers actually configured need theirs.
 */
export interface AppEnv extends Env {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  AI_GATEWAY_TOKEN?: string;
  /**
   * 32 random bytes, base64 (`openssl rand -base64 32`). Seals user-supplied
   * API keys into their cookie. Unset = bring-your-own-key disabled.
   * Rotating it invalidates every stored key.
   */
  KEY_ENCRYPTION_SECRET?: string;
  /**
   * 32+ random bytes (`openssl rand -base64 32`). Signs Better Auth session
   * cookies. Unset = authentication not configured: `/api/*` refuses every
   * request unless DEV_ALLOW_NO_AUTH applies. Rotating it signs everyone out.
   */
  BETTER_AUTH_SECRET?: string;
  /** OAuth apps. Each provider is offered only when both of its values are set. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Cloudflare Turnstile secret. Without it the magic-link endpoint fails closed. */
  TURNSTILE_SECRET_KEY?: string;
  RESEND_API_KEY?: string;
  /** Local dev only (.dev.vars): skip sign-in. Honoured only while BETTER_AUTH_SECRET is unset. */
  DEV_ALLOW_NO_AUTH?: string;
  /**
   * OpenRouter key of the built-in provider (`openrouter`), sold as prepaid
   * credit in both apps and used by the open pool. Never falls back to
   * OPENROUTER_API_KEY; set a credit limit on it in OpenRouter.
   * Its spend is billed at the reported cost grossed up by the `OPENROUTER_FEE_BPS`
   * var (OpenRouter's credit-purchase fee), then marked up.
   */
  OPENROUTER_SIMPLE_API_KEY?: string;
  /**
   * Polar organization access token (`polar_oat_…`), for the `polar` payment
   * provider (billing/providers/polar). Payments are on only when this and
   * POLAR_WEBHOOK_SECRET are set. Sandbox and production tokens differ.
   */
  POLAR_ACCESS_TOKEN?: string;
  /** Signing secret (`whsec_…`) of the Polar webhook endpoint `/api/webhooks/polar`. */
  POLAR_WEBHOOK_SECRET?: string;
  /**
   * A code users redeem (`POST /api/billing/membership/waiver`) to have the
   * membership fee waived. Empty = no code redemption. If it leaks, change it
   * and clear `auth_users.membership_waived` for whoever shouldn't have it.
   */
  MEMBERSHIP_WAIVER_CODE?: string;
  /**
   * Comma-separated Better Auth user ids of the operator's own accounts: they
   * may open the admin app (`/admin/`) and `/api/admin/*`, and may always
   * publish share links. A user id is an identifier, not a credential (being
   * admin still takes being signed in as that user), so it is stored as is; it
   * is a secret only to keep it out of wrangler.jsonc. Empty = no admins
   * (the local dev bypass is always admin, see auth/admin.ts).
   */
  ADMIN_USER_IDS?: string;
  /** Tests only ("true"): enables test-only RPC methods such as `PoolBank.expire(now)`. */
  TEST_SEAMS?: string;
  /** Tests only (with `PAYMENT_PROVIDER=fake`): the fake provider's options, JSON (billing/providers/fake.ts). */
  FAKE_PAYMENTS?: string;
  /** Tests only (with `TEST_SEAMS`): a pool notice version above the code's, as after a text change. */
  POOL_NOTICE_VERSION?: string;
}

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
   * The built-in provider (`tangent`, on OPENROUTER_SIMPLE_API_KEY) is in this
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
   * Who pays for the built-in provider's calls (auth/account.ts): `personal`
   * (the ledger at `billingAccountId`), `pool` (the open pool; Learn
   * only, `builtIn` when the pool is on) or `own-key` (Learn on the user's
   * key, where `builtIn` is false). Power is always `personal`.
   */
  funding: FundingSource;
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
