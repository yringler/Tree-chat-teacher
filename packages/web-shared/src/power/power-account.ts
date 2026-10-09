import { computed, signal } from '@angular/core';
import {
  pickDefaultRoute,
  providerRouteKey,
  routeKey,
  type BillingSummary,
  type BranchFunding,
  type KeyStatusResponse,
  type MeResponse,
  type MembershipInfo,
  type ProviderInfo,
} from '@tangent/shared';
import { keyMissing } from '../billing/key-missing';
import { creditBuyable, creditCanPay, creditCarriesOn } from '../billing/membership';
import {
  learnCopyWay,
  lockedFundings,
  routeLocked,
  routeOpen,
  type LearnCopyWay,
} from '../billing/read-only';
import { ApiError, type ApiClient } from '../core/api-client';

/** The account calls power makes. */
export type PowerAccountApi = Pick<
  ApiClient,
  'me' | 'keyStatus' | 'providers' | 'saveKey' | 'forgetKey' | 'poolStatus' | 'billing'
>;

/**
 * What stands between a route (a branch, a provider entry) and a reply:
 * nothing, the membership the user lacks (`locked`, read-only), or the
 * user's own key, none of which is saved in this browser (`key-missing`:
 * sending asks for it).
 */
export type RouteState = 'open' | 'locked' | 'key-missing';

/** The refusals that say something about the account (`PowerAccountStore.absorb`). */
export type AccountRefusal = 'membership_required' | 'payment_required' | 'key_required';

/**
 * The power account as power and the canvas see it: the signed-in caller,
 * the providers and which keys are saved, the membership, the Tangent
 * credit balance and the open pool, and what they let the user do. Plain
 * signals and no DI; a failure worth telling the user goes to `onError`,
 * the app's error policy.
 */
export class PowerAccountStore {
  readonly me = signal<MeResponse | null>(null);
  readonly providers = signal<ProviderInfo[]>([]);
  /** The provider list has been read once (until then nothing is known to be unable to generate). */
  readonly providersLoaded = signal(false);
  /** Which providers have a user-supplied key stored (never the key itself). */
  readonly keyStatus = signal<KeyStatusResponse | null>(null);
  /**
   * The yearly membership, from `me`; a 402 `membership_required` marks it
   * inactive (the server knows better than the copy fetched at startup).
   */
  readonly membership = signal<MembershipInfo | null>(null);
  /**
   * The fundings that need the membership in this account, from `me` (the
   * server's rule: `['own-key']` where a membership is required). With
   * `membership`, they decide which routes are read-only.
   */
  readonly membershipNeededFor = signal<readonly BranchFunding[]>([]);
  /**
   * Credit balance and fees (`/api/billing`): read on startup wherever credit
   * is offered (the default route needs the balance), again when the keys
   * dialog opens and after a 402.
   */
  readonly billing = signal<BillingSummary | null>(null);
  /** The balance has been asked for once (read, or failed: then it counts as none). */
  private readonly billingRead = signal(false);
  /**
   * The open pool is on (`GET /api/pool/status`, read on startup): Learn can
   * then reply without a membership or credit. False until read, or when it
   * can't be.
   */
  readonly poolOn = signal(false);

  /** The fundings the user can't generate on right now (docs/DECISIONS.md "Read-only power"). */
  readonly lockedFundings = computed(() =>
    lockedFundings(this.membershipNeededFor(), this.membership()),
  );

  /**
   * Tangent credit can pay for replies, membership or not (`creditCarriesOn`:
   * offered, and either top-ups are sold, so anyone can buy more, or the
   * balance isn't known to be used up). Without a membership, power mode
   * runs on it.
   */
  readonly creditCarriesOn = computed(() =>
    creditCarriesOn(this.me()?.builtInCredit ?? false, this.billing()),
  );

