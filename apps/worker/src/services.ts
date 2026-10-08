import {
  ChatService,
  DEFAULT_CHAT_SETTINGS,
  estimateTokensUtf8,
  ShareService,
  type ChatSettings,
} from '@tangent/core';
import {
  createProviderRegistry,
  DEFAULT_PROVIDER_CONFIGS,
  parseProviderConfigs,
  type ProviderEnv,
} from '@tangent/providers';
import {
  DEFAULT_SYSTEM_PROMPT,
  LEARN_KEY_PROVIDER,
  LEGACY_BUILT_IN_PROVIDER_ID,
  type BranchFunding,
  type LlmProvider,
  type ProviderConfig,
  type ProviderInfo,
  type ProviderRegistry,
} from '@tangent/shared';
import { isAdminUserId } from './auth/admin.js';
import { groundingAllowance, groundingSettings } from './billing/grounding.js';
import { defaultRouteFacts } from './billing/gate.js';
import { createPoolUsageMeter, createUsageMeter, meteredRegistry } from './billing/meter.js';
import { paymentProvider, paymentsConfigured } from './billing/payments/index.js';
import { appConfig } from './config.js';
import { createD1Repositories } from './db/d1-repositories.js';
import { withModelWindows } from './model-windows.js';
import { isPoolFunded, type AccountContext, type AppEnv } from './env.js';
import { poolConfigProblem, type PoolParams } from './pool/params.js';
import {
  builtInPowerConfig,
  poolChatSettings,
  poolProviderConfig,
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
 * built-in provider is not one of them: Tangent credit is a registry of its
 * own (`creditRegistryFor`), even where both name the endpoint `openrouter`.
 * The legacy id `tangent` is reserved, since requests from older clients
 * still name it for the built-in endpoint on credit (`fromLegacyRoute`).
 */
export function providerConfigs(env: AppEnv): ProviderConfig[] {
  if (!env.PROVIDERS?.trim()) {
    return DEFAULT_PROVIDER_CONFIGS.map((c) =>
      c.id === LEARN_KEY_PROVIDER ? openrouterWithSuggestions(env, c) : c,
    );
  }
  const configs = parseProviderConfigs(env.PROVIDERS);
  if (configs.some((c) => c.id === LEGACY_BUILT_IN_PROVIDER_ID))
    throw new Error(
      `Invalid provider config: PROVIDERS may not use the reserved id "${LEGACY_BUILT_IN_PROVIDER_ID}"`,
    );
  return configs;
}

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
 * The default `openrouter` config with the suggested models (Learn's Normal and
 * Max, tagged with their tier) first, Normal as its default, and any model id
 * allowed: the easy way to use the suggested defaults on one's own OpenRouter key.
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
 * True when the `tangent` provider is usable with the operator's key (the
 * SIMPLE_PROVIDER override and its `apiKeySecret` respected), whoever pays.
 */
