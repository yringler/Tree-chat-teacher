// The composition root: the provider registries a request generates through
// (own keys, Tangent credit, the open pool; metered, pinned and windowed
// where they pay on the operator's key) and the ChatService and ShareService
// built on them. What the deployment offers at all is availability.ts.
import {
  ChatService,
  appChatSettings,
  estimateTokensUtf8,
  ShareService,
  type ChatSettings,
  type GenerationProfile,
  type ShareServiceDeps,
} from '@tangent/core';
import { createProviderRegistry, decorateProvider } from '@tangent/providers';
import {
  DEFAULT_SYSTEM_PROMPT,
  type BranchFunding,
  type LearnReplySettings,
  type LlmProvider,
  type ProviderConfig,
  type ProviderInfo,
  type ProviderRegistry,
} from '@tangent/shared';
import { defaultRouteFacts } from './billing/default-route.js';
import { groundingAllowance, groundingPolicy, withSearchOptions } from './billing/grounding.js';
import { meteredRegistry } from './billing/meter.js';
import { createUsageMeter } from './billing/personal-meter.js';
import { appConfig, BUILT_IN_ANTHROPIC_API_KEY_SECRET, BUILT_IN_API_KEY_SECRET } from './config.js';
import { createD1Repositories } from './db/d1-repositories.js';
import { hostedLegs } from './hosted/legs.js';
import { withModelWindows } from './model-windows.js';
import { createPoolUsageMeter } from './pool/meter.js';
import {
  callPayer,
  isPoolFunded,
  learnOwnKey,
  type AccountContext,
  type AppEnv,
  type PoolAccount,
} from './env.js';
import {
  apiKeySecrets,
  learnKeyConfig,
  providerConfigs,
  providerEnv,
  type UserApiKeys,
} from './provider-configs.js';
import {
  builtInPowerConfig,
  poolChatSettings,
  poolProviderConfig,
  simpleChatSettings,
  simpleMaxInputTokens,
  simpleProviderConfig,
  simpleSystemPrompt,
} from './simple-mode.js';
import { logEvent } from './log.js';

/** Keeps background work alive past the response (`waitUntil` of the Worker or the Durable Object). */
export type Defer = (p: Promise<unknown>) => void;

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

/**
 * The operator's keys behind the built-in provider: withheld from every
 * registry of the user's own keys, whatever secret a config there names.
 */
const OPERATOR_KEY_SECRETS: readonly string[] = [
  BUILT_IN_API_KEY_SECRET,
  BUILT_IN_ANTHROPIC_API_KEY_SECRET,
];

/** The pool's parameters when `scope` generates on the pool, else null. */
function poolScope(account: AccountContext, scope: ServiceScope) {
  return scope.generating && isPoolFunded(account) ? account.pool : null;
}

/**
 * The providers of a request's own-key routes. Anyone can sign up, so the
 * operator's keys are withheld except through the built-in provider on a
 * payer that pays for it (`callPayer`: credit or the pool, metered by
 * chatService) and, for the power configs, in the dev bypass (`operatorKeys`):
 * - simple, on credit or the pool: only the built-in config on the
 *   operator's key; user keys are ignored. A generating pool request gets the
 *   pool's config of it (`poolProviderConfig`). Learn pays per request, so
 *   this is its one registry, whatever a branch's funding says.
 * - simple, own key: the config of the learner's chosen own key
 *   (`learnKeyConfig`): the same built-in config on their OpenRouter key, or
 *   power's Anthropic endpoint on their Anthropic key with Learn's one
 *   Anthropic model (key cookie entry = the provider id), never the
 *   operator's key.
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
    // Learn pays per request, whatever the route's funding.
    if (callPayer(account, 'own-key') !== 'own-key') {
      // On the pool, a generating request sees only the pool model, with its caps.
      const pool = poolScope(account, scope);
      return windowedRegistry(env, [pool ? poolProviderConfig(env, pool) : config]);
    }
    const ownKey = learnOwnKey(account);
    const ownConfig = learnKeyConfig(env, ownKey);
    // resolveAccount names only an offered key; replying on another endpoint than the one
    // the chat settings title and summarise on would be a silent mismatch.
    if (!ownConfig) throw new Error(`Learn's own key "${ownKey}" is not offered here`);
    const own = apiKeys?.[ownConfig.id];
    return windowedRegistry(
      env,
      [ownConfig],
      own ? { [ownConfig.id]: own } : undefined,
      new Set([...OPERATOR_KEY_SECRETS, ...apiKeySecrets([ownConfig])]),
    );
  }
  const configs = providerConfigs(env);
  const withheld = new Set(OPERATOR_KEY_SECRETS);
  if (!account.operatorKeys) for (const name of apiKeySecrets(configs)) withheld.add(name);
  return windowedRegistry(env, configs, apiKeys, withheld);
}

/**
 * The providers of `configs`, with OpenRouter models budgeted on their real
 * context windows (model-windows.ts `withModelWindows`) and searching as the
 * `GROUNDING_*` vars say (`withSearchOptions`): every registry a request
 * generates through is built here. `apiKeys` and `withheld` as in
 * `providerEnv`.
 */
