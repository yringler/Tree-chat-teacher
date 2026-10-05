# Payment architecture for the Polar implementation (stage 3)

Date: 2026-10-05. Inputs: [01-polar-research.md](01-polar-research.md), [02-stripe-to-polar-mapping.md](02-stripe-to-polar-mapping.md), `docs/DECISIONS.md`, `docs/PLAN.md`, and a read of `apps/worker/src/billing/*`, `auth/{auth,delete-account}.ts`, `services.ts`, `cron.ts`, `email/*`, `packages/shared/src/billing.ts`, `packages/web-shared/src/{core,billing}/*` and the worker test mocks. No code was changed.

The question: what architecture makes a payment-provider switch like this one routine next time? The goal is that a future switch (Polar to Paddle, Lemon Squeezy or back to Stripe) touches **one adapter module, its env vars, the legal text and the README**. It should not touch the ledger, the schema, the shared types, the frontend, or the domain test suite.

Stage 2's conclusions all still hold: pre-launch, hard cutover, keep the internal ledger, own routes instead of `@polar-sh/better-auth`, dispute polling from the cron, and provider-neutral column names. This document reorganises *where* the stage 2 work lands. §8 lists every deviation.

---

## 1. The current architecture, assessed honestly

### 1.1 What is already provider-neutral (keep it)

| Layer | Files | Verdict |
|---|---|---|
| Ledger | `billing/ledger.ts` | **Neutral in logic.** Append-only `credit_grants` with a unique idempotency key, plus `usage_events`. The only leaks are names: `stripeRef` / `stripe_ref`, and doc comments. |
| Purchase fulfilment | `billing/purchases.ts` (`PaidPurchase`, `fulfilPurchase`, `netOfFee`, `poolPurchaseAmounts`, `assertPurchasable`) | **Already the right seam.** `fulfilPurchase` is "a payment of X cents with fee F succeeded, so credit it once under ref R". It is the only place purchase credit is computed. The admin's `simulated_purchase` (`routes/admin.ts`) already calls it without Stripe, which shows it works. There is even a `PurchaseProvider` interface, but it covers only credit checkout and has one implementation (`stripePurchases`). |
| Metering, spend gate, reconcile, pricing | `meter.ts`, `gate.ts`, `reconcile.ts`, `usage-store.ts`, `pricing.ts` | **Neutral.** No processor concepts. |
| Pool | `pool/pool-bank.ts` and the rest of `pool/*` | **Neutral.** The only leaks are the `stripeRef: req.refId` field name and one comment. `PoolBank.debit` (clamped, idempotent on `refId`) is reusable as is. |
| Membership rules | `billing/membership.ts` (`assertMember`, the waiver, `membershipRequired`) | **Neutral in policy.** Required/waived/active, with `past_due` counting as active. **Not neutral in storage** (see §1.2). |
| Domain policies inside the webhook | `webhook.ts`: `debitPoolPurchase`, `disputeDebit`, `reinstateDispute`, `suspendForLostDispute`, membership-credit-once | **The policies are good and provider-independent**: a refund debits the pre-tax amount in full, the pool debit is clamped, the membership credit is taken back once, a lost dispute suspends pool access, and a won dispute reinstates exactly what was debited. They are typed on `Stripe.*` objects, though, and interleaved with Stripe API calls. |
| Existing precedents | `email/index.ts` (`EMAIL_PROVIDER` chooses between `resend` and a localhost-only `log` sender), the fake LLM provider (`kind: 'fake'`), `TEST_SEAMS`, the injectable `CronJobs` | **The repo already has the pattern.** `email/types.ts` says: "switching providers means adding a class and a case there". Payments should copy it. |

### 1.2 Where Stripe leaks (what made this migration a 102-file change)

