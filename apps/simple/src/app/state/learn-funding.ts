import { computed, inject, Injectable, linkedSignal, signal } from '@angular/core';
import {
  learnPayer,
  OPENROUTER_PROVIDER_ID,
  poolModelText,
  type BillingSummary,
  type KeyStatusResponse,
  type MembershipInfo,
  type Payer,
  type PoolMeResponse,
  type PoolStatusResponse,
} from '@tangent/shared';
import {
  ApiClient,
  creditBuyable,
  creditCanPay,
  creditCarriesOn,
  DEMO_MODE,
  formatMicros,
  membershipBlocks,
} from '@tangent/web-shared';
import { AccountStore } from './account-store';
import { PaymentChoice } from './payment-choice';

/** What Learn's replies run on, for the header and the New lesson form. */
export interface PaidBy {
  readonly payer: Payer;
  /** "Your OpenRouter key", "Tangent credit" or "Open pool". */
  readonly label: string;
  /** The header's shorter name: "Your key", "Credit" or "Pool". */
  readonly short: string;
  /** "$1.20 left", "$2.40 in the pool" or "no key saved"; null when there is nothing to add. */
  readonly detail: string | null;
  /** Replies can't run on it now (no key, no credit, the pool or today's share used up). */
  readonly warn: boolean;
}

/**
 * Who pays for Learn's replies: the learner's own OpenRouter key (which
 * needs the yearly membership where one is required), prepaid Tangent
 * credit, or the open pool (neither needs a membership). Each fact is held
 * here once: whether credit is offered (the caller, AccountStore), the
 * balance and top-ups (the billing summary), the membership, the pool's
 * meter and the key cookie. From them and the learner's pick
 * (PaymentChoice), `learnPayer` in `@tangent/shared`, the rule the server's
 * gate applies too, decides the payer every call names. The server reports
 * the payer each reply actually used (`paidWith`, from the stream's `start`),
 * which the header's "Paid by" pill shows.
 */
@Injectable({ providedIn: 'root' })
export class LearnFunding {
  private readonly api = inject(ApiClient);
  private readonly account = inject(AccountStore);
  private readonly choice = inject(PaymentChoice);
  /** The demo always runs on its pretend credit, whatever this browser chose for real. */
  private readonly demo = inject(DEMO_MODE, { optional: true }) ?? false;

  /** Null until loaded, or when billing can't be read (the pill is hidden then). */
  readonly billing = signal<BillingSummary | null>(null);
  /** From /api/me, then from every billing summary and redeemed code; null until loaded. */
  readonly membership = linkedSignal<MembershipInfo | null>(
    () => this.account.me()?.membership ?? null,
  );
  /** The key cookie's state; null until loaded (and in the demo, which has no keys). */
  readonly keyStatus = signal<KeyStatusResponse | null>(null);
  /** The open pool's meter; null until loaded or when it can't be read. */
  readonly poolStatus = signal<PoolStatusResponse | null>(null);
  /** The learner's caps and use of the pool today; null until loaded, or while the pool is off. */
  readonly poolMe = signal<PoolMeResponse | null>(null);

  /**
   * The server refused a reply for want of a membership (402
   * `membership_required`); a fresh /api/me outranks it, as a membership
   * active again does.
   */
  private readonly gateForced = linkedSignal(() => {
    this.account.me();
    return false;
  });
  /**
   * The payer the server said the latest reply used, and the one it was
   * asked for; forgotten once a fact it went by changes (`factsChanged`).
   */
  private readonly reported = signal<{ asked: Payer; used: Payer } | null>(null);
  /** The open lesson's part in a switch (LessonStore): true when it sent a waiting message. */
  private switched: (payer: Payer) => boolean = () => false;

  /** This server sells Tangent credit. */
  readonly creditOffered = computed(() => this.account.me()?.builtInCredit ?? false);
  /** The open pool is on. */
  readonly poolOn = computed(() => this.poolStatus()?.enabled ?? false);
  /** No membership the own key needs is missing. */
  readonly member = computed(() => !membershipBlocks(this.membership()));
  /**
   * The learner's own OpenRouter key is saved in this browser; null until
   * the key status is read, so a status still loading (or failed) never
   * moves a key user onto the pool.
   */
  readonly hasOwnKey = computed(() => {
    const status = this.keyStatus();
    return status ? status.providers.includes(OPENROUTER_PROVIDER_ID) : null;
  });
  /**
   * Credit can pay for replies: anyone can buy it (no membership needed), so
   * it is usable wherever top-ups are sold, and otherwise while a balance is
   * left.
   */
  readonly creditUsable = computed(() => creditCarriesOn(this.creditOffered(), this.billing()));

  /** What replies run on: the learner's pick where it can apply, else what can reply now (`learnPayer`). */
  readonly payer = computed<Payer>(() => {
    if (this.demo) return 'credit';
    const billing = this.billing();
    const offered = this.creditOffered();
    return learnPayer({
      chosen: this.choice.chosen(),
      creditOffered: offered,
      creditCanPay: billing === null ? null : creditCanPay(offered, billing),
      creditBuyable: creditBuyable(offered, billing),
      poolOn: this.poolOn(),
      ownKeyReady: this.member() && this.hasOwnKey() !== false,
    });
  });

