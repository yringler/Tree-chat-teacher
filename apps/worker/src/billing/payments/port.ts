// The one interface between billing and a payment provider
// (docs/polar-migration/03-architecture.md §2). It imports nothing but shared
// types: adapters (billing/providers/*) implement it, and the domain
// (apply.ts, service.ts, membership.ts) depends on it only.
//
// Rules: adapters translate and never decide (no D1, no ledger, no business
// settings; only their own env vars); the domain decides and never sees a
// provider's types. Amounts cross the port as integer USD cents, already
// split into pre-tax `netCents` and `taxCents`. Idempotency keys are minted
// by the adapter (namespaced, refs.ts) and enforced by the ledger's unique
// `credit_grants.provider_ref`.
import type { SubscriptionStatus } from '@tangent/shared';

/** Adapters that exist. A new provider = a literal here + its module + a case in index.ts. */
export type ProviderId = 'polar' | 'fake';

/**
 * Namespaced, provider-minted idempotency key: `<provider>:<object>:<id>`,
 * e.g. `polar:order:6c1e…`. Stored in `credit_grants.provider_ref` (unique).
 * `admin:` and `dev:` are reserved for non-payment grants and are never a ProviderId.
 */
export type ProviderRef = string & { readonly __brand: 'ProviderRef' };

/** Who is buying. `customerRef` is the provider's own customer id from `billing_customers`, if one was recorded. */
export interface Buyer {
  userId: string;
  email: string;
  name: string | null;
  /** Adapters that address customers by our user id (Polar's external_id) ignore it. */
  customerRef: string | null;
}

export interface TopUpCheckoutInput {
  /** Credit is bought for the buyer's own ledger only. */
  buyer: Buyer;
  /** Pre-tax, whole USD cents. The domain has already validated the bounds. */
  amountCents: number;
  successUrl: string;
  /** Where the provider's back/cancel link goes. */
  cancelUrl: string;
}

export interface MembershipCheckoutInput {
  buyer: Buyer;
  successUrl: string;
  cancelUrl: string;
}

export interface PortalInput {
  buyer: Buyer;
  returnUrl: string;
}

/** A hosted page to send the browser to. */
export interface RedirectSession {
  url: string;
  /** Set when the adapter created or learned a customer id the domain should remember. */
  customerRef?: string;
}

export interface WebhookRequest {
  /** Unparsed body: signatures are computed over the exact bytes. */
  rawBody: string;
  headers: Headers;
}

export type WebhookParseResult =
  | { kind: 'events'; deliveryId: string; events: readonly PaymentEvent[] }
  /** Verified, but nothing we act on (an unsubscribed type, a pending order, a checkout.*). */
  | { kind: 'ignored'; deliveryId: string | null; reason: string };

/** What this deployment can sell; false when the matching product isn't configured. */
export interface ProviderCapabilities {
  topUps: boolean;
  membership: boolean;
}

/**
 * How dispute outcomes reach us. Some providers push them; Polar has no
 * dispute webhooks, so its adapter is polled by the cron. `poll` must be
 * idempotent to call: the domain dedupes on the refs.
 */
export type DisputeSource =
  | { mode: 'webhook' }
  | { mode: 'poll'; poll(now: Date): Promise<readonly DisputeEvent[]> }
  | { mode: 'none' };

export interface PaymentProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  readonly disputes: DisputeSource;

  createTopUpCheckout(input: TopUpCheckoutInput): Promise<RedirectSession>;
  createMembershipCheckout(input: MembershipCheckoutInput): Promise<RedirectSession>;
  /** null = the provider has no customer for this buyer yet (the UI says "nothing to manage yet"). */
  createPortalSession(input: PortalInput): Promise<RedirectSession | null>;
  /**
   * Ends every subscription and deletes or anonymises the customer.
   * 'absent' = there was no customer. Any other failure throws PaymentProviderError,
   * and account deletion aborts.
   */
  deleteCustomer(buyer: Pick<Buyer, 'userId' | 'customerRef'>): Promise<'deleted' | 'absent'>;
  /** Verifies and normalises one delivery. Throws WebhookSignatureError on a bad signature. */
  parseWebhook(req: WebhookRequest): Promise<WebhookParseResult>;
  /**
   * Facts about one payment, for the rare path where a refund or dispute names a
   * payment we hold no grant for (out-of-order delivery, or a payment that granted nothing).
   * null = the provider doesn't know it.
   */
  getPayment(paymentRef: ProviderRef): Promise<PaymentFacts | null>;
}