  /**
   * How a copy in Learn of a read-only conversation would get replies without
   * a membership (`learnCopyWay`): the open pool while it is on, else Tangent
   * credit while it carries on; null when neither, and the read-only notice
   * then offers no copy.
   */
  readonly learnCopyWay = computed<LearnCopyWay | null>(() =>
    learnCopyWay(this.poolOn(), this.creditCarriesOn()),
  );

  /** Provider entries the user can generate on now (see `routeOpen`). */
  readonly openRoutes = computed(() =>
    this.providers().filter((p) => routeOpen(p, this.lockedFundings(), this.creditCarriesOn())),
  );

  /**
   * Something can still generate: new conversations, new branches and reviews
   * are offered. False only when the membership locks something and no other
   * route is open (a non-member with their own keys, where Tangent credit
   * isn't sold, or top-ups are off and none is left): power is then
   * read-only throughout. A missing key alone never hides anything (sending
   * asks for it), nor does a provider list not read yet.
   */
  readonly canGenerate = computed(
    () =>
      this.lockedFundings().size === 0 || !this.providersLoaded() || this.openRoutes().length > 0,
  );

  /** Tangent credit, when a read-only branch could carry on with it (anyone can buy it). */
  readonly creditRoute = computed<ProviderInfo | null>(
    () => this.openRoutes().find((p) => p.funding === 'credit') ?? null,
  );

  /**
   * Providers by route (`routeKey`): a plain provider id for the user's own
   * key, `<id>@credit` for Tangent credit (power lists the built-in endpoint
   * on both).
   */
  readonly providerMap = computed(
    () => new Map(this.providers().map((p) => [providerRouteKey(p), p])),
  );

  /**
   * The route a new conversation starts on, and the fallback of a new branch
   * off one that can't generate (`startingRoute`): `pickDefaultRoute`, the
   * server's rule for a new tree (docs/DECISIONS.md "Default route of a new
   * tree"). A provider with a key first; else Tangent credit while the
   * balance can pay; else the user's own OpenRouter (the first send asks for
   * its key). While own keys need a membership the user lacks, credit comes
   * first if it can pay or be bought (`creditBuyable`: offered and top-ups
   * sold), whatever the balance: a first send there asks for credit, which
   * beats a locked own key. Credit that can do neither leaves the locked own
   * key, which at least leads to the membership. Null until the provider
   * list and, where credit is offered, the balance have been read, so it
   * never starts on a guess.
   */
  readonly defaultProvider = computed<ProviderInfo | null>(() => {
    if (!this.providersLoaded()) return null;
    const builtInCredit = this.me()?.builtInCredit ?? false;
    if (builtInCredit && !this.billingRead()) return null;
    return pickDefaultRoute(this.providers(), {
      creditCanPay: creditCanPay(builtInCredit, this.billing()),
      creditBuyable: creditBuyable(builtInCredit, this.billing()),
      ownKeyLocked: this.lockedFundings().has('own-key'),
    });
  });

  constructor(
    private readonly api: PowerAccountApi,
    private readonly onError: (err: unknown) => void,
  ) {}

  /** A route (branch, reviewer, provider entry) whose funding needs the membership the user lacks. */
  routeLocked(route: { funding?: BranchFunding }): boolean {
    return routeLocked(this.lockedFundings(), route);
  }

  /**
   * A route (a branch) on the user's own key with none saved in this browser
   * (`keyMissing`): sending there asks for the key, or another way to pay.
   */
  keyMissing(route: { providerId: string; funding?: BranchFunding }): boolean {
    return keyMissing(this.providerOf(route));
  }

  /** What stands between `route` and a reply (`RouteState`); the membership first. */
  routeState(route: { providerId: string; funding?: BranchFunding }): RouteState {
    if (this.routeLocked(route)) return 'locked';
    return this.keyMissing(route) ? 'key-missing' : 'open';
  }

  /** The provider entry of a route: a branch, a reviewer, a context plan. */
  providerOf(route: { providerId: string; funding?: BranchFunding }): ProviderInfo | undefined {
    return this.providerMap().get(routeKey(route));
  }