| Leak | Where | Why it hurts a switch |
|---|---|---|
| **Ingress and domain logic in one file** | `billing/webhook.ts` (572 lines): fee lookup through `paymentIntents.retrieve`, session lookup by PaymentIntent, `invoicePayments.list`, the tax ratio from `amount_subtotal/amount_total`, all mixed with ledger decisions | The good policies can't be reused without rewriting the file. Stage 2 had to plan a rewrite (`polar-webhook.ts`) rather than a swap. |
| **Membership state owned by a provider plugin** | The Better Auth Stripe plugin owns `auth_subscriptions` (`stripe_*` columns), the checkout (`/api/auth/subscription/upgrade`), the portal and the webhook endpoint (`/api/auth/stripe/webhook`) | The membership's *state* is wherever the plugin puts it. Polar's plugin keeps no table, so changing provider meant changing the schema, the auth config, the frontend client and the domain query together. |
| Provider SDK calls in domain files | `service.ts` `createCreditCheckout` (Checkout Session inline); `auth/delete-account.ts` imports `stripe` and `Stripe.errors`; `auth/auth.ts` | There is no single place to look, and one SDK error class is caught in the account-deletion code. |
| Configuration | `billingConfigured()` lives in `stripe.ts` and is imported by `services.ts`, `auth.ts` and `membership.ts`. `topUpsEnabled` reads `STRIPE_CREDITS_PRODUCT_ID` in `service.ts`. | "Is billing on?" is answered by the provider module. Nothing chooses a provider. |
| Schema names | `credit_grants.stripe_ref`, `auth_users.stripe_customer_id`, `auth_subscriptions.stripe_*` | Every rename costs a migration and touches every test fixture. |
| Customer identity | `ensureStripeCustomer` and `userIdForCustomer` (the user↔customer mapping lives on `auth_users`) | One provider-specific id sits on the user row. A second provider makes its meaning ambiguous. |
| Shared types | `MembershipInfo.stripeStatus`, `MEMBERSHIP_PLAN` (a plugin concept), about 12 comments | The provider name crosses the API boundary into three apps. |
| Frontend | `@better-auth/stripe` client in the browser bundle (`auth-client.ts`), `BillingClient` wrapping plugin calls, Stripe-shaped `BillingSubscription`, plugin error codes (`CUSTOMER_NOT_FOUND`), "Stripe" in UI copy in about 10 files | Changing provider changes browser code and its specs. |
| **Tests** | Every domain behaviour (credit once, fee, refunds, pool clamp, disputes, membership credit) is tested through Stripe's wire format: hand-built `Stripe.Event`s plus an HTTP mock that emulates balance transactions. About 260 Stripe mentions across `billing-webhook.test.ts`, `pool-purchase.test.ts`, `billing-ledger.test.ts`, `multi-user.test.ts`, `billing-checkout.test.ts`, and so on. | **This is the most expensive leak.** A switch means rewriting the domain test suite, and that suite is the safety net for the switch itself. |

**Score.** About a third of the billing code (roughly 880 of 2,700 lines across `webhook.ts`, `stripe.ts`, half of `service.ts`, the plugin wiring, deletion and membership storage) is Stripe-shaped. The core (ledger, fulfilment math, metering, pool) is already neutral. The edges are not: ingress, membership state, customer lifecycle, names, client and tests. **So you already have half of the architecture.** The missing half is a *port* at the edge and normalised events in front of the existing domain functions.

---

## 2. Target architecture: one port, normalised events, stateless adapters

```
          ┌──────────── frontend (web, simple, canvas) ─────────────┐
          │  POST /api/billing/checkout | /membership/checkout |     │
          │  /portal  → { url }   (redirect only; neutral status)    │
          └───────────────────────────┬──────────────────────────────┘
                                      │
 routes/billing.ts ──► billing/service.ts, membership.ts  (domain: validate, decide)
                                      │ calls
                                      ▼
                        billing/payments/port.ts  PaymentProvider  ◄── index.ts picks one (PAYMENT_PROVIDER)
                                      ▲ implements
              ┌───────────────────────┴───────────────────────┐
   billing/providers/polar/*  (only place that              billing/providers/fake.ts
   imports @polar-sh/sdk; stateless, no D1)                 (tests, TEST_SEAMS only)
              │  parseWebhook / disputes.poll → PaymentEvent[]
              ▼
 routes/payment-webhooks.ts  POST /api/webhooks/:provider ─┐
 cron.ts  paymentDisputes ─────────────────────────────────┤
                                                           ▼
                        billing/payments/apply.ts  applyPaymentEvent(env, event)
                        → fulfilPurchase / grantCredit / PoolBank.debit /
                          billing_subscriptions upsert / billing_customers upsert
```

Rules:

1. **Adapters translate. They do not decide.** An adapter maps the provider's objects to `PaymentEvent`s and maps checkout and portal requests to the provider's API. It never touches D1, the ledger or `appConfig` business settings. It reads only its own env vars.
2. **The domain decides. It never sees provider types.** `apply.ts`, `purchases.ts`, `membership.ts` and `service.ts` import only `port.ts` and `refs.ts`.
3. **Amounts cross the port as integer USD cents, already split into pre-tax `netCents` and `taxCents`.** Every provider computes tax and fees differently, so producing these numbers is the adapter's job. The ledger's micro-USD conversion stays in the domain (`centsToMicros`).
4. **Idempotency keys are minted by the adapter (namespaced) and enforced by the domain** through the existing unique ledger column (§4).
5. **The frontend receives only redirect URLs and neutral status.**

### 2.1 The port (`apps/worker/src/billing/payments/port.ts`)

```ts
// The one interface between billing and a payment provider. Imports nothing
// but shared types; adapters implement it, the domain depends on it only.
import type { PurchaseTarget, SubscriptionStatus } from '@tangent/shared';

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
  buyer: Buyer;
  target: PurchaseTarget;
  /** The ledger to credit (`u_<userId>` or the pool's id). It must come back in `PaymentSucceeded.purpose`. */
  accountId: string;
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
 * How dispute outcomes reach us. Stripe and Paddle push them; Polar has no dispute
 * webhooks, so its adapter is polled by the cron. `poll` must be idempotent to call:
 * the domain dedupes on the refs.
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
```

### 2.2 Normalised domain events