  constructor() {
    this.choice.resolveWith(() => this.payer());
  }

  /**
   * Credit was picked but can't pay (the balance read and used up) while the
   * pool is on: replies use the pool until credit is added (`payer`), and
   * the pickers still show credit, saying so.
   */
  readonly creditWaiting = computed(() => {
    const billing = this.billing();
    return (
      this.choice.chosen() === 'credit' &&
      this.payer() === 'pool' &&
      billing !== null &&
      !creditCanPay(this.creditOffered(), billing) &&
      this.creditUsable()
    );
  });

  /** The way to pay the pickers show: the learner's pick where it applies, else the payer. */
  readonly picked = computed<Payer>(() => (this.creditWaiting() ? 'credit' : this.payer()));

  /**
   * Picking credit now would run replies on the pool (it can't pay, the pool
   * is on): the locked-key notice sends the learner to add credit instead.
   */
  readonly creditWouldWait = computed(() => {
    const billing = this.billing();
    return (
      this.poolOn() &&
      billing !== null &&
      !creditCanPay(this.creditOffered(), billing) &&
      this.creditUsable()
    );
  });

  /**
   * Replies can't run on the own key: they run on it (which needs a
   * membership where one is required; the pool and Tangent credit don't),
   * and either the learner has none or the server just refused a reply with
   * 402 `membership_required` (the membership may have lapsed since
   * /api/me). The server only sends that for own-key calls, so a refusal
   * that arrives once replies run on credit or the pool locks nothing. The
   * lesson stays readable; `KeyLockedNotice` stands where the composer (and
   * the new lesson's Start button) would be, with the ways out: subscribe,
   * or `switchTo` the pool or credit (`keyLockedWays`).
   */
  readonly membershipBlocked = computed(
    () => this.payer() === 'own-key' && (!this.member() || this.gateForced()),
  );

  /**
   * The ways to carry on without a membership while the own key is locked:
   * the open pool while it is on, and Tangent credit where it is sold (anyone
   * can buy it). Both false offers only the membership.
   */
  readonly keyLockedWays = computed(() => ({
    pool: this.poolOn(),
    credit: this.creditUsable(),
  }));

  /**
   * On the own key without one: replies can't run until one is added. Not
   * while the key is locked (`membershipBlocked`): the membership is what's
   * missing then, and asking for a key would mislead.
   */
  readonly needsKey = computed(
    () => this.payer() === 'own-key' && this.hasOwnKey() === false && !this.membershipBlocked(),
  );

  /** The available credit as money ("$1.20"); null until the billing summary is loaded. */
  readonly balanceText = computed(() => {
    const b = this.billing();
    return b ? formatMicros(b.availableMicros) : null;
  });

  /** The header's balance pill: only while replies run on credit. */
  readonly balanceLabel = computed(() => (this.payer() === 'credit' ? this.balanceText() : null));

  /**
   * The "Paid by" pill: the payer the server said the latest reply used,
   * while replies are still asked for the same way; else the payer they will
   * be asked for.
   */
  readonly paidBy = computed<PaidBy>(() => {
    const asked = this.payer();
    const r = this.reported();
    const payer = r && r.asked === asked ? r.used : asked;
    if (payer === 'credit') {
      const balance = this.balanceText();
      return {
        payer,
        label: 'Tangent credit',
        short: 'Credit',
        detail: balance === null ? null : `${balance} left`,
        warn: this.lowBalance(),
      };
    }
    if (payer === 'pool') {
      const status = this.poolStatus();
      return {
        payer,
        label: 'Open pool',
        short: 'Pool',
        detail: status?.enabled ? `${formatMicros(status.availableMicros)} in the pool` : null,
        warn: this.poolLow(),
      };
    }
    const missing = this.needsKey();
    const locked = this.membershipBlocked();
    return {
      payer,
      label: 'Your OpenRouter key',
      short: 'Your key',
      detail: locked ? 'needs a membership' : missing ? 'no key saved' : null,
      warn: missing || locked,
    };
  });

  /** The pool is empty, or the learner used up today's replies (the pill turns into a warning). */
  readonly poolLow = computed(() => {
    const status = this.poolStatus();
    const caps = this.poolMe()?.caps;
    return (
      (!!status && status.sessionsRemaining <= 0) ||
      (!!caps && caps.usedRequests >= caps.requestsPerDay)
    );
  });

  /** On the open pool, which uses one model: the Normal/Max switch shows it, locked. */
  readonly poolModel = computed(() => {
    const status = this.poolStatus();
    return status?.enabled && this.payer() === 'pool' ? status.model : null;
  });

  /**
   * Why the Normal/Max switch is locked, or null when it isn't. By default the
   * pool runs Normal's model, asked with less thinking and a shorter reply
   * cap ("The open pool uses Normal's model with lighter thinking and shorter
   * replies.", `poolModelText`); one that is neither tier ("Lite") leaves no
   * segment on.
   */
  readonly poolModelHint = computed(() => {
    const model = this.poolModel();
    return model ? `The open pool uses ${poolModelText(model)}.` : null;
  });

