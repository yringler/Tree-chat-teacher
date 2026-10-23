import {
  effectiveLearnTier,
  isModelAllowed,
  isProviderAvailable,
  pickDefaultRoute,
  tierModel,
  tierOf,
  type Branch,
  type BranchFunding,
  type DefaultRouteFacts,
  type LlmProvider,
  type ModelTier,
  type ProviderInfo,
  type ProviderRegistry,
  type ProviderRoute,
} from '@tangent/shared';
import { ValidationError } from '../errors.js';
import { paysPerRequest, type GenerationProfile, type PowerProfile } from './profile.js';
import type { ChatSettings } from './settings.js';

/**
 * Turns routes (a provider and who pays) into providers and models: what a
 * request names, a new tree's default, and where summaries and titles run.
 *
 * Learn runs every route on its one registry, whatever a branch says: a
 * provider that registry lacks becomes its default provider, and the model
 * is the one of the learner's tier (`LearnProfile.reply` through
 * `effectiveLearnTier`: Normal unless they chose Max or Very long), never
 * a branch's own choice of tier (`runnable`). The stored branch keeps its
 * route, so a branch made in power continues in Learn on Learn's choice and
 * still continues in power as it was.
 */
export class RouteResolver {
  /** Learn's funding of every route: payment is decided per request, outside the branch. */
  private readonly fixedFunding: BranchFunding | undefined;
  /** Power's Tangent credit, where offered. */
  private readonly credit: PowerProfile['credit'];
  /** The tier Learn's replies run on (`effectiveLearnTier`), else Normal (the pool's is its own). */
  private readonly learnTier: ModelTier;

  constructor(
    private readonly providers: ProviderRegistry,
    private readonly profile: GenerationProfile,
    private readonly settings: ChatSettings,
  ) {
    this.fixedFunding = paysPerRequest(profile) ? 'own-key' : undefined;
    this.credit = profile.kind === 'power' ? profile.credit : undefined;
    this.learnTier =
      profile.kind === 'learn' && profile.reply ? effectiveLearnTier(profile.reply) : 'normal';
  }

  /** The model generations on `branch` use: the pool's, else the branch's. */
  modelOf(branch: Pick<Branch, 'model'>): string {
    return this.profile.kind === 'pool' ? this.profile.model : branch.model;
  }

  /** How calls on `branch` are paid as far as this instance knows: Learn's fixed funding, else the branch's. */
  fundingOf(branch: Pick<Branch, 'funding'>): BranchFunding {
    return this.fixedFunding ?? branch.funding;
  }

  /**
   * `branch` as this instance generates on it, in memory: Learn's runnable
   * route (`runnableRoute`) and model (`learnModel`); power's as stored.
   */
  runnable<B extends Pick<Branch, 'providerId' | 'funding' | 'model'>>(branch: B): B {
    if (this.fixedFunding === undefined) return branch;
    const route = this.runnableRoute(branch);
    const info = this.providers.list().find((p) => p.id === route.providerId);
    const model = info ? this.learnModel(info, branch.model) : branch.model;
    return { ...branch, ...route, model };
  }

  /** Whether `providerId` lists `model` as its Max (`ModelInfo.tier`). */
  isMaxModel(providerId: string, model: string): boolean {
    const info = this.providers.list().find((p) => p.id === providerId);
    return !!info && tierOf(info.models, model) === 'max';
  }

  /**
   * The model Learn runs `stored` as on `info`: the provider's Max model when
   * the learner's settings call for Max and it lists one; otherwise `stored`
   * while the provider allows it and it isn't a Max model (a branch made on
   * Max in power), else the provider's default. A provider without a Max model (the
   * learner's own Anthropic key, one model) runs as it always does.
   */
  private learnModel(info: ProviderInfo, stored: string): string {
    const max = this.learnTier === 'max' ? tierModel(info.models, 'max') : undefined;
    if (max) return max.id;
    return isModelAllowed(info, stored) && tierOf(info.models, stored) !== 'max'
      ? stored
      : info.defaultModel;
  }

  /**
   * The route a request names, completed from `base` (the parent branch, or
   * the branch being changed): nothing named keeps `base`'s route; a provider
   * without a funding is on the user's own key, so naming a provider never
   * spends credit implicitly; a funding without a provider keeps `base`'s
   * provider. Without a `base` (a reviewer) a provider must be named; a new
   * tree that names none gets the default route (`newTreeRoute`). Learn
   * always runs it as `runnableRoute` says.
   */
  requestedRoute(
    req: { providerId?: string | undefined; funding?: BranchFunding | undefined },
    base: Pick<Branch, 'providerId' | 'funding'> | null,
  ): ProviderRoute {
    let route: ProviderRoute;
    if (req.providerId !== undefined) {
      route = { providerId: req.providerId, funding: req.funding ?? 'own-key' };
    } else if (base) {
      route = { providerId: base.providerId, funding: req.funding ?? base.funding };
    } else {
      throw new ValidationError('Name a provider');
    }
    return this.runnableRoute(route);
  }