function windowedRegistry(
  env: AppEnv,
  configs: ProviderConfig[],
  apiKeys?: UserApiKeys,
  withheld?: ReadonlySet<string>,
): ProviderRegistry {
  const searching = withSearchOptions(env, configs);
  const registry = createProviderRegistry(
    searching,
    providerEnv(env, searching, apiKeys, withheld),
  );
  return withModelWindows(registry, searching, env);
}

/**
 * Power's Tangent credit: the built-in endpoint (`builtInPowerConfig`) on
 * the operator's key, for branches and reviewers whose funding is `credit`.
 * Built without the user's keys, so a credit call can never use them. Null
 * where the server doesn't offer credit (`creditOffered` false), and for
 * Learn, whose one registry (`registryFor`) serves every funding.
 */
export function creditRegistryFor(env: AppEnv, account: AccountContext): ProviderRegistry | null {
  if (account.mode === 'simple' || !account.creditOffered) return null;
  return windowedRegistry(env, [builtInPowerConfig(env)]);
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
  learnReply?: LearnReplySettings,
): ChatSettings {
  const pool = poolScope(account, scope);
  if (pool) return poolChatSettings(pool);
  if (account.mode === 'simple')
    return simpleChatSettings(env, learnOwnKey(account), learnReply?.replyLength);
  const { summaryProviderId, summaryModel, autoTitle } = appConfig(env).power;
  // A summary provider is looked up among the own-key routes only (ChatService), so
  // summaries of branches on the user's own keys never cost credit.
  return appChatSettings('power', {
    summaryProviderId,
    summaryModel,
    autoTitle,
    groundingPolicy: groundingPolicy(env),
  });
}

/**
 * The built-in system prompt: power sends it for a tree without its own
 * prompt while the account has none saved (GET/PATCH /api/settings), and in
 * Learn it is the tutor prompt every reply starts with (`LearnProfile`).
 * Both modes share DEFAULT_SYSTEM_PROMPT; only Learn honours the operator's
 * LEARN_SYSTEM_PROMPT, since power users can set their own. A generating pool
 * request uses the pool's locked prompt (which also replaces the tree's).
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
  /**
   * The learner's reply settings for a Learn send (`LearnProfile.reply`),
   * read once by the route so the gate, the hold and the reply agree.
   * Ignored by power and on the pool, whose model and limits are fixed.
   */
  learnReply?: LearnReplySettings;
}

/** Last resort when a caller has no `waitUntil`: the work still runs, failures are logged. */
const detach: Defer = (p) => {
  p.catch((err: unknown) => logEvent('error', 'deferred_work_failed', { error: err }));
};

