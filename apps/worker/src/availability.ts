// What this deployment offers, as pure predicates of its config (and, for
// sharing, one auth_users row): sharing, Tangent credit, the open pool. A
// leaf, so the auth, billing and page modules that ask can't close an import
// cycle through the registries.
import { createProviderRegistry } from '@tangent/providers';
import { isAdminUserId } from './auth/admin.js';
import { paymentProvider, paymentsConfigured } from './billing/payments/index.js';
import { appConfig } from './config.js';
import type { AppEnv } from './env.js';
import { poolConfigProblem } from './pool/params.js';
import { providerConfigs, providerEnv } from './provider-configs.js';
import { simpleProviderConfig } from './simple-mode.js';

/**
 * The providers power mode takes the user's own keys for, as the public pages
 * name them (`Anthropic`, `OpenAI`, `OpenRouter`), and whether each can search
 * the web; empty when PROVIDERS is invalid, so a page can fall back to a
 * generic phrase instead of failing.
 */
export function ownKeyProviders(env: AppEnv): { id: string; label: string; search: boolean }[] {
  try {
    return providerConfigs(env).map(({ id, label, options }) => ({
      id,
      label,
      search: options?.['webSearch'] === true,
    }));
  } catch {
    return [];
  }
}

/**
 * Public share links are offered only once the operator has registered a DMCA
 * designated agent (`DMCA_AGENT_REGISTERED` is true): without it, hosting
 * what users publish carries no safe harbor. Off = no links are created or
 * served; exporting a conversation as a file still works.
 */
export function sharingEnabled(env: AppEnv): boolean {
  return appConfig(env).site.sharingEnabled;
}

/**
 * Whether the user may publish share links, and whether their links open:
 * everyone while sharing is on (`sharingEnabled`); otherwise only admins
 * (ADMIN_USER_IDS) and the users the operator allowed on the admin page
 * (`auth_users.share_allowed`). `userId` null is the dev bypass, which follows
 * the global flag only (so the off path can be tried locally), like its
 * `default` / `default_simple` accounts' links. One query, none while sharing
 * is on.
 */
export async function canShare(env: AppEnv, userId: string | null): Promise<boolean> {
  if (sharingEnabled(env)) return true;
  if (!userId) return false;
  if (isAdminUserId(env, userId)) return true;
  const row = await env.DB.prepare('SELECT share_allowed AS allowed FROM auth_users WHERE id = ?')
    .bind(userId)
    .first<{ allowed: number }>();
  return row?.allowed === 1;
}

/**
 * True when the `tangent` provider is usable with the operator's key (the
 * BUILT_IN_PROVIDER override and its `apiKeySecret` respected), whoever pays.
 */
export function builtInProviderUsable(env: AppEnv): boolean {
  const configs = [simpleProviderConfig(env)];
  const registry = createProviderRegistry(configs, providerEnv(env, configs));
  return registry.list()[0]?.available ?? false;
}

/**
 * Personal credit may be spent: a payment provider is configured, or the
 * operator lets granted credit be spent without one (`PERSONAL_CREDIT_ENABLED`).
 */
export function personalCreditReady(env: AppEnv): boolean {
  return paymentsConfigured(env) || appConfig(env).flags.personalCreditEnabled;
}

/**
 * True when the built-in provider can be offered on credit: personal credit
 * is ready and the `tangent` provider is usable with the operator's key.
 * Otherwise it is in no power registry, and Learn is bring-your-own-key (or
 * the open pool) only.
 */
export function builtInAvailable(env: AppEnv): boolean {
  return personalCreditReady(env) && builtInProviderUsable(env);
}

/**
 * True when prepaid credit is sold: the built-in provider is offered and the
 * payment provider sells top-ups. The public pages offer credit only then.
 */
export function creditSold(env: AppEnv): boolean {
  return builtInAvailable(env) && (paymentProvider(env)?.capabilities.topUps ?? false);
}

/**
 * True when Learn may spend from the open pool: `POOL_ENABLED`, the
 * `tangent` provider is usable, and the pool's caps admit a reply
 * (`poolConfigProblem`, logged). Billing is not needed to spend from it.
 */
export function poolAvailable(env: AppEnv): boolean {
  return (
    appConfig(env).flags.poolEnabled &&
    builtInProviderUsable(env) &&
    poolConfigProblem(env) === null
  );
}