```ts
interface EventBase {
  provider: ProviderId;
  /** ISO time the provider says this happened (diagnostics only). */
  occurredAt: string;
}

/** What a payment was for, as the checkout metadata (or the product) says. */
export type PaymentPurpose =
  | { kind: 'credits'; target: PurchaseTarget | 'unknown'; accountId: string | null }
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
  /** The processor's or MoR's fee in USD cents; `estimated` when the adapter fell back to its fee formula (D3). null = unknown, so retry. */
  fee: { cents: number; estimated: boolean } | null;
}

/** Money arrived (a top-up, a pool purchase, the membership's first year or a renewal). */
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
/** Funds withdrawn or at risk (Polar: needs_response, under_review). Prevented and early-warning disputes end in a refund instead and emit nothing. */
export interface DisputeOpened extends DisputeBase { type: 'dispute.opened' }
export interface DisputeWon extends DisputeBase { type: 'dispute.won' }
/** Also implies "opened": a poller may first see a dispute when it is already lost. */
export interface DisputeLost extends DisputeBase { type: 'dispute.lost' }
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
```

**Why a `membership.changed` snapshot instead of `MembershipActivated / Renewed / Canceled`.** Providers disagree on lifecycle granularity. Polar sends `subscription.created/updated/active/canceled/uncanceled/revoked/past_due/cycled`, Stripe sends `customer.subscription.*`, and Paddle has its own set. No provider guarantees order, and a poller can skip states. One snapshot with a version guard is correct under any order and any granularity, and it maps from all three in a few lines. The *money* part of a renewal is separate: `payment.succeeded` with `purpose.kind = 'membership', cycle: 'renewal'`. So "renewed" still exists, as a payment, which is what grants the included credit.

### 2.3 Domain handler (`billing/payments/apply.ts`)

`applyPaymentEvent(env, event, deps = { provider: paymentProvider(env) }): Promise<'applied' | 'duplicate' | 'skipped'>`. It throws `RetryLaterError` when the provider should redeliver. The `deps` default follows `cronTasks(jobs = CRON_JOBS)`, so tests can pass a configured fake.

| Event | Domain action (logic moved from `webhook.ts`, retyped) |
|---|---|
| `payment.succeeded`, credits | Non-USD: log and skip. `fee === null`: throw RetryLater. `target 'unknown'`: log and skip. Otherwise `fulfilPurchase({ target, userId, accountId, grossCents: netCents, processorFeeCents: fee.cents, ref: paymentRef })`. `fee.estimated` is logged as `fee_estimated`. |
| `payment.succeeded`, membership | `membershipCreditCents(env) > 0` and `netCents > 0`: `grantCredit(kind 'subscription', ref paymentRef, note MEMBERSHIP_CREDIT_NOTE)`. |
| any event with `userId` + `customerRef` | Upsert `billing_customers` (§4). |
| `refund.succeeded` | Look up the local grant by `paymentRef` (`grantByRef`). Membership grant: take the credit back once under `membershipRefundRef(paymentRef)`. Pool purchase: `debitPoolPurchase` (PoolBank, clamped). Personal: a negative grant of `netCents` under `refundRef`. **No grant:** call `provider.getPayment(paymentRef)`. A credits payment that isn't credited yet throws RetryLater. A membership payment that granted nothing, or `other`, is a no-op. |
| `dispute.opened` / `dispute.lost` | Debit like a refund under `disputeRef` (personal or pool; membership disputes are left to the operator, as today). `lost` additionally runs `suspendForLostDispute`. Both are idempotent, so a poller that sees `lost` first still debits once. |
| `dispute.won` | If `disputeRef` was debited, credit back exactly that under `reinstatedRef(disputeRef)`. Otherwise no-op (nothing was ever withdrawn). |
| `membership.changed` | `INSERT … ON CONFLICT(ref) DO UPDATE … WHERE excluded.version >= billing_subscriptions.version`. |

### 2.4 Inbound routes

- **`POST /api/webhooks/:provider`** (`routes/payment-webhooks.ts`, registered in `app.ts` before `sessionMiddleware`, next to `/api/pool/status`). The route resolves `webhookProvider(env, param)`; unknown → 404. It reads `c.req.text()` and calls `parseWebhook`.
  - `WebhookSignatureError` → 403.
  - `ignored` → 202.
  - Otherwise it applies each event in order. A throw → **500** with log `payment_webhook_failed {provider, deliveryId}`, because Polar auto-disables an endpoint after 10 consecutive failures, so this needs an alert.
  - Success → 200.

  Polar's URL is therefore `/api/webhooks/polar`, the same as stage 2.
- **Cron:** `CronJobs.paymentDisputes` (`billing/payments/disputes.ts`). If `provider.disputes.mode === 'poll'`, it polls and applies each event. It is wrapped in `.catch` and a log, so a provider outage never blocks reconcile.

### 2.5 Provider selection and DI (`billing/payments/index.ts`, copying `email/index.ts`)

```ts
/** The active provider, or null when payments aren't configured (no top-ups, no membership sold). */
export function paymentProvider(env: AppEnv): PaymentProvider | null;
/** paymentProvider(env) !== null. Replaces stripe.ts billingConfigured() everywhere (services.ts, membership.ts). */
export function paymentsConfigured(env: AppEnv): boolean;
/** The provider whose webhooks /api/webhooks/:id accepts: the active one (and, in a future switch, a legacy one). */
export function webhookProvider(env: AppEnv, id: string): PaymentProvider | null;
```

