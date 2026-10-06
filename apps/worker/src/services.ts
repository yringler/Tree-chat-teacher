import { ChatService, DEFAULT_CHAT_SETTINGS, ShareService, type ChatSettings } from '@tangent/core';
import {
  createProviderRegistry,
  DEFAULT_PROVIDER_CONFIGS,
  parseProviderConfigs,
  type ProviderEnv,
} from '@tangent/providers';
import {
  DEFAULT_SYSTEM_PROMPT,
  LEARN_KEY_PROVIDER,
  type ProviderConfig,
  type ProviderRegistry,
} from '@tangent/shared';
import { isAdminUserId } from './auth/admin.js';
import { groundingAllowance, groundingSettings } from './billing/grounding.js';
import { createUsageMeter, meteredRegistry } from './billing/meter.js';
import { billingConfigured } from './billing/stripe.js';
import { createD1Repositories } from './db/d1-repositories.js';
import { isMetered, type AccountContext, type AppEnv } from './env.js';
import {
  BUILT_IN_PROVIDER_ID,
  builtInPowerConfig,
  simpleChatSettings,
  simpleProviderConfig,
  simpleSystemPrompt,
  suggestedModels,
} from './simple-mode.js';

/** Provider id → user-supplied API key (bring-your-own-key, see byok/keys.ts). */
export type UserApiKeys = Readonly<Record<string, string>>;

/** Keeps background work alive past the response (`waitUntil` of the Worker or the Durable Object). */
export type Defer = (p: Promise<unknown>) => void;

/**
 * Power-mode provider configs, for the user's own keys: the PROVIDERS var, or
 * the defaults with OpenRouter opened up (`openrouterWithSuggestions`). The
 * built-in provider is not one of them (registryFor appends it), so its id is
 * reserved: metering is keyed on it.
 */
export function providerConfigs(env: AppEnv): ProviderConfig[] {
  if (!env.PROVIDERS?.trim()) {
    return DEFAULT_PROVIDER_CONFIGS.map((c) =>
      c.id === LEARN_KEY_PROVIDER ? openrouterWithSuggestions(env, c) : c,
    );
  }
  const configs = parseProviderConfigs(env.PROVIDERS);
  if (configs.some((c) => c.id === BUILT_IN_PROVIDER_ID))
    throw new Error(
      `Invalid provider config: PROVIDERS may not use the reserved id "${BUILT_IN_PROVIDER_ID}"`,
    );
  return configs;
}

/**
 * The default `openrouter` config with the suggested models (Learn's Smart and
 * Simple) first, the smart one as its default, and any model id allowed: the
 * easy way to use the suggested defaults on one's own OpenRouter key.
 */
function openrouterWithSuggestions(env: AppEnv, config: ProviderConfig): ProviderConfig {
  const suggested = suggestedModels(env);
  const ids = new Set(suggested.map((m) => m.id));
  return {
    ...config,
    models: [...suggested, ...config.models.filter((m) => !ids.has(m.id))],
    defaultModel: suggested[0]!.id,
    openModels: true,
  };
}

/**
 * Secrets and vars share the env object; providers look up only the names
 * they are configured with. `withheld` names secrets this request may not
 * use (the operator's keys, see registryFor): providers that need one then
 * report unavailable, or take the user's key.
 */
export function providerEnv(
  env: AppEnv,
  apiKeys?: UserApiKeys,
  withheld: ReadonlySet<string> = new Set(),
): ProviderEnv {
  const secrets: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    // The cookie-sealing secret is never a provider credential.
    if (typeof v === 'string' && k !== 'KEY_ENCRYPTION_SECRET' && !withheld.has(k)) secrets[k] = v;
  }
  return apiKeys ? { secrets, apiKeys } : { secrets };
}

/** The secret behind the built-in provider; only ever used through it. */
const SIMPLE_KEY_SECRET = 'OPENROUTER_SIMPLE_API_KEY';

function apiKeySecrets(configs: readonly ProviderConfig[]): string[] {
  return configs.flatMap((c) => (c.apiKeySecret ? [c.apiKeySecret] : []));
}

/**
 * Public share links are offered only once the operator has registered a DMCA
 * designated agent (`DMCA_AGENT_REGISTERED` = "true"): without it, hosting
 * what users publish carries no safe harbor. Off = no links are created or
 * served; exporting a conversation as a file still works.
 */