  /** `me`: the signed-in caller, already fetched by the sign-in check (AuthService.requireUser). */
  async init(me: MeResponse): Promise<void> {
    this.applyMe(me);
    // Where credit is offered, the balance (and whether top-ups are sold) decides whether a
    // new conversation may start on it, and whether Tangent credit can carry on.
    const balance = me.builtInCredit ? this.refreshBilling() : null;
    await Promise.all([this.refreshKeys(), balance, this.refreshPool()]);
  }

  private applyMe(me: MeResponse): void {
    this.me.set(me);
    this.membership.set(me.membership);
    this.membershipNeededFor.set(me.membershipNeededFor ?? []);
  }

  /** Re-reads `me`: the membership and the fundings that need it, as the server sees them now. */
  async refreshMe(): Promise<void> {
    try {
      this.applyMe(await this.api.me());
    } catch (err) {
      console.warn('me failed', err);
    }
  }

  /** Key status and provider availability both change when a key is saved or forgotten. */
  async refreshKeys(): Promise<void> {
    await Promise.all([
      this.api.keyStatus().then(
        (s) => this.keyStatus.set(s),
        (e: unknown) => this.onError(e),
      ),
      this.api
        .providers()
        .then(
          (p) => this.providers.set(p),
          (e: unknown) => this.onError(e),
        )
        .finally(() => this.providersLoaded.set(true)),
    ]);
  }

  /**
   * Sends the key to the Worker once. It is sealed into an HttpOnly cookie
   * and nothing here keeps a copy.
   */
  async saveKey(provider: string, apiKey: string): Promise<boolean> {
    try {
      await this.api.saveKey(provider, apiKey);
      return true;
    } catch (err) {
      this.onError(err);
      return false;
    } finally {
      await this.refreshKeys();
    }
  }

  async forgetKey(provider?: string): Promise<void> {
    try {
      await this.api.forgetKey(provider);
    } catch (err) {
      this.onError(err);
    } finally {
      await this.refreshKeys();
    }
  }

  /**
   * Whether the open pool is on (`/api/pool/status` is public). Quiet on
   * failure: no copy in Learn is offered on its account.
   */
  async refreshPool(): Promise<void> {
    try {
      this.poolOn.set((await this.api.poolStatus()).enabled);
    } catch (err) {
      console.warn('pool status failed', err);
    }
  }

  /** Credit balance and fees. Quiet on failure: the keys dialog then shows no balance. */
  async refreshBilling(): Promise<void> {
    try {
      this.billing.set(await this.api.billing());
    } catch (err) {
      console.warn('billing summary failed', err);
    } finally {
      this.billingRead.set(true);
    }
  }

  /** A billing summary read elsewhere (the billing page): its balance and membership are current. */
  applyBilling(summary: BillingSummary): void {
    this.billing.set(summary);
    this.billingRead.set(true);
    this.membership.set(summary.membership);
  }

  /**
   * Takes in what a refusal says about the account, and names it (null for
   * any other error). No membership (402 `membership_required`): the server
   * knows better than the copy read at startup, so own keys are locked now
   * (the only funding it asks the membership for), and `me` and the balance
   * are read again. No credit (402 `payment_required`): the balance is read
   * again. A missing, expired or reset key (401 `key_required`): which keys
   * are saved is read again. What the user is shown is the app's to decide.
   */
  absorb(err: unknown): AccountRefusal | null {
    if (!(err instanceof ApiError)) return null;
    switch (err.code) {
      case 'membership_required':
        this.membership.update((m) => (m ? { ...m, required: true, status: 'inactive' } : m));
        this.membershipNeededFor.update((f) => (f.includes('own-key') ? f : [...f, 'own-key']));
        void this.refreshMe();
        void this.refreshBilling();
        return 'membership_required';
      case 'payment_required':
        void this.refreshBilling();
        return 'payment_required';
      case 'key_required':
        void this.refreshKeys();
        return 'key_required';
      default:
        return null;
    }
  }
}