- `PAYMENT_PROVIDER` var, default `polar`. `polar` returns `createPolarProvider(polarConfig(env))`, or null when `POLAR_ACCESS_TOKEN`/`POLAR_WEBHOOK_SECRET` are unset. `fake` is allowed **only when `TEST_SEAMS === 'true'`** and throws otherwise, like `EMAIL_PROVIDER=log`. Unknown values throw.
- `services.ts` keeps its role (env → derived capability). `personalCreditReady` calls `paymentsConfigured`. It does not construct the provider, which avoids deepening the existing `services.ts ↔ billing/service.ts` import cycle.
- Adapter construction is cheap. Polar's SDK client is cached per token in a module `Map`, as `getStripe` does today.
- **Future-switch hook (documented, not built now):** `webhookProvider` may also return a *legacy* adapter (`PAYMENT_PROVIDER_LEGACY`). It accepts webhooks and dispute polls, never checkouts, so refunds and disputes of the old provider's payments keep flowing for its refund and chargeback window. Pre-launch there is nothing legacy, so this is one `if` to add later, not code to write now.

### 2.6 Capability gaps

- **Disputes:** `DisputeSource` (webhook / poll / none) is a discriminated union, not optional methods, so the cron can't forget a case and the type checker enforces `poll` when `mode === 'poll'`. With `none`, disputes are operator work, as for membership disputes today.
- **What can be sold:** `capabilities.topUps` and `capabilities.membership` replace `topUpsEnabled`'s env read and `membershipPriceId() !== null`. `topUpsEnabled = paymentsConfigured && capabilities.topUps`. `membershipRequired = ANNUAL_FEE_ENABLED && capabilities.membership`. `fundingOpen = topUps && poolPurchasesEnabled` (D1).
- **Fees:** a provider without a per-payment fee in its payload, or before settlement, fills `fee` from its own formula with `estimated: true` (the D3 fallback). That formula is adapter config.
- **Tax:** never crosses the port except as `taxCents`, which is informational. A non-MoR adapter (Stripe) turns on its own tax features inside `createTopUpCheckout`. The domain doesn't care.
- **Customer ids:** adapters that need one (Stripe) return `customerRef` from checkout. Adapters that don't (Polar uses `external_customer_id = userId`) ignore `Buyer.customerRef`. No capability flag is needed.

### 2.7 Module layout

```
apps/worker/src/billing/
  ledger.ts  meter.ts  gate.ts  reconcile.ts  usage-store.ts  pricing.ts   unchanged (ledger: providerRef rename)
  purchases.ts      domain only: assertPurchasable, fulfilPurchase, netOfFee, poolPurchaseAmounts
                    (PurchaseProvider/stripePurchases removed: the port replaces them)
  service.ts        summary, usage, assertCanSpend, checkoutReturnUrl, startTopUpCheckout (validate → port)
  membership.ts     membershipFor (reads billing_subscriptions), assertMember, waiver,
                    startMembershipCheckout (active member → portal URL instead), openPortal
  payments/
    port.ts         §2.1–2.2 (types and errors only)
    refs.ts         providerRef(id, object, rawId), reinstatedRef, membershipRefundRef, isReservedRef
    index.ts        paymentProvider / paymentsConfigured / webhookProvider
    apply.ts        applyPaymentEvent (+ debitPoolPurchase, dispute helpers moved from webhook.ts)
    customers.ts    billing_customers: customerRefFor, rememberCustomer, forgetCustomers
    disputes.ts     pollDisputes (cron job)
  providers/
    polar/
      config.ts     polarConfig(env): POLAR_ACCESS_TOKEN, POLAR_WEBHOOK_SECRET, POLAR_SERVER,
                    POLAR_CREDITS_PRODUCT_ID, POLAR_MEMBERSHIP_PRODUCT_ID, fee-estimate params
      client.ts     getPolar(config), cached; createPolar({ timeout: 15, server })
      map.ts        pure: Order → PaymentSucceeded, Refund → RefundSucceeded, Subscription →
                    MembershipChanged, Dispute → DisputeEvent; status normalisation
      adapter.ts    createPolarProvider(config): PaymentProvider
    fake.ts         createFakeProvider(opts?): PaymentProvider (§6)
apps/worker/src/routes/payment-webhooks.ts
```

Enforced boundaries (step 9 of §9). In `eslint.config.js`, add `no-restricted-imports`: `@polar-sh/sdk` is allowed only under `apps/worker/src/billing/providers/polar/**`, and `billing/providers/**` may not import `ledger`, `purchases`, `apply` or `pool/*`. Adapters stay stateless and can't grow domain logic.

---

## 3. Data flows, end to end