  /**
   * The composer's funding switch: both the learner's own credit (offered and
   * a balance left) and the pool can pay, so the learner picks. Hidden while
   * replies run on the own key: the switch picks between the funded sources.
   * Hidden too until the billing summary is read, so it shows with the
   * balance the payer goes by, not ahead of it. Membership plays no part:
   * neither credit nor the pool needs one.
   */
  readonly fundingChoice = computed(() => {
    if (!this.creditOffered() || !this.poolOn()) return false;
    if (this.billing() === null || this.payer() === 'own-key') return false;
    const own = this.poolMe()?.personalAvailableMicros ?? this.billing()?.availableMicros ?? 0;
    return own > 0;
  });

  /** Personal credit can be bought now: credit is offered and top-ups are sold. Anyone may buy. */
  readonly creditOnSale = computed(() => creditBuyable(this.creditOffered(), this.billing()));

  /** True when the available credit is used up (the pill turns into a warning). */
  readonly lowBalance = computed(() => {
    const b = this.billing();
    return !!b && b.enabled && b.availableMicros <= 0;
  });

  /**
   * Replies run on `payer` from now on, however it was picked (the
   * payment dialog, the composer's switch, the locked-key notice): the pick
   * is remembered, an earlier membership refusal no longer locks anything
   * (it only concerns the own key), the new payer's balance or meter is
   * read, and the open lesson takes it up (`whenSwitched`: the pool's notice
   * goes, and a message refused for want of the key is sent on a payer that
   * needs none). True when that sent a message.
   */
  switchTo(payer: Payer): boolean {
    this.choice.choose(payer);
    this.factsChanged();
    if (payer !== 'own-key') this.gateForced.set(false);
    if (payer === 'credit') void this.refreshBalance();
    if (payer === 'pool') void this.refreshPool();
    return this.switched(payer);
  }

  /** What the open lesson does when the payer is switched (`switchTo`). */
  whenSwitched(hook: (payer: Payer) => boolean): void {
    this.switched = hook;
  }

  /** A reply started on `used`, as the server reports it (the stream's `start`). */
  paidWith(used: Payer): void {
    this.reported.set({ asked: this.payer(), used });
  }

  /** A fresh billing summary (also from the billing page): balance and membership. */
  applyBilling(summary: BillingSummary): void {
    this.billing.set(summary);
    this.factsChanged();
    this.useMembership(summary.membership);
  }

  /** A redeemed code (the billing page's code form) or any other new membership state. */
  setMembership(membership: MembershipInfo): void {
    this.useMembership(membership);
    this.billing.update((b) => (b ? { ...b, membership } : b));
  }

  /**
   * The server answered 402 `membership_required` to an own-key call: block
   * now (the membership may have lapsed since /api/me), then re-read the real
   * state. Replies that have moved to credit or the pool since stay there
   * (`membershipBlocked` locks only the own key).
   */
  membershipRequired(): void {
    const current = this.membership();
    if (current) this.useMembership({ ...current, required: true, status: 'inactive' });
    this.gateForced.set(true);
    void this.refreshBalance();
  }

  /** What the server said the latest reply ran on may no longer hold. */
  private factsChanged(): void {
    this.reported.set(null);
  }

  private useMembership(membership: MembershipInfo): void {
    this.membership.set(membership);
    this.factsChanged();
    // A membership active again (renewed, a waiver redeemed) outranks an earlier refusal.
    if (!membershipBlocks(membership)) this.gateForced.set(false);
  }

  /** Re-reads the balance and membership; failures keep the last known value. */
  async refreshBalance(): Promise<void> {
    try {
      this.applyBilling(await this.api.billing());
    } catch (err) {
      console.warn('Could not load the balance', err);
    }
  }

  /**
   * Re-reads the pool meter and, while the pool is on, the learner's caps;
   * the pool is offered as a way to pay only while it is on. Failures keep
   * the last known values.
   */
  async refreshPool(): Promise<void> {
    try {
      const status = await this.api.poolStatus();
      this.poolStatus.set(status);
      this.factsChanged();
      this.poolMe.set(status.enabled ? await this.api.poolMe() : null);
    } catch (err) {
      console.warn('Could not load the open pool', err);
    }
  }

  async refreshKey(): Promise<void> {
    try {
      this.keyStatus.set(await this.api.keyStatus());
      this.factsChanged();
    } catch (err) {
      console.warn('Could not load the key status', err);
    }
  }

  /** Stores the learner's OpenRouter key (sealed into an HttpOnly cookie by the server). */
  async saveKey(apiKey: string): Promise<void> {
    await this.api.saveKey(OPENROUTER_PROVIDER_ID, apiKey);
    await this.refreshKey();
  }

  async forgetKey(): Promise<void> {
    await this.api.forgetKey(OPENROUTER_PROVIDER_ID);
    await this.refreshKey();
  }
}
