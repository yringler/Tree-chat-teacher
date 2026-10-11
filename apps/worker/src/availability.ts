// What this deployment offers, as pure predicates of its config (and, for
// sharing, one auth_users row): sharing, Tangent credit, the open pool. A
// leaf, so the auth, billing and page modules that ask can't close an import
// cycle through the registries.
import { createProviderRegistry } from '@tangent/providers';
import type { SharingMode } from '@tangent/shared';
import { isAdminUserId } from './auth/admin.js';
import { paymentProvider, paymentsConfigured } from './billing/payments/index.js';
import { appConfig } from './config.js';
import type { SqlRow } from './db/rows.js';
import type { authUsers } from './db/schema.js';
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
 * Who may publish share links (`SHARING`): `everyone`; `allowlist`, admins
 * and the users the operator allowed; or `off`, nobody, so the operator can
 * take every link down at once. Exporting a conversation as a file works in
 * every mode.
 */
export function sharingMode(env: AppEnv): SharingMode {
  return appConfig(env).site.sharing;
}

/**
 * Whether the user may publish share links, and whether their links open:
 * nobody under `off`, admins included; nobody whose sharing an admin or the
 * strike rule suspended (`auth_users.sharing_suspended`); everyone else under
 * `everyone`; under `allowlist` only admins (ADMIN_USER_IDS) and the users
 * the operator allowed on the admin page (`auth_users.share_allowed`).
 * `userId` null is the dev bypass, which follows the mode only (so the
 * allowlist path can be tried locally), like its account's links. One query
 * unless sharing is off.
 */
export async function canShare(env: AppEnv, userId: string | null): Promise<boolean> {
  const mode = sharingMode(env);
  if (mode === 'off') return false;
  if (!userId) return mode === 'everyone';
  const row = await env.DB.prepare(
    'SELECT share_allowed, sharing_suspended FROM auth_users WHERE id = ?',
  )
    .bind(userId)
    .first<Pick<SqlRow<typeof authUsers>, 'share_allowed' | 'sharing_suspended'>>();
  if (row?.sharing_suspended === 1) return false;
  if (mode === 'everyone' || isAdminUserId(env, userId)) return true;
  return row?.share_allowed === 1;
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