export function builtInProviderUsable(env: AppEnv): boolean {
  const registry = createProviderRegistry([simpleProviderConfig(env)], providerEnv(env));
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

/** Which service a request builds: `generating` = it will call a model (sends, context resolve). */
export interface ServiceScope {
  /**
   * Pool restrictions apply only to the services that generate: routes that
   * never call a model (`/api/providers`, creating trees and branches) keep the
   * simple config's models and default, so a pool session never writes the
   * pool model onto a tree or branch.
   */
  generating?: boolean;
}

/** The pool's parameters when `scope` generates on the pool, else null. */
function poolScope(account: AccountContext, scope: ServiceScope) {
  return scope.generating && isPoolFunded(account) ? account.pool : null;
}

/**
 * The providers of a request's own-key routes. Anyone can sign up, so the
 * operator's keys are withheld except through the built-in provider on a
 * funding that pays for it (`account.builtIn`, metered by chatService) and,
 * for the power configs, in the dev bypass (`operatorKeys`):
 * - simple, on credit or the pool: only the built-in config on the
 *   operator's key; user keys are ignored. A generating pool request gets the
 *   pool's config of it (`poolProviderConfig`). Learn pays per request, so
 *   this is its one registry, whatever a branch's funding says.
 * - simple, own key: the same provider config, on the user's OpenRouter key
 *   (key cookie entry LEARN_KEY_PROVIDER) and never the operator's.
 * - power: the configured providers, user keys overriding server secrets.
 *   Server secrets only for operatorKeys (the local dev bypass), and never
 *   the built-in key. Tangent credit is not in it: a branch on `credit`
 *   resolves in `creditRegistryFor`, so neither a user key nor another config
 *   can reach the operator's key, and no own-key call can be metered.
 */
export function registryFor(
  env: AppEnv,
  account: AccountContext,
  apiKeys?: UserApiKeys,
  scope: ServiceScope = {},
): ProviderRegistry {
  if (account.mode === 'simple') {
    const config = simpleProviderConfig(env);
    if (account.builtIn) {
      // On the pool, a generating request sees only the pool model, with its caps.
      const pool = poolScope(account, scope);
      return windowedRegistry(
        env,
        [pool ? poolProviderConfig(env, pool) : config],
        providerEnv(env),
      );
    }
    const own = apiKeys?.[LEARN_KEY_PROVIDER];
    return windowedRegistry(
      env,
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
  return windowedRegistry(env, configs, providerEnv(env, apiKeys, withheld));
}

/**
 * The providers of `configs`, with OpenRouter models budgeted on their real
 * context windows (model-windows.ts `withModelWindows`): every registry a
 * request generates through is built here.
 */
function windowedRegistry(
  env: AppEnv,
  configs: ProviderConfig[],
  penv: ProviderEnv,
): ProviderRegistry {
  return withModelWindows(createProviderRegistry(configs, penv), configs, env);
}

/**
 * Power's Tangent credit: the built-in endpoint (`builtInPowerConfig`) on
 * the operator's key, for branches and reviewers whose funding is `credit`.
 * Built without the user's keys, so a credit call can never use them. Null
 * where the server doesn't offer credit (`account.builtIn` false), and for
 * Learn, whose one registry (`registryFor`) serves every funding.
 */
export function creditRegistryFor(env: AppEnv, account: AccountContext): ProviderRegistry | null {
  if (account.mode === 'simple' || !account.builtIn) return null;
  return windowedRegistry(env, [builtInPowerConfig(env)], providerEnv(env));
}

/**
 * The registry a route of `funding` resolves in: Learn's one registry
 * whatever the funding; in power, the own-key registry or Tangent credit
 * (null where credit isn't offered).
 */
export function routeRegistryFor(
  env: AppEnv,
  account: AccountContext,
  funding: BranchFunding,
  apiKeys?: UserApiKeys,
  scope: ServiceScope = {},
): ProviderRegistry | null {
  if (account.mode === 'simple' || funding === 'own-key')
    return registryFor(env, account, apiKeys, scope);
  return creditRegistryFor(env, account);
}

/**
 * What `GET /api/providers` lists: the own-key registry (Learn: its one
 * entry, without a funding, since Learn pays per request), then, in power
 * where it is offered, the built-in endpoint again as Tangent credit
 * (`funding: 'credit'`, taking no user key). A client picks an entry by its
 * id and funding.
 */
export function providersFor(
  env: AppEnv,
  account: AccountContext,
  apiKeys?: UserApiKeys,
): ProviderInfo[] {
  const own = registryFor(env, account, apiKeys).list();
  if (account.mode === 'simple') return own;
  const credit = creditRegistryFor(env, account)?.list() ?? [];
  return [
    ...own.map((p) => ({ ...p, funding: 'own-key' as const })),
    ...credit.map((p) => ({ ...p, acceptsUserKey: false, funding: 'credit' as const })),
  ];
}

export function chatSettingsFor(
  env: AppEnv,
  account: AccountContext,
  scope: ServiceScope = {},
): ChatSettings {
  const pool = poolScope(account, scope);
  if (pool) return poolChatSettings(pool);
  if (account.mode === 'simple') return simpleChatSettings(env);
  const summaryProviderId = env.SUMMARY_PROVIDER_ID?.trim() || null;
  return {
    ...DEFAULT_CHAT_SETTINGS,
    // A summary provider is looked up among the own-key routes only (ChatService), so
    // summaries of branches on the user's own keys never cost credit. The legacy
    // `tangent` id named Tangent credit: it means "no summary provider".
    summaryProviderId: summaryProviderId === LEGACY_BUILT_IN_PROVIDER_ID ? null : summaryProviderId,
    summaryModel: env.SUMMARY_MODEL?.trim() || null,
    autoTitle: env.AUTO_TITLE !== 'false',
    grounding: groundingSettings(env, 'power'),
  };
}

/**
 * Built-in system prompt of an account's new trees, used when the request
 * names none and the account has none saved (GET/PATCH /api/settings). Both
 * modes share DEFAULT_SYSTEM_PROMPT; only Learn honours the operator's
 * SIMPLE_SYSTEM_PROMPT, since power users can set their own. A generating
 * pool request uses the pool's locked prompt (which also replaces the tree's).
 */
export function defaultSystemPromptFor(
  env: AppEnv,
  account: AccountContext,
  scope: ServiceScope = {},
): string {
  const pool = poolScope(account, scope);
  if (pool) return pool.systemPrompt;
  return account.mode === 'simple' ? simpleSystemPrompt(env) : DEFAULT_SYSTEM_PROMPT;
}

export interface ChatServiceOptions extends ServiceScope {
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
 * Every call through `inner` is metered: its `stream()` records a
 * `usage_events` row (billing/meter.ts) on the user's ledger, or reserves it
 * on the open pool when the account is pool-funded. `inner` is a
 * registry whose every route is paid on the operator's key: Learn's on credit
 * or the pool, or power's Tangent credit (`creditRegistryFor`); a registry of
 * the user's own keys is never wrapped. The meter is built on the first
 * `get`, so routes that never generate (listing trees, reading providers)
 * don't pay for it.
 */
function meteredLazily(
  inner: ProviderRegistry,
  env: AppEnv,
  account: AccountContext,
  defer: Defer,
): ProviderRegistry {
  let metered: ProviderRegistry | null = null;
  const meter = () => {
    if (!isPoolFunded(account)) return createUsageMeter(env, account, defer);
    if (!account.userId) throw new Error('The open pool needs a signed-in user');
    return createPoolUsageMeter(env, account.pool, account.userId, defer);
  };
  return {
    get: (providerId) => {
      metered ??= meteredRegistry(inner, meter(), () => true);
      return metered.get(providerId);
    },
    list: () => inner.list(),
    defaultProviderId: () => inner.defaultProviderId(),
  };
}

/**
 * Every call through `inner` uses `model`, whatever the request says: the
 * backstop of the pool's pinned model (ChatService pins it too). It wraps the
 * meter, so the meter only ever sees the pinned model.
 */
export function pinnedModelRegistry(inner: ProviderRegistry, model: string): ProviderRegistry {
  const cache = new WeakMap<LlmProvider, LlmProvider>();
  return {
    get(providerId) {
      const provider = inner.get(providerId);
      if (!provider) return provider;
      let pinned = cache.get(provider);
      if (!pinned) {
        pinned = {
          get id() {
            return provider.id;
          },
          get kind() {
            return provider.kind;
          },
          get label() {
            return provider.label;
          },
          models: () => provider.models(),
          defaultModel: () => provider.defaultModel(),
          capabilities: () => provider.capabilities(model),
          stream: (request) => provider.stream({ ...request, model }),
        };
        const resolve = provider.resolveCapabilities?.bind(provider);
        if (resolve) pinned.resolveCapabilities = () => resolve(model);
        const count = provider.countTokens?.bind(provider);
        if (count) pinned.countTokens = (request) => count({ ...request, model });
        cache.set(provider, pinned);
      }
      return pinned;
    },
    list: () => inner.list(),
    defaultProviderId: () => inner.defaultProviderId(),
  };
}

/**
 * The providers of a generating pool-funded request (the chat service's, and
 * the pool's topic classifier, pool/tagging.ts): the pool's config of the
 * built-in provider, every call reserved and settled on the pool, and pinned
 * to the pool model. `inner` is the unmetered registry (tests pass a
 * recording one).
 */
export function poolGeneratingRegistry(
  env: AppEnv,
  account: AccountContext & { pool: PoolParams },
  defer: Defer,
  inner: ProviderRegistry = registryFor(env, account, undefined, { generating: true }),
): ProviderRegistry {
  return pinnedModelRegistry(meteredLazily(inner, env, account, defer), account.pool.model);
}

/**
 * The only place Worker env is translated into a ChatService for an account.
 * A `generating` service of a pool-funded account runs under the pool's
 * restrictions: its model, locked system prompt, input and output caps.
 */
export function chatService(
  env: AppEnv,
  account: AccountContext,
  opts: ChatServiceOptions = {},
): ChatService {
  const scope: ServiceScope = { generating: opts.generating === true };
  const pool = poolScope(account, scope);
  const registry = registryFor(env, account, opts.apiKeys, scope);
  const defer = opts.defer ?? detach;
  let providers = registry;
  let creditProviders: ProviderRegistry | null = null;
  if (account.mode === 'simple') {
    // Learn's one registry is on the operator's key exactly when the request pays with credit or the pool.
    if (pool) providers = poolGeneratingRegistry(env, { ...account, pool }, defer, registry);
    else if (account.builtIn) providers = meteredLazily(registry, env, account, defer);
  } else {
    // Power: own keys unmetered; Tangent credit, every call metered.
    const credit = creditRegistryFor(env, account);
    if (credit) creditProviders = meteredLazily(credit, env, account, defer);
  }
  return new ChatService({
    repos: createD1Repositories(env.DB),
    accountId: account.id,
    providers,
    ...(creditProviders
      ? {
          creditProviders,
          // A new tree's default route starts on credit only when it can pay (docs/DECISIONS.md).
          defaultRouteFacts: () => defaultRouteFacts(env, account),
        }
      : {}),
    // Learn pays per request: branch funding is ignored and written as `own-key`.
    // Imports into Learn are adapted to its provider, models, context and prompt.
    ...(account.mode === 'simple'
      ? { fixedFunding: 'own-key' as const, adaptImportsForLearn: true }
      : {}),
    settings: chatSettingsFor(env, account, scope),
    defaultSystemPrompt: defaultSystemPromptFor(env, account, scope),
    ...(pool
      ? {
          pinnedModel: pool.model,
          systemPromptOverride: pool.systemPrompt,
          // Budgets and summary prompts in UTF-8 bytes, so the pool's context limit is a hard bound.
          inputBound: { estimateTokens: estimateTokensUtf8 },
          // A client-set anchor quote gets no more room than a message.
          anchorQuoteMaxChars: pool.maxMessageChars,
        }
      : {}),
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
