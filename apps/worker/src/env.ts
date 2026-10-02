import type { AccountMode } from '@tangent/shared';
import type { Context } from 'hono';
import { BUILT_IN_PROVIDER_ID } from './simple-mode.js';

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
   * OpenRouter key of the built-in provider `tangent`, sold as prepaid credit
   * in both apps (the name predates power mode using it). Never falls back to
   * OPENROUTER_API_KEY; set a credit limit on it in OpenRouter.
   * Its spend is billed at the reported cost grossed up by the `OPENROUTER_FEE_BPS`
   * var (OpenRouter's credit-purchase fee), then marked up.
   */
  OPENROUTER_SIMPLE_API_KEY?: string;
  /** Stripe API key. Billing is enabled only when this and STRIPE_WEBHOOK_SECRET are set. */
  STRIPE_SECRET_KEY?: string;
  /** Signing secret of the webhook endpoint `/api/auth/stripe/webhook`. */
  STRIPE_WEBHOOK_SECRET?: string;
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
}

/**
 * True when a call on `providerId` is metered and charged to the account's
 * credit: only the built-in provider, and only where the account has it on
 * the operator's key. Metering is per provider call, not per account.
 */
export function isMetered(account: AccountContext, providerId: string): boolean {
  return account.builtIn && providerId === BUILT_IN_PROVIDER_ID;
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