/**
 * Every call through `inner` is metered: its `stream()` records a
 * `usage_events` row (billing/meter.ts) on the user's ledger, or reserves it
 * on the open pool when the account is pool-funded, and runs on the call's
 * hosted backends (hosted/legs.ts). `inner` is a
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
    return createPoolUsageMeter(env, account.pool, account.userId, defer);
  };
  return {
    get: (providerId) => {
      metered ??= meteredRegistry(inner, meter(), () => true, hostedLegs(env));
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
        const resolve = provider.resolveCapabilities?.bind(provider);
        const count = provider.countTokens?.bind(provider);
        pinned = decorateProvider(provider, {
          capabilities: () => provider.capabilities(model),
          stream: (request) => provider.stream({ ...request, model }),
          resolveCapabilities: resolve && (() => resolve(model)),
          countTokens: count && ((request) => count({ ...request, model })),
        });
        cache.set(provider, pinned);
      }
      return pinned;
    },
    list: () => inner.list(),
    defaultProviderId: () => inner.defaultProviderId(),
  };
}

/**
 * The providers of a generating pool-funded request: the pool's config of the
 * built-in provider, every call reserved and settled on the pool, and pinned
 * to the pool model. `inner` is the unmetered registry.
 */
function poolGeneratingRegistry(
  env: AppEnv,
  account: PoolAccount,
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
  const pooled = scope.generating && isPoolFunded(account) ? account : null;
  const pool = pooled?.pool ?? null;
  const registry = registryFor(env, account, opts.apiKeys, scope);
  const defer = opts.defer ?? detach;
  let providers = registry;
  let profile: GenerationProfile;
  if (account.mode === 'simple') {
    // Learn pays per request: its one registry is on the operator's key exactly when the
    // request pays with credit or the pool, and branch funding is ignored.
    const operatorPaid = callPayer(account, 'own-key') !== 'own-key';
    if (pooled) providers = poolGeneratingRegistry(env, pooled, defer, registry);
    else if (operatorPaid) providers = meteredLazily(registry, env, account, defer);
    profile = pool
      ? {
          kind: 'pool',
          model: pool.model,
          systemPrompt: pool.systemPrompt,
          // Budgets and summary prompts in UTF-8 bytes, so the pool's context limit is a hard bound.
          estimateTokens: estimateTokensUtf8,
          // A client-set anchor quote gets no more room than a message.
          anchorQuoteMaxChars: pool.maxMessageChars,
        }
      : {
          kind: 'learn',
          // The tree's learner instructions only where the learner pays: the pool keeps its locked prompt.
          customPrompt: account.payer !== 'pool',
          // On credit a summary's input is capped as a reply's is.
          ...(operatorPaid ? { summaryMaxInputTokens: simpleMaxInputTokens(env) } : {}),
          ...(opts.learnReply ? { reply: opts.learnReply } : {}),
        };
  } else {
    // Power: own keys unmetered; Tangent credit, every call metered.
    const credit = creditRegistryFor(env, account);
    profile = credit
      ? {
          kind: 'power',
          credit: {
            providers: meteredLazily(credit, env, account, defer),
            // A new tree's default route starts on credit only when it can pay, so a first
            // send is never a 402 for credit nobody bought.
            defaultRouteFacts: () => defaultRouteFacts(env, account),
            // The same cap as a reply's input on credit (`serverInputCap`).
            summaryMaxInputTokens: simpleMaxInputTokens(env),
          },
        }
      : { kind: 'power' };
  }
  return new ChatService({
    repos: createD1Repositories(env.DB),
    accountId: account.id,
    providers,
    profile,
    settings: chatSettingsFor(env, account, scope, opts.learnReply),
    defaultSystemPrompt: defaultSystemPromptFor(env, account, scope),
    groundingAllowance: groundingAllowance(env, account),
    // Failures the service recovers from on its own, as structured log lines.
    log: (event, fields) => logEvent('error', event, fields),
  });
}

/** `screen` screens what the owner publishes (share/moderation.ts `shareScreen`). */
export function shareService(
  env: AppEnv,
  requestUrl: string,
  accountId?: string,
  screen?: ShareServiceDeps['screen'],
): ShareService {
  const base = appConfig(env).site.publicBaseUrl ?? new URL(requestUrl).origin;
  return new ShareService({
    repos: createD1Repositories(env.DB),
    publicBaseUrl: base,
    ...(accountId ? { accountId } : {}),
    ...(screen ? { screen } : {}),
  });
}
