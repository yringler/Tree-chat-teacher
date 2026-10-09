import {
  isProviderAvailable,
  pickDefaultRoute,
  type Branch,
  type BranchFunding,
  type DefaultRouteFacts,
  type LlmProvider,
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
 */
export class RouteResolver {
  /** Learn's funding of every route: payment is decided per request, outside the branch. */
  private readonly fixedFunding: BranchFunding | undefined;
  /** Power's Tangent credit, where offered. */
  private readonly credit: PowerProfile['credit'];

  constructor(
    private readonly providers: ProviderRegistry,
    private readonly profile: GenerationProfile,
    private readonly settings: ChatSettings,
  ) {
    this.fixedFunding = paysPerRequest(profile) ? 'own-key' : undefined;
    this.credit = profile.kind === 'power' ? profile.credit : undefined;
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
   * The route a request names, completed from `base` (the parent branch, or
   * the branch being changed): nothing named keeps `base`'s route; a provider
   * without a funding is on the user's own key, so naming a provider never
   * spends credit implicitly; a funding without a provider keeps `base`'s
   * provider. Without a `base` (a reviewer) a provider must be named; a new
   * tree that names none gets the default route (`newTreeRoute`). Learn's
   * fixed funding always wins.
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
    return this.withFixedFunding(route);
  }

  withFixedFunding(route: ProviderRoute): ProviderRoute {
    const fixed = this.fixedFunding;
    return fixed === undefined ? route : { ...route, funding: fixed };
  }

  /** The trunk route of a new tree: the one the request names, else the default route. */
  async newTreeRoute(req: {
    providerId?: string | undefined;
    funding?: BranchFunding | undefined;
  }): Promise<ProviderRoute> {
    if (req.providerId !== undefined) return this.requestedRoute(req, null);
    return this.withFixedFunding(await this.defaultRoute(req.funding));
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

  /** Where summaries and titles of `branch` run: the configured summary route, else the branch's. */
  summaryTarget(branch: Branch): { provider: LlmProvider; model: string } {
    const { summaryProviderId, summaryModel } = this.settings;
    const providers = this.providers;
    // A configured summary provider is an own-key route (never credit, in power).
    if (summaryProviderId && isProviderAvailable(providers, summaryProviderId)) {
      const provider = providers.get(summaryProviderId);
      if (provider) return { provider, model: summaryModel ?? provider.defaultModel() };
    }
    // No summary provider configured, or not one this user has a key for:
    // summarize on the branch's own route and model.
    return { provider: this.requireProvider(branch), model: this.modelOf(branch) };
  }
}