- **Top-up:** `POST /api/billing/checkout` → `assertPurchasable` (domain) → bounds → `provider.createTopUpCheckout({ buyer, target, accountId, amountCents, successUrl, cancelUrl })`. Polar: `checkouts.create` with an ad-hoc price, `external_customer_id`, and `metadata { kind:'credits', target, accountId, userId, v:1 }` → `{ url }`. Later, `order.paid` → `map.ts` → `payment.succeeded` → `fulfilPurchase`.
- **Membership:** `POST /api/billing/membership/checkout` → already active (local `billing_subscriptions`) → portal URL; else `createMembershipCheckout`. `subscription.*` → `membership.changed` → upsert. `order.paid` (`subscription_create` / `subscription_cycle`) → `payment.succeeded` (membership) → included credit.
- **Portal:** `POST /api/billing/portal` → `createPortalSession` → `{ url }`, or 404 `no_customer`.
- **Deletion:** `deleteUser` → `provider?.deleteCustomer({ userId, customerRef })` (Polar: revoke active subscriptions, then `customers.deleteExternal(userId, { anonymize: true })`; a 404 means `'absent'`) → the D1 batch also deletes `billing_subscriptions` and `billing_customers` rows. When `paymentsConfigured` is false but `billing_customers` rows exist, it logs for the operator, as today.

---

## 4. Schema

| Table / column | Decision | Why |
|---|---|---|
| `credit_grants.stripe_ref` → **`provider_ref`** (unique) | Rename (same as stage 2) | It is the single idempotency mechanism for every provider. |
| `provider` column on `credit_grants`? | **No.** The namespaced ref (`polar:order:…`) already records the provider; `admin:`/`dev:` grants have none. Reporting uses `provider_ref LIKE 'polar:%'`. | Avoids a redundant column that could disagree with the ref. |
| `auth_users.stripe_customer_id` | **Drop** (not rename) | A single provider-specific id on the user row becomes ambiguous after a switch. |
| **New `billing_customers`** `(provider TEXT, user_id TEXT, customer_ref TEXT, created_at TEXT, PRIMARY KEY (provider, user_id))`, index `(provider, customer_ref)` | Written by the domain from any event that carries both ids, and from `RedirectSession.customerRef` | Gives admin lookups (D6), "is there a customer to delete", and a home for adapters that need stored customer ids, with no schema change at the next switch. |
| `auth_subscriptions` | Drop | Plugin-owned. |
| **New `billing_subscriptions`** `(ref TEXT PRIMARY KEY` -- namespaced `polar:subscription:<id>`, `provider TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL` -- 'membership', `status TEXT NOT NULL` -- normalised `SubscriptionStatus`, `provider_status TEXT NOT NULL, current_period_end TEXT, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, ended_at TEXT, version TEXT NOT NULL, updated_at TEXT NOT NULL)`, index `(user_id, kind)` | **Yes, store `provider` per row** | Pre-launch it is always `polar`. In a post-launch switch, old subscribers' rows (served by the legacy adapter until they lapse) and new ones coexist, and `membershipFor` treats both uniformly by `status`. |

`membershipFor` keeps its single query and moves its join to `billing_subscriptions`, with `ACTIVE_STATUSES = ['active','trialing','past_due']` applied to the **normalised** status.

Migrations: **0014** renames `provider_ref` and creates the two new tables, which ship unused while Stripe still runs. **0015** drops `auth_subscriptions` and `auth_users.stripe_customer_id`, in the Stripe-removal commit. Splitting them keeps every commit green; stage 2 had one migration.

---

## 5. Shared types and frontend: neutral by construction

`packages/shared/src/billing.ts`:

- `export const SUBSCRIPTION_STATUSES = ['trialing','active','past_due','unpaid','paused','incomplete','canceled'] as const; export type SubscriptionStatus`.
- `MembershipInfo.stripeStatus` → **`subscriptionStatus: SubscriptionStatus | null`**. The frontend uses it in only two ways: "is there a subscription" (portal button) and "`past_due`" (a warning). A normalised union serves both and never leaks a provider's vocabulary.
- `CheckoutResponse { url }` documented as "the hosted payment page". `PortalResponse = CheckoutResponse`.
- Error code `no_customer` (404) on `/api/billing/portal`. It replaces the plugin's `CUSTOMER_NOT_FOUND` / `SUBSCRIPTION_NOT_FOUND`.
- `MEMBERSHIP_PLAN` leaves shared, because it was a plugin concept. The worker keeps a private `MEMBERSHIP_KIND = 'membership'` for checkout metadata.
- Comments say "the payment provider" or "processing fee", never a name.

`packages/web-shared`:

- Remove `stripeClient` and `@better-auth/stripe`. **No provider package in the browser** (hosted checkout, D12).
- `BillingClient` becomes two `ApiClient` methods: `membershipCheckout(): Promise<CheckoutResponse>` and `billingPortal(returnPath): Promise<CheckoutResponse>`, plus `navigate(url)`. Delete `list()` and `BillingSubscription`.
- UI copy says "secure checkout", "billing portal", "payment processing fee", "your customer record with our payment provider (named in the Privacy Policy)".
- The demo backend (`demo/backend.ts`) already fakes `/api/billing` in the browser and needs no payment provider. It only follows the `subscriptionStatus` rename.

**Provider names appear only** in `http/legal.ts` (Terms, Privacy: Polar as Merchant of Record), `docs/LEGAL.md`, the README setup section, `wrangler.jsonc` / `.dev.vars.example`, and `billing/providers/polar/**`. A grep check in `scripts/` (run by `pnpm lint`) fails on `/stripe|polar/i` in `packages/*/src` and `apps/{web,simple,canvas,admin}/src`.

