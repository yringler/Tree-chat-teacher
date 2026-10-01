import type { AccountMode } from '@tangent/shared';
import type { Context } from 'hono';

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
   * OpenRouter key for simple-mode generations (provider `tangent`). Never
   * falls back to OPENROUTER_API_KEY; set a credit limit on it in OpenRouter.
   */
  OPENROUTER_SIMPLE_API_KEY?: string;
  /** Stripe API key. Billing is enabled only when this and STRIPE_WEBHOOK_SECRET are set. */
  STRIPE_SECRET_KEY?: string;
  /** Signing secret of the webhook endpoint `/api/auth/stripe/webhook`. */
  STRIPE_WEBHOOK_SECRET?: string;
}

/**
 * The account a request acts as (see auth/account.ts).
 * - `power`: the shared `default` account of allowlisted users (own keys, unmetered).
 * - `simple`: a personal account `u_<userId>` of an open sign-up (operator key, metered).
 */
export interface AccountContext {
  id: string;
  mode: AccountMode;
  /** Better Auth user id; null in dev bypass mode. */
  userId: string | null;
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