export function sharingEnabled(env: AppEnv): boolean {
  return env.DMCA_AGENT_REGISTERED?.trim().toLowerCase() === 'true';
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
 * True when the built-in provider can be offered on credit: billing is
 * configured and the `tangent` provider is usable with the operator's key.
 * Otherwise it is in no power registry, and Learn is bring-your-own-key only.
 */
export function builtInAvailable(env: AppEnv): boolean {
  if (!billingConfigured(env)) return false;
  const registry = createProviderRegistry([simpleProviderConfig(env)], providerEnv(env));
  return registry.list()[0]?.available ?? false;
}

/**
 * The providers a request may use. Anyone can sign up, so the operator's keys
 * are withheld except through the built-in provider (`account.builtIn`, metered
 * by chatService) and, for the power configs, in the dev bypass (`operatorKeys`):
 * - simple, on credit: only the `tangent` provider on the operator's key;
 *   user keys are ignored.
 * - simple, own key: the same provider config, on the user's OpenRouter key
 *   (key cookie entry LEARN_KEY_PROVIDER) and never the operator's.
 * - power: the configured providers, user keys overriding server secrets.
 *   Server secrets only for operatorKeys (the local dev bypass), and never
 *   the built-in key. When `account.builtIn`, the built-in provider follows
 *   (`builtInPowerConfig`), in a registry of its own on the operator's key,
 *   so neither a user key nor another config can reach that key.
 */
export function registryFor(
  env: AppEnv,
  account: AccountContext,
  apiKeys?: UserApiKeys,
): ProviderRegistry {
  if (account.mode === 'simple') {
    const config = simpleProviderConfig(env);
    if (account.builtIn) return createProviderRegistry([config], providerEnv(env));
    const own = apiKeys?.[LEARN_KEY_PROVIDER];
    return createProviderRegistry(
      [config],
      providerEnv(
        env,
        own ? { [config.id]: own } : undefined,
        new Set([SIMPLE_KEY_SECRET, ...apiKeySecrets([config])]),
      ),
    );
  }
  const configs = providerConfigs(env);
  const withheld = new Set([SIMPLE_KEY_SECRET]);
  if (!account.operatorKeys) for (const name of apiKeySecrets(configs)) withheld.add(name);
  const own = createProviderRegistry(configs, providerEnv(env, apiKeys, withheld));
  if (!account.builtIn) return own;
  return withBuiltIn(own, createProviderRegistry([builtInPowerConfig(env)], providerEnv(env)));
}

/**
 * `own` followed by the built-in provider, which takes no user key in power
 * (it is paid with credit; /api/key has no entry for it). The default provider
 * is chosen as one registry would: the first available non-fake provider (so
 * the built-in one only when none of the user's own is usable), else `own`'s.
 */
function withBuiltIn(own: ProviderRegistry, builtIn: ProviderRegistry): ProviderRegistry {
  const list = () => [
    ...own.list(),
    ...builtIn.list().map((p) => ({ ...p, acceptsUserKey: false })),
  ];
  return {
    get: (providerId) =>
      providerId === BUILT_IN_PROVIDER_ID ? builtIn.get(providerId) : own.get(providerId),
    list,
    defaultProviderId: () =>
      list().find((p) => p.available && p.kind !== 'fake')?.id ?? own.defaultProviderId(),
  };
}

export function chatSettingsFor(env: AppEnv, account: AccountContext): ChatSettings {
  if (account.mode === 'simple') return simpleChatSettings(env);
  const summaryProviderId = env.SUMMARY_PROVIDER_ID?.trim() || null;
  return {
    ...DEFAULT_CHAT_SETTINGS,
    // Never the built-in provider: summaries of branches on the user's own keys must not cost credit.
    summaryProviderId: summaryProviderId === BUILT_IN_PROVIDER_ID ? null : summaryProviderId,
    summaryModel: env.SUMMARY_MODEL?.trim() || null,
    autoTitle: env.AUTO_TITLE !== 'false',
    grounding: groundingSettings(env, 'power'),
  };
}

/**
 * Built-in system prompt of an account's new trees, used when the request
 * names none and the account has none saved (GET/PATCH /api/settings). Both
 * modes share DEFAULT_SYSTEM_PROMPT; only Learn honours the operator's
 * SIMPLE_SYSTEM_PROMPT, since power users can set their own.
 */
export function defaultSystemPromptFor(env: AppEnv, account: AccountContext): string {
  return account.mode === 'simple' ? simpleSystemPrompt(env) : DEFAULT_SYSTEM_PROMPT;
}

export interface ChatServiceOptions {
  /** Bring-your-own-key overrides (ignored by Learn on credit, see registryFor). */
  apiKeys?: UserApiKeys;
  /** Where the usage meter parks its background work (built-in provider calls). */
  defer?: Defer;
}

/** Last resort when a caller has no `waitUntil`: the work still runs, failures are logged. */
const detach: Defer = (p) => {
  p.catch((err: unknown) => console.error('Deferred usage work failed', err));
};

/**
 * Every call on the built-in provider is metered: its `stream()` records a
 * `usage_events` row (billing/meter.ts); the account's other providers are
 * passed through. The meter is built on the first `get`, so routes that never
 * generate (listing trees, reading providers) don't pay for it.
 */
function meteredLazily(
  inner: ProviderRegistry,
  env: AppEnv,
  account: AccountContext,
  defer: Defer,
): ProviderRegistry {
  let metered: ProviderRegistry | null = null;
  return {
    get: (providerId) => {
      metered ??= meteredRegistry(inner, createUsageMeter(env, account, defer), (id) =>
        isMetered(account, id),
      );
      return metered.get(providerId);
    },
    list: () => inner.list(),
    defaultProviderId: () => inner.defaultProviderId(),
  };
}

/** The only place Worker env is translated into a ChatService for an account. */
export function chatService(
  env: AppEnv,
  account: AccountContext,
  opts: ChatServiceOptions = {},
): ChatService {
  const registry = registryFor(env, account, opts.apiKeys);
  return new ChatService({
    repos: createD1Repositories(env.DB),
    accountId: account.id,
    providers: account.builtIn
      ? meteredLazily(registry, env, account, opts.defer ?? detach)
      : registry,
    settings: chatSettingsFor(env, account),
    defaultSystemPrompt: defaultSystemPromptFor(env, account),
    groundingAllowance: groundingAllowance(env, account),
  });
}

export function shareService(env: AppEnv, requestUrl: string, accountId?: string): ShareService {
  const base = env.PUBLIC_BASE_URL?.trim() || new URL(requestUrl).origin;
  return new ShareService({
    repos: createD1Repositories(env.DB),
    publicBaseUrl: base,
    ...(accountId ? { accountId } : {}),
  });
}