---

## 6. Testing strategy

| Layer | How | Files |
|---|---|---|
| **Domain** (credit once, fee pass-through, pool margin, refunds personal/pool/membership-once, out-of-order refund → retry, dispute open/won/lost incl. lost-first, suspension, membership version guard, deletion contract) | Against the **fake provider**. Event builders (`test/mocks/payment-events.ts`: `paid({...})`, `refunded(...)`, `disputed(...)`, `membership(...)`) feed `applyPaymentEvent(env, e, { provider: fake })` directly, plus a few through `POST /api/webhooks/fake`. **No wire formats.** A future switch leaves these files untouched. | `payments-apply.test.ts`, `payments-refunds.test.ts`, `payments-disputes.test.ts`, the domain scenarios of `pool-purchase.test.ts`, `billing-membership.test.ts`, `accounts.test.ts`, `multi-user.test.ts` |
| **Checkout / portal routes** | `PAYMENT_PROVIDER: 'fake'` in the vitest bindings, with `TEST_SEAMS` already `true`. The fake's URLs encode their input (`https://fake-pay.invalid/checkout#<base64url JSON of TopUpCheckoutInput>`), so tests assert what the domain asked for with no shared module state between the test and the Worker. Fake options: `{ capabilities, portalCustomer: boolean, deleteResult, payments: Map<ref, PaymentFacts>, disputes: DisputeEvent[] }`. | `billing-checkout.test.ts`, `billing-routes.test.ts` |
| **Polar adapter: mapping** | Pure. JSON fixtures in `test/fixtures/polar/` (`order.paid.credits.json`, `order.paid.subscription_create.json`, `…subscription_cycle.json`, `refund.created.pending.json`, `refund.updated.succeeded.json`, `subscription.{active,canceled,revoked,past_due}.json`, `disputes.list.json`). Each is signed with a test secret by a Standard-Webhooks helper (`signStandardWebhook(body, secret)`: HMAC-SHA256 over `${id}.${ts}.${body}`) and run through the **real** `webhooks.validateEvent` inside `adapter.parseWebhook`. Each test asserts `toEqual` against the expected neutral events. Also covered: bad signature → `WebhookSignatureError`, unknown type → `ignored`, `prevented` dispute → no event, non-USD passed through (the domain decides). Fixtures start as hand-written from the SDK types (marked `"_synthetic": true`); stage 4's sandbox step (stage 2 §6.3) **replaces them with recorded deliveries**, which also settles the PLAUSIBLE fields (`platform_fee_amount`, `Refund.amount` pre-tax, `modified_at`). | `polar-adapter-map.test.ts` |
| **Polar adapter: outbound** | `test/mocks/polar.ts` HTTP mock at `sandbox-api.polar.sh` through `outboundService`, the existing pattern. It asserts request bodies for `checkouts.create`, `customerSessions.create` (and its 404), `subscriptions.list`/`revoke` + `customers.deleteExternal`, `orders.get`, and `disputes.list` paging. | `polar-adapter-api.test.ts` |
| **Contract smoke** | Two end-to-end tests: a signed Polar `order.paid` → `POST /api/webhooks/polar` → a grant row; a signed `refund.updated` → a debit. They prove the route and the real adapter wire up. | `payment-webhooks-endpoint.test.ts` |
| Cron | Spy `CronJobs.paymentDisputes`; with the fake in `poll` mode, the second run is a no-op. | `cron.test.ts` / `payments-disputes.test.ts` |

A future adapter adds `providers/<x>/` with its own fixture and outbound tests. The domain suite runs unchanged.

---

## 7. What NOT to abstract

- **The SDK or HTTP layer.** No generic "PaymentClient" wrapper or provider-neutral retry layer. Each adapter uses its SDK directly.
- **Product and price catalogue management.** Product ids are adapter config (env vars). Products, prices and portal settings are created in the dashboard, as documented in the README.
- **A subscription engine.** One plan, yearly, with no plan switching, proration, trials, seats or pausing in the domain. `MembershipChanged` is all the domain needs.
- **Fee math and minimums.** `fulfilPurchase`, `netOfFee` and the pool margin stay as they are. The fee is just a number from the adapter. Minimums and margins (D4) are business constants, revisited per provider by a human.
- **Tax.** No tax model. MoR vs. non-MoR differences live inside each adapter's checkout call. The domain sees `netCents`/`taxCents`.
- **Currency.** USD only. Adapters report `currency`; the domain rejects anything else.
- **Usage metering in the provider** (D13). The internal ledger stays authoritative.
- **Embedded checkout UI** (D12). Redirects only.
- **Legal text, README setup and dashboard runbooks.** These are provider-specific by nature. They are written by hand, never templated by provider name.
- **Multiple simultaneous checkout providers** or per-user provider routing. One active provider, with an optional webhook-only legacy slot added only when a post-launch switch needs it.
- **A generic event store or outbox table.** Ledger refs give idempotency, and `billing_subscriptions.version` gives ordering.
- **Better Auth.** Payments no longer touch auth at all (D2).
- **A runtime schema (zod) for `PaymentEvent`.** The types plus adapter mapping tests suffice. Add one only if a third adapter appears.