  /**
   * `route` as this instance runs it: in Learn, on its fixed funding and, for
   * a provider its one registry lacks, on that registry's default provider.
   */
  runnableRoute(route: ProviderRoute): ProviderRoute {
    const fixed = this.fixedFunding;
    if (fixed === undefined) return route;
    const known = this.providers.list().some((p) => p.id === route.providerId);
    return {
      providerId: known ? route.providerId : this.providers.defaultProviderId(),
      funding: fixed,
    };
  }

  /** The trunk route of a new tree: the one the request names, else the default route. */
  async newTreeRoute(req: {
    providerId?: string | undefined;
    funding?: BranchFunding | undefined;
  }): Promise<ProviderRoute> {
    if (req.providerId !== undefined) return this.requestedRoute(req, null);
    return this.runnableRoute(await this.defaultRoute(req.funding));
  }

  /**
   * The route of a new tree that names no provider: `pickDefaultRoute` over the own-key
   * providers and, where it is offered and nothing named a funding, Tangent
   * credit, with what the profile's `defaultRouteFacts` says about the balance and the
   * membership (asked only then; without it, credit is never the default).
   * Naming only `credit` picks the credit registry's default provider;
   * naming only `own-key` leaves credit out.
   */
  async defaultRoute(funding: BranchFunding | undefined): Promise<ProviderRoute> {
    const own = this.providers;
    const credit = this.credit?.providers;
    // Credit asked for where it isn't offered: `requireProvider` refuses the route.
    if (funding === 'credit') return { providerId: (credit ?? own).defaultProviderId(), funding };
    const withCredit = funding === undefined && credit !== undefined;
    const entries: ProviderInfo[] = [
      ...own.list().map((p) => ({ ...p, funding: 'own-key' as const })),
      ...(withCredit ? credit.list().map((p) => ({ ...p, funding: 'credit' as const })) : []),
    ];
    const facts: DefaultRouteFacts = (withCredit && (await this.credit?.defaultRouteFacts?.())) || {
      creditCanPay: false,
      creditBuyable: false,
      ownKeyLocked: false,
    };
    const picked = pickDefaultRoute(entries, facts);
    if (!picked) return { providerId: own.defaultProviderId(), funding: 'own-key' };
    return { providerId: picked.id, funding: picked.funding ?? 'own-key' };
  }

  /** The provider of a route (a branch, or a requested route); Learn's routes all come from `providers`. */
  requireProvider(route: Pick<Branch, 'providerId' | 'funding'>): LlmProvider {
    const funding = this.fundingOf(route);
    const registry =
      this.fixedFunding !== undefined || funding === 'own-key'
        ? this.providers
        : this.credit?.providers;
    const provider = registry?.get(route.providerId);
    if (!provider) {
      throw new ValidationError(
        funding === 'credit' && this.fixedFunding === undefined
          ? `Unknown provider "${route.providerId}" on Tangent credit`
          : `Unknown provider "${route.providerId}"`,
      );
    }
    return provider;
  }

  /**
   * Where summaries and titles of `branch` run: the configured summary route,
   * else the branch's. `maxInputTokens` is the cap a summary's prompt is
   * clipped to where Tangent credit pays for it (the profile's
   * `summaryMaxInputTokens`); absent on the user's own key.
   */
  summaryTarget(branch: Branch): { provider: LlmProvider; model: string; maxInputTokens?: number } {
    const { summaryProviderId, summaryModel } = this.settings;
    const providers = this.providers;
    // Learn's one registry is paid one way for the whole request, the summary route too.
    const learnCap = this.profile.kind === 'learn' ? this.profile.summaryMaxInputTokens : undefined;
    const learn = learnCap === undefined ? {} : { maxInputTokens: learnCap };
    // A configured summary provider is an own-key route in power (never credit).
    if (summaryProviderId && isProviderAvailable(providers, summaryProviderId)) {
      const provider = providers.get(summaryProviderId);
      if (provider) return { provider, model: summaryModel ?? provider.defaultModel(), ...learn };
    }
    // No summary provider configured, or not one this user has a key for:
    // summarize on the branch's own route and model.
    const creditCap =
      this.fundingOf(branch) === 'credit' ? this.credit?.summaryMaxInputTokens : undefined;
    return {
      provider: this.requireProvider(branch),
      model: this.modelOf(branch),
      ...learn,
      ...(creditCap === undefined ? {} : { maxInputTokens: creditCap }),
    };
  }
}
