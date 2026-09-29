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
}

/** Caller identity established by the Access middleware for `/api/*`. */
export interface Identity {
  /** Access-verified email; null in dev bypass mode or for service tokens. */
  email: string | null;
  /** True only when DEV_ALLOW_NO_AUTH is honoured (ACCESS_AUD empty). */
  devMode: boolean;
}

export interface AppVariables {
  identity: Identity;
  /** Account the request acts as (see auth/account.ts). */
  accountId: string;
}

export interface AppBindings {
  Bindings: AppEnv;
  Variables: AppVariables;
}

export type AppContext = Context<AppBindings>;