---

## 8. Deviations from stage 2's mapping

| # | Stage 2 | This document | Why |
|---|---|---|---|
| 1 | `billing/polar-webhook.ts` `handlePolarEvent(env, event: Polar)` mixing mapping and ledger writes | Pure `providers/polar/map.ts` → `PaymentEvent`, plus a neutral `payments/apply.ts` | Same behaviour, but domain logic and tests survive the next switch. |
| 2 | `routes/polar-webhook.ts` at `/api/webhooks/polar` | Neutral `routes/payment-webhooks.ts` at `/api/webhooks/:provider` | Same URL for Polar. The 202/403/500 contract is written once, and the route can host a legacy provider. |
| 3 | `billing/polar-disputes.ts`, cron job `polarDisputes` | `payments/disputes.ts`, `CronJobs.paymentDisputes`, driven by `DisputeSource` | A provider with dispute webhooks needs no cron change. |
| 4 | `polarPurchases(env)` (`PurchaseProvider`) | Remove `PurchaseProvider`; `startTopUpCheckout` calls the port | The port subsumes it. |
| 5 | `auth_users.stripe_customer_id` → `billing_customer_id` | Drop the column; new `billing_customers(provider, user_id, customer_ref)` | Unambiguous across providers; no schema change at the next switch. |
| 6 | `billing_subscriptions.id` = Polar id, raw Polar `status`, `product_id`, `modified_at` | `ref` namespaced; `status` **normalised** plus `provider_status` raw; `version`; no `product_id` (the adapter decides `kind`) | The domain and frontend never see provider vocabulary. |
| 7 | `MembershipInfo.providerStatus: string` | `subscriptionStatus: SubscriptionStatus \| null` | A raw provider string in a shared type is still a leak. |
| 8 | Membership-refund ref `polar:membership-refund:<order_id>` | `membershipRefundRef(paymentRef)` = `polar:order:<id>:membership-refund` (derived by the domain) | One provider-minted ref per object; the domain derives secondary keys. Same semantics. |
| 9 | Refund with no local grant → `orders.get` inside the handler | `provider.getPayment(paymentRef)` on the port | Keeps the domain SDK-free. |
| 10 | No provider selector | `PAYMENT_PROVIDER` (default `polar`; `fake` only with `TEST_SEAMS`) | Mirrors `EMAIL_PROVIDER`, and lets tests use the fake. |
| 11 | Rewrite domain tests on Polar payloads (`billing-webhook.test.ts`, `pool-purchase.test.ts`, …) | Domain tests on neutral events and the fake; Polar wire-format tests limited to adapter mapping, outbound and two smoke tests | This was the most expensive part of this migration and would be again. |
| 12 | Copy names Polar in the UI (delete-account, landing, billing page) | UI says "payment provider"; Polar only in legal pages, README and config | UI and specs stay untouched in a switch. The legal pages carry the disclosure. |
| 13 | One migration 0014 | 0014 (additive + rename), 0015 (drop the Stripe tables and column) | Each commit stays green while Stripe code still exists. |
| 14 | D3 fallback estimate decided in the handler | The adapter fills `fee: { cents, estimated: true }` | The fee formula is provider knowledge. |

Unchanged from stage 2: D0 (hard cutover, §6.0 guard checks), D1 (`POOL_PURCHASES_ENABLED`), D2, D3 (fee source), D4 (minimums), D5 (polling), D7 (a local table, not per-request state), D8 (`POLAR_SERVER` default sandbox), D9, D10, D12–D15. Also unchanged: the env vars of §4.2, the dependency changes of §4.3, the docs list of §3.5, and the cutover plan of §6.

---

## 9. Stage 4 implementation plan (commit-sized; each leaves `pnpm typecheck`, `pnpm lint` and `pnpm test` green)