export class WebhookSignatureError extends Error {
  override readonly name = 'WebhookSignatureError';
}

export class PaymentProviderError extends Error {
  override readonly name = 'PaymentProviderError';
  constructor(
    message: string,
    /** The provider's HTTP status, when the failure came from its API. */
    readonly status: number | null,
    /** true for 429 / 5xx / network errors. */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

// ---- Normalised domain events (03-architecture.md §2.2)

interface EventBase {
  provider: ProviderId;
  /** ISO time the provider says this happened (diagnostics only). */
  occurredAt: string;
}

/** What a payment was for, as the checkout metadata (or the product) says. */
export type PaymentPurpose =
  /** A top-up of the buyer's own credit. */
  | { kind: 'credits' }
  | { kind: 'membership'; cycle: 'initial' | 'renewal'; subscriptionRef: ProviderRef }
  /** Anything else on the provider account: logged, never credited. */
  | { kind: 'other' };

export interface PaymentFacts {
  /** The grant's idempotency key (Polar: `polar:order:<order.id>`). */
  paymentRef: ProviderRef;
  purpose: PaymentPurpose;
  /** Our user id (Polar: customer.external_id, else metadata.userId); null when unknown. */
  userId: string | null;
  customerRef: string | null;
  /** Lower-case ISO 4217. The domain credits 'usd' only and logs anything else. */
  currency: string;
  /** Pre-tax, after discounts: what the goods cost. Enters the ledger as gross. Never includes tax. */
  netCents: number;
  taxCents: number;
  /**
   * The processor's or MoR's fee in USD cents; `estimated` when the adapter
   * fell back to its fee formula (D3). null = unknown, so retry.
   */
  fee: { cents: number; estimated: boolean } | null;
}

/** Money arrived (a top-up, the membership's first year or a renewal). */
export interface PaymentSucceeded extends EventBase, PaymentFacts {
  type: 'payment.succeeded';
}

/** A refund settled. Adapters emit only settled refunds (D10); pending and failed refunds produce nothing. */
export interface RefundSucceeded extends EventBase {
  type: 'refund.succeeded';
  refundRef: ProviderRef;
  paymentRef: ProviderRef;
  currency: string;
  /** Refunded pre-tax amount. */
  netCents: number;
  taxCents: number;
}

interface DisputeBase extends EventBase {
  disputeRef: ProviderRef;
  paymentRef: ProviderRef;
  currency: string;
  /** Disputed pre-tax amount. */
  netCents: number;
}
/**
 * Funds withdrawn or at risk (Polar: needs_response, under_review). Prevented
 * and early-warning disputes end in a refund instead and emit nothing.
 */
export interface DisputeOpened extends DisputeBase {
  type: 'dispute.opened';
}
export interface DisputeWon extends DisputeBase {
  type: 'dispute.won';
}
/** Also implies "opened": a poller may first see a dispute when it is already lost. */
export interface DisputeLost extends DisputeBase {
  type: 'dispute.lost';
}
export type DisputeEvent = DisputeOpened | DisputeWon | DisputeLost;

/**
 * The membership subscription's current state: a snapshot, not a transition.
 * Upserted with a version guard, so order and duplicates don't matter.
 */
export interface MembershipChanged extends EventBase {
  type: 'membership.changed';
  subscriptionRef: ProviderRef;
  userId: string;
  customerRef: string | null;
  /** Normalised: 'trialing' | 'active' | 'past_due' | 'unpaid' | 'paused' | 'incomplete' | 'canceled'. */
  status: SubscriptionStatus;
  /** The provider's raw status, stored for support; never sent to the frontend. */
  providerStatus: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  endedAt: string | null;
  /** Monotonic per subscription (Polar: modified_at, else occurredAt). Older snapshots are dropped. */
  version: string;
}

export type PaymentEvent = PaymentSucceeded | RefundSucceeded | DisputeEvent | MembershipChanged;