1. **Neutral names, no behaviour change.** Migration 0014: `stripe_ref` → `provider_ref` (plus its unique index); create `billing_customers` and `billing_subscriptions` (unused). In `schema.ts`, `ledger.ts`, `pool-bank.ts` and `routes/admin.ts`, rename `stripeRef` to `providerRef` and update comments. Fixtures and helpers (`grantsFor` etc.) are updated mechanically. Check by hand that the drizzle-kit snapshot emits a rename, not drop+add. Stripe still works.
2. **Port, refs, fake.** Add `payments/port.ts`, `refs.ts`, `providers/fake.ts`, and `payments/index.ts` (only `fake` and null for now; `polar` lands in step 4). Add `SUBSCRIPTION_STATUSES` to shared (additive). Unit tests: fake URL encoding and refs helpers.
3. **Domain handler on the fake.** Add `payments/apply.ts`, `customers.ts` and `disputes.ts`. **Move** `debitPoolPurchase`, the dispute helpers and `MEMBERSHIP_CREDIT_NOTE` from `webhook.ts`, re-typed on neutral inputs, and have `webhook.ts` call them through thin shims so Stripe keeps passing. Add `test/mocks/payment-events.ts` and the domain suites of §6 (`payments-apply`, `-refunds`, `-disputes`, membership upsert/version guard).
4. **Polar adapter, not wired.** `pnpm add @polar-sh/sdk@1.0.2` (exact). Add optional `POLAR_*` entries to `env.ts` and `worker-configuration.d.ts`, the `providers/polar/{config,client,map,adapter}.ts` modules, `test/mocks/polar.ts` with an `outboundService` case, synthetic fixtures with `signStandardWebhook`, and `polar-adapter-map` / `polar-adapter-api` tests. Register `polar` in `payments/index.ts` behind `PAYMENT_PROVIDER` (the default stays effectively Stripe until step 6, because Polar secrets are unset in tests and prod). Add the eslint `no-restricted-imports` boundary.
5. **Ingress.** Add `routes/payment-webhooks.ts` and register it in `app.ts` before `sessionMiddleware`. Add `CronJobs.paymentDisputes` to `CRON_FREQUENT` with `.catch`. Endpoint tests: fake (signature, 202, 500, ordering) plus the two Polar smoke tests. The Stripe endpoint still runs in parallel; harmless pre-launch.
6. **Switch the domain to the port.** Vitest bindings get `PAYMENT_PROVIDER: 'fake'` (the Polar suites override with `POLAR_*`). Changes:
   - `paymentsConfigured` replaces `billingConfigured` (`services.ts`, `membership.ts`, `service.ts`); `topUpsEnabled` and `membershipRequired` come from `capabilities`.
   - `routes/billing.ts` checkout goes through `startTopUpCheckout`; add `POST /membership/checkout` and `POST /portal` (`sameOriginOnly`, signed in, 404 `no_customer`).
   - `membershipFor` reads `billing_subscriptions`.
   - `deleteUser` goes through `deleteCustomer` + `billing_customers` (`DeletedUser.billingCustomerDeleted`).
   - Shared: `stripeStatus` → `subscriptionStatus`, `no_customer`, `MEMBERSHIP_PLAN` moved into the worker. Mechanical fixture renames in the web-shared/apps specs and `demo/backend.ts`, in the same commit so every package typechecks.
   - Rewrite `billing-checkout`, `billing-membership`, `annual-fee` and `accounts` tests on the fake.
7. **Frontend client.** `ApiClient.membershipCheckout` / `billingPortal`; delete `BillingClient`'s plugin path and `BillingSubscription`; `billing-controller` maps `no_customer`; remove `stripeClient` from `auth-client.ts`; neutral UI copy (billing page, pool fund, delete-account, landing); update the specs.
8. **Remove Stripe.** Delete `stripe.ts`, `webhook.ts`, the plugin in `auth.ts` (plus the `subscription` schema mapping), `test/mocks/stripe.ts`, `billing-webhook*.test.ts` and the Stripe parts of `pool-purchase.test.ts` (already covered by step 3). Remove `stripe` and `@better-auth/stripe` from the three `package.json` files and the lockfile. Remove the `STRIPE_*` entries from `env.ts`, `wrangler.jsonc` (add `PAYMENT_PROVIDER: "polar"`, `POLAR_SERVER: "production"`, the product-id vars, `POOL_PURCHASES_ENABLED: "false"`) and `.dev.vars.example`. Migration 0015 drops `auth_subscriptions` and `auth_users.stripe_customer_id` (index first). Grep guard: `git grep -il stripe -- ':!apps/worker/migrations' ':!docs/pool' ':!docs/polar-migration'` returns only intentional legal mentions ("Polar uses Stripe").
9. **Guards.** Add the `scripts/check-provider-neutral.mjs` grep to `pnpm lint` (§5). Add a `payments/index.ts` test: an unknown `PAYMENT_PROVIDER` throws, and `fake` without `TEST_SEAMS` throws.
10. **Docs and legal.** README billing section (Polar setup, events, OAT scopes, fees), `docs/DECISIONS.md` "Payments behind a port (Polar)" (superseding the Stripe bullets, recording §2 rules and §7), the `docs/PLAN.md` diagram, `http/legal.ts` + `docs/LEGAL.md` (Polar as MoR; bump `LEGAL_UPDATED`; operator review, D14), `DEFERRED.md`.
11. **(Stage 4 sandbox, from stage 2 §6.3.)** Record real deliveries, replace the synthetic fixtures, and resolve the PLAUSIBLE fields. Any surprise changes only `providers/polar/map.ts` and its fixtures, which is the architecture's first payoff.

Rough size: the port and fake are about 250 lines, `apply.ts` + `disputes.ts` + `customers.ts` about 350 (mostly moved code), and the Polar adapter about 400. Net billing code shrinks, because `webhook.ts`'s Stripe lookups (fee expansion, session-by-PaymentIntent, invoice payments, tax ratio) have no Polar equivalent to write.

**What the next switch costs:** add `providers/<x>/` (config, client, map, adapter, fixtures, two test files), one literal in `ProviderId`, one case in `payments/index.ts`, its env vars, the legal text, the README and the dashboard setup. Post-launch, also set `PAYMENT_PROVIDER_LEGACY` for the old provider's refund window. Nothing in the ledger, schema, shared types, frontend or domain tests changes.
