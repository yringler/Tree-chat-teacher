# Polar.sh research for the Stripe → Polar migration (stage 1)

Date: 2026-10-05. Sources: the npm registry, the installed `@polar-sh/sdk@1.0.2` and `@polar-sh/better-auth@2.0.1` packages (their `.d.mts` types, compiled source and bundled agent docs were read directly), and the Polar docs at https://polar.sh/docs (index: https://polar.sh/docs/llms.txt).

Statements marked **VERIFIED** were checked against SDK types or source, or run under workerd. Statements marked **UNVERIFIED** come from docs or inference and were not exercised.

---

## 0. What this repo uses from Stripe today

Taken from `apps/worker/src/billing/*.ts`, `apps/worker/src/auth/{auth,delete-account}.ts`, `packages/web-shared/src/core/{auth-client,billing-client}.ts`:

| Stripe feature | Where | Purpose |
|---|---|---|
| `checkout.sessions.create` with `mode: 'payment'`, ad-hoc `price_data` (`unit_amount` = user-chosen `amountCents`, product `STRIPE_CREDITS_PRODUCT_ID`, `tax_behavior: 'exclusive'`), `automatic_tax`, `invoice_creation`, `billing_address_collection: 'required'`, `customer`, `client_reference_id`, `metadata` + `payment_intent_data.metadata` | `billing/service.ts` | Variable-amount credit top-ups, either `personal` or `pool` (community pool) |
| `customers.create` with an `idempotencyKey`, mapped through `auth_users.stripe_customer_id` | `billing/stripe.ts` | Lazy customer creation |
| `customers.del` | `auth/delete-account.ts` | Account deletion |
| Better Auth Stripe plugin (`@better-auth/stripe` 1.7.7): one yearly `membership` plan, `auth_subscriptions` table, `subscription.upgrade/billingPortal/list` on the client, `onEvent` passthrough, Stripe Tax and tax-ID collection on the subscription checkout | `auth/auth.ts`, `web-shared` | Yearly membership with the customer portal |
| Webhooks: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, `charge.refunded`, `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`, `charge.dispute.closed` | `billing/webhook.ts` | Ledger credits and debits |
| `paymentIntents.retrieve` (expanded `balance_transaction.fee`), `charges.retrieve`, `refunds.list`, `invoicePayments.list`, `checkout.sessions.list` | `billing/webhook.ts` | Fee-net crediting, refund and dispute attribution |

Not used: Connect, metered/usage prices (metering is internal: `billing/meter.ts` and the OpenRouter reconcile), customer balance, saved-card off-session charges, coupons.

---

## 1. SDK options

### 1.1 `@polar-sh/sdk`: new v1 line (VERIFIED)

- Latest version is **1.0.2** (published 2026-10-02). 1.0.0 shipped 2026-09-28 after 22 alphas. MIT license, source at `polarsource/polar` under `sdk/typescript`.
- **The v1 SDK is a full rewrite.** The pre-1.0 Speakeasy SDK (`new Polar({...})`, camelCase fields, `@polar-sh/sdk/webhooks`) is gone. Most blog posts and examples online, and the `@polar-sh/hono` adapter, still show the old API. Don't copy them.
- ESM and CJS dual package, `"type": "module"`, `sideEffects: false`, **no runtime dependencies**.
- **API versioning lives in the import path.** Each subpath pins the `Polar-Version` header:
  - `@polar-sh/sdk/2026-04`: Deprecated (removed in Jan 2027)
  - `@polar-sh/sdk/2026-10`: **Current**. The README and the bundled skill use it, so use it.
  - `@polar-sh/sdk/2027-01`: Next (may still change)
  - Each version also exposes tree-shakable `.../services/<name>` functions.
  - Docs: https://polar.sh/docs/api-reference/2027-01/versioning.md. Polar releases a version every quarter, and each one is supported for about 9 months (3 as Next, 3 as Current, 3 as Deprecated). A request without the header gets Current. An unknown or removed version returns 404. **Plan for a version bump roughly every 6 months.**
- Conventions: service and method names are camelCase, but **request and response fields are snake_case** (`external_customer_id`, `success_url`). Path params are positional, the query object comes next, and the body is a single object. Pagination uses `list()` (one page) and `iterList()` (an async generator over items).
- Errors (from `@polar-sh/sdk`): `PolarClientError{statusCode,error}`, `PolarRateLimitError{retryAfter}`, `PolarServerError`, `PolarNetworkError`. Each version also exports typed endpoint errors under the `errors` namespace.
- **No automatic retries, and no idempotency-key support.** `RequestOptions` contains only `{timeout, accessToken}`. The API docs never mention idempotency keys.
- **The default request timeout is 5 seconds** (`ClientBase`: `timeout: 5`). Set it explicitly, e.g. `timeout: 15`.
- **Runtime:** the client is pure `fetch` plus `AbortSignal.timeout`/`AbortSignal.any`, and webhooks use `globalThis.crypto.subtle` and `atob`. There are no `node:` imports.
  - **VERIFIED under workerd.** I ran `wrangler dev` with compat date 2026-08-15 and `nodejs_compat`. `webhooks.validateEvent` accepted a valid Standard-Webhooks signature and threw `PolarWebhookVerificationError` on a bad one. `customers.getStateExternal` reached `sandbox-api.polar.sh` and surfaced a typed `PolarClientError 401 invalid_token`.
- The client calls global `fetch` with no injectable fetch, so in vitest-pool-workers mock it with `fetchMock` or outbound interception.

```ts
import { createPolar, createPolarCore, webhooks, errors, models } from '@polar-sh/sdk/2026-10';
import { PolarClientError, PolarRateLimitError } from '@polar-sh/sdk';

const polar = createPolar({
  accessToken: env.POLAR_ACCESS_TOKEN,          // polar_oat_…
  environment: env.POLAR_SERVER === 'sandbox' ? 'sandbox' : 'production', // or baseUrl
  timeout: 15,                                  // seconds; default 5
});
```

Base URLs (from the compiled source): `https://api.polar.sh` and `https://sandbox-api.polar.sh`. Paths are `/v1/...`.

Full `createPolar` service surface for 2026-10 (VERIFIED):

- `organizations`, `subscriptions` (list/create/export/get/revoke/update)
- `oauth2`, `benefits`, `benefitGrants`
- `webhooks` (endpoint CRUD, deliveries, redeliver)
- `products` (CRUD, updateBenefits)
- `orders` (list/create/export/get/update/finalize/invoice/generateInvoice/receipt)
- `refunds` (list/**create**), `disputes` (list/get/accept)
- `checkouts` (list/create/get/update/client*), `checkoutLinks`
- `files`, `metrics`, `licenseKeys`, `customFields`, `discounts`
- `customers` (list/create/export/get/delete(anonymize)/update/**getExternal/deleteExternal/updateExternal/getState/getStateExternal**/listPaymentMethods)
- `customerPortal.*` (benefitGrants, customers, customerMeters, seats, customerSession, downloadables, licenseKeys, members, orders, organizations, subscriptions, wallets)
- `customerSeats`, `customerSessions` (create)
- `events` (list/listNames/get/**ingest**), `eventTypes`, `meters` (CRUD, quantities), `customerMeters` (list/get)
- `payments` (list/get)

### 1.2 Framework adapters

| Package | Version | SDK it uses | Notes |
|---|---|---|---|
| `@polar-sh/better-auth` | 2.0.1 (2026-10-02) | `@polar-sh/sdk ^1.0.2` (peer), peer `better-auth ^1.7.0`, `zod ^3.25 \|\| ^4` | **Relevant: this repo uses Better Auth 1.7.7.** See 1.3. |
| `@polar-sh/nextjs` | 1.0.1 | sdk 1.0.2 | Not relevant |
| `@polar-sh/adapter-utils` | 1.0.1 | sdk 1.0.2 | Shared by the adapters |
| `@polar-sh/hono` | 0.5.6 (2026-09-02) | **old `@polar-sh/sdk ^0.47`** | Not migrated to v1 yet. **Avoid it**; a hand-written Hono route is about 20 lines. |
| `@polar-sh/checkout` | 0.4.2 | — | Embedded checkout for React (peer `@stripe/stripe-js`) |
| `@polar-sh/ingestion` | 0.4.2 | old sdk ^0.41 | LLM/S3 ingestion strategies; old SDK. Not needed: we already compute cost ourselves. |

### 1.3 Better Auth plugin `@polar-sh/better-auth` 2.0.1 (VERIFIED from README and dist)

```ts
import { polar, checkout, portal, usage, webhooks } from '@polar-sh/better-auth';
import { createPolarCore } from '@polar-sh/sdk/2026-10';
const polarClient = createPolarCore({ accessToken, environment: 'sandbox' }); // must be createPolarCore in 2.x
polar({
  client: polarClient,
  createCustomerOnSignUp: false|true,   // when true: creates a customer with external_id = user.id; syncs email/name; deletes on user delete
  getCustomerCreateParams: async ({ user }) => ({ metadata: {...} }),
  use: [
    checkout({ products: [{ productId, slug: 'membership' }], successUrl: '/billing?checkout_id={CHECKOUT_ID}', authenticatedUsersOnly: true, returnUrl }),
    portal({ returnUrl }),
    usage(),
    webhooks({ secret, onOrderPaid, onOrderRefunded, onRefundCreated, onSubscriptionActive, onCustomerStateChanged, onPayload, ... }),
  ],
});
// client: createAuthClient({ plugins: [polarClient()] }) from '@polar-sh/better-auth/client'
```

- Endpoints are registered under the Better Auth base path:
  - `POST /checkout` (body fields are snake_case, plus adapter-specific `slug`, `reference_id`, `organization_id`, `redirect`)
  - `/customer/portal`, `/customer/state`, `/customer/{benefits,orders,subscriptions}/list`
  - `/usage/ingest`, `/usage/meters/list`
  - `POST /polar/webhooks`, which is `/api/auth/polar/webhooks` by default
- **No DB schema.** The plugin adds no `subscriptions` table. The Stripe plugin's `auth_subscriptions` sync has no counterpart, so membership status must come from customer state or webhooks into our own table.
- Webhook endpoint behaviour: an unknown but signed event type gets 200 `{received:true}`. A bad signature gets 403. If a handler throws, the endpoint answers **500**, which makes Polar retry. That matches the current "throw from `onEvent` → 400 → Stripe retries" contract.
- The `checkout()` endpoint does **not** accept ad-hoc `prices`, `amount` or a custom `customer_billing_address`. It takes products, metadata, discount, seats, trial, URLs and `embed_origin`. Variable-amount credit top-ups therefore still need our own server-side `checkouts.create` call (see 2.4).
- `engines.node >= 24` is declared, but the dist has no `node:` imports. **UNVERIFIED** that the plugin itself bundles and runs under workerd; the SDK it uses was verified.
- Recommendation: the plugin is optional here. It gives the membership checkout, portal redirect and webhook route cheaply. Our own code (a Hono route plus about 3 SDK calls) gives full control and avoids coupling to a fast-moving 2.x adapter. Decide in stage 2.

### 1.4 Raw REST

Send `Authorization: Bearer polar_oat_…`, `Polar-Version: 2026-10` and `Content-Type: application/json`. OpenAPI and reference live at https://polar.sh/docs/api-reference. Pagination is `page`/`limit`, with `limit` up to 100 and `pagination.total_count`/`max_page` in the response.

---

## 2. Core objects

### 2.1 Organization and access tokens

- One organization is the merchant. Authenticate with an **Organization Access Token (OAT)**, prefix `polar_oat_`, created in Settings and scoped to that org.
  - Polar takes part in GitHub secret scanning, and leaked tokens are revoked automatically (https://polar.sh/docs/integrate/authentication.md).
  - Scopes are chosen when the token is created; the better-auth README names e.g. `customers:read/write`, `members:*`, `subscriptions:*`.
  - **UNVERIFIED:** the full scope list and the token expiry options.
- Sandbox and production are fully separate: different orgs, tokens, products and webhook secrets.
- Many features are **per-organization flags** (`OrganizationFeatureSettings`, VERIFIED): `wallets_enabled`, `off_session_charges_enabled`, `disputes_enabled`, `dispute_auto_accept_enabled`, `merchant_migration_enabled`, `meter_cycling_enabled`, `member_model_enabled`, `reset_proration_behavior_enabled`. Some need Polar support to enable.
- `OrganizationSubscriptionSettings` (VERIFIED): `allow_multiple_subscriptions`, default `proration_behavior`, `benefit_revocation_grace_period`, `prevent_trial_abuse`, `allow_customer_updates`.

### 2.2 Products and prices (VERIFIED)

- A product is **either one-time or recurring**: `recurring_interval: 'day'|'week'|'month'|'year'` plus `recurring_interval_count`. A product has prices; Stripe's separate Price object as a catalog primitive doesn't exist.
- Price create types (`amount_type`):
  - `fixed`: `price_amount` in cents; 0 means free
  - `custom`: pay-what-you-want, with `minimum_amount`, `maximum_amount` and `preset_amount`. USD bounds are $0.50 to $999,999.99, and `minimum_amount: 0` means "free or PWYW"
  - `seat_based` (tiers), `unit_based` (tiers by purchased quantity, with `unit_label`)
  - `metered_unit` (`meter_id`, `unit_amount` with up to 12 decimals, `cap_amount`), `metered_tiers`
- Allowed combinations: at most one fixed price plus one seat price, **or** a single custom or free price, plus any number of metered prices. **Metered prices are not allowed on one-time products.**
- Each price has `price_currency` (PresentmentCurrency: about 130 lowercase ISO codes) and `tax_behavior: 'location'|'inclusive'|'exclusive'`. The default is the org default.
- Recurring products can set `meter_interval`, e.g. yearly billing with monthly credits. It is immutable once set.
- `visibility`, `metadata` (up to 50 keys, keys of 40 chars, string values up to 500 chars, or int/float/bool), `medias`, `attached_custom_fields`, and trial settings.

### 2.3 Checkout sessions, checkout links and embedded checkout (VERIFIED types)

```ts
const checkout = await polar.checkouts.create({
  products: [env.POLAR_CREDITS_PRODUCT_ID],
  // Ad-hoc price per checkout ≈ Stripe price_data:
  prices: {
    [env.POLAR_CREDITS_PRODUCT_ID]: [
      { amount_type: 'fixed', price_amount: amountCents, price_currency: 'usd', tax_behavior: 'exclusive' },
    ],
  },
  // Alternatively, with a catalog `custom` (PWYW) price: `amount: amountCents`
  external_customer_id: user.id,           // links/creates the Polar customer with external_id
  customer_email: user.email,
  customer_name: user.name,
  require_billing_address: true,
  metadata: { kind: 'credits', target, accountId, userId: user.id, amountCents },
  success_url: 'https://…/billing/success?checkout_id={CHECKOUT_ID}',
  return_url: 'https://…/billing',
  // embed_origin: 'https://app.example' for embedded checkout
});
return { url: checkout.url };
```

- **Metadata set on the checkout is copied to the resulting order and/or subscription.** VERIFIED from the doc comment on `CheckoutCreate`. So `order.metadata` stands in for `session.metadata` and `payment_intent_data.metadata`.
- Ad-hoc prices are marked `source: "ad_hoc"` (https://polar.sh/docs/features/checkout/session.md).
- Other `CheckoutCreate` fields:
  - `customer_id`, `customer_ip_address` (derives country and currency), `customer_billing_address`, `customer_tax_id`, `is_business_customer`, `customer_metadata` (copied to the customer)
  - `discount_id`, `allow_discount_codes`, `allow_trial`, `trial_interval`
  - `seats`/`units` with min/max, `currency`, `locale`, `custom_field_data`
  - `subscription_id`, which upgrades a *free* subscription through checkout
- There is no equivalent of `client_reference_id`; use metadata. There is no `invoice_creation`, because Polar always produces invoices and receipts for paid orders.
- Checkout `status`: `open | expired | confirmed | succeeded | failed`. Read `expires_at` from the response. **UNVERIFIED:** the default expiry duration.
- **Checkout Links** (`checkoutLinks.*`) are reusable, shareable URLs for fixed product sets. They don't fit variable amounts.
- **Embedded checkout:** pass `embed_origin` and use `@polar-sh/checkout` (React) or `authClient.checkoutEmbed()`. The org flag `frame_ancestors_enforced` restricts framing hosts.
- The checkout collects billing country and address and computes tax. Polar is the Merchant of Record, so tax is Polar's (see section 5).

### 2.4 Customers and `external_id` (VERIFIED types)

```ts
// Create: email is required and must be unique within the organization
const c = await polar.customers.create({ external_id: user.id, email: user.email, name: user.name, metadata: { userId: user.id } });
await polar.customers.getExternal(user.id);
await polar.customers.updateExternal(user.id, { email, name });
await polar.customers.deleteExternal(user.id, { anonymize: true });  // GDPR-style anonymize option
const state = await polar.customers.getStateExternal(user.id);
```

- `external_id` is **unique per org and immutable once set**. It can be set later if it starts out null. It replaces the `auth_users.stripe_customer_id` column: we can address the Polar customer by our user id and never store Polar's id. Storing it anyway is fine for joins.
- **Email is unique per organization**, VERIFIED from the doc comment. A user who changes email must be pushed with `updateExternal`.
- **There is no idempotency key.** To handle concurrent first checkouts, rely on `checkouts.create({ external_customer_id })`, which creates the customer itself if it's missing. If creating explicitly, catch the conflict and fall back to `getExternal`. The SDK's bundled guidance says the same.
- Customer types: `individual` or `team` (with members and seats). We only need `individual`.
- `default_payment_method_id`; `listPaymentMethods(External)`.

### 2.5 Customer state, sessions and portal

- `customers.getStateExternal(id)` returns the customer plus `active_subscriptions[]`, `granted_benefits[]` and `active_meters[]` (`{meter_id, consumed_units, credited_units, balance}`). It is the recommended entitlement check. The `customer.state_changed` webhook pushes the same snapshot (https://polar.sh/docs/integrate/customer-state.md).
- Portal: `polar.customerSessions.create({ external_customer_id, return_url })` returns `{ token, expires_at, customer_portal_url }`. Redirect to `customer_portal_url`; it's pre-authenticated.
  - The hosted portal is at `polar.sh/<org-slug>/portal`. Customers can view orders, download and edit invoices (VAT ID), see receipts, cancel subscriptions and update payment methods. Plan switching, pausing, usage view and email changes are optional settings.
  - The portal can't be restyled; the Customer Portal API (`customerPortal.*`, with a customer-session token) can power a custom UI, but payment-method updates stay in the hosted portal.
  - Source: https://polar.sh/docs/features/customer-portal/introduction.md

### 2.6 Subscriptions (VERIFIED types)

- `SubscriptionStatus`: `incomplete | incomplete_expired | trialing | active | past_due | canceled | unpaid | paused`. Fields include `current_period_start/end`, `cancel_at_period_end`, `canceled_at`, `ends_at`, `ended_at`, `pause_at_period_end`, `pending_update`, `metadata` and `prices`.
- **Create:** `subscriptions.create({ product_id, external_customer_id })` works **only for free products**. Paid subscriptions must go through a checkout.
- **Update:** `subscriptions.update(id, body)` takes one of these bodies:
  - `{ product_id, proration_behavior: 'invoice'|'prorate'|'next_period'|'reset', discount_id, trial_end, metadata }` to change plan
  - `{ cancel_at_period_end: true|false, customer_cancellation_reason?, customer_cancellation_comment? }` to cancel or uncancel
  - `{ revoke: true }` to end immediately
  - `{ current_billing_period_end }`
  - seats or units, pause or resume, or clear a pending update
- `subscriptions.revoke(id)` ends a subscription immediately.
- One subscription per customer is the default; set `allow_multiple_subscriptions` to change that.
- Proration only matters when plans change. The repo has a single plan with `prorationBehavior: 'none'`, so it's moot.

### 2.7 Orders, payments, refunds and disputes (VERIFIED types)

- `Order` (one per paid transaction, including each renewal):
  - status `draft|pending|paid|refunded|partially_refunded|void`, `paid`
  - amounts: `subtotal_amount`, `discount_amount`, **`net_amount`** (after discounts, before tax), `tax_amount`, `total_amount`, `applied_balance_amount`, `due_amount`, `refunded_amount`, `refunded_tax_amount`, `refundable_amount`, `refundable_tax_amount`
  - **`platform_fee_amount` and `platform_fee_currency`**, plus `currency`
  - **`billing_reason`**: `purchase | subscription_create | subscription_cycle | subscription_update | subscription_meter_cycle`
  - `customer` (with `external_id`), `product`, `subscription_id`, `checkout_id`, `metadata`, `items[]`, `invoice_number`, `receipt_number`
- The fee to deduct from a credit purchase can come from `order.platform_fee_amount`, replacing the Stripe balance-transaction lookup. **UNVERIFIED:** whether it is final and includes the international-card surcharge by the time `order.paid` fires. The system event `balance.order` (Events API, `source: 'system'`) carries `fee`, `net_amount`, `tax_amount` and `exchange_rate`, and can be used to cross-check.
- `payments.list/get`: `Payment` has `status`, `amount`, `method`, `decline_reason`, `order_id`, `checkout_id` and `processor_metadata`.
- **Refunds API exists:** `refunds.create({ order_id, reason, amount, comment?, revoke_benefits?, metadata? })`.
  - `reason` is one of `duplicate|fraudulent|customer_request|service_disruption|satisfaction_guarantee|dispute_prevention|other`.
  - `Refund` has `status: pending|succeeded|failed|canceled`, `amount`, `tax_amount`, `order_id`, `subscription_id`, `customer_id` and `dispute`.
  - The docs page describes only the dashboard flow, but the API is in the SDK.
  - Partial refunds are supported, with tax prorated automatically. **Fees are not returned on refunds.**
  - **Polar may refund on its own within 60 days to prevent chargebacks.** Our code must handle refunds we didn't start; refund webhooks cover this.
  - Source: https://polar.sh/docs/features/refunds.md
- **Disputes:** `disputes.list({ order_id, status })`, `get`, `accept`.
  - `DisputeStatus`: `prevented | early_warning | needs_response | under_review | lost | won`.
  - Disputes cost **$15 each regardless of outcome**, taken from the balance.
  - **There are no dispute webhook events in any API version (2026-04, 2026-10, 2027-01; VERIFIED).** The disputes dashboard is itself an org flag (`disputes_enabled`).
  - To react to disputes we would have to **poll** `disputes.list`, or poll the Events API for system events `balance.dispute` / `balance.dispute_reversal` (VERIFIED names).
- **Off-session charges** (`orders.create` draft, then `orders.finalize`) charge a saved payment method for one-time products (fixed, free or unit-based, or a custom `amount`). They are **gated by `off_session_charges_enabled`**; otherwise the call returns 403 `OffSessionChargesNotEnabled`. Source: https://polar.sh/docs/features/orders.md

### 2.8 Benefits

Types: `custom`, `discord`, `github_repository`, `downloadables`, `license_keys`, **`meter_credit`** (`{ meter_id, units, rollover }`), `feature_flag`, `slack_shared_channel`.

Products carry benefits, which are granted and revoked with the purchase or subscription lifecycle. The webhooks are `benefit_grant.created|updated|cycled|revoked`.

The SDK's guidance is to use a `feature_flag` benefit for entitlements. For us, a feature-flag benefit "membership" on the yearly product would be the cleanest membership signal.

### 2.9 Discounts

`discounts.*` supports fixed or percentage discounts with durations `once | forever | repeating`, codes, redemption limits and product restrictions. Not used today.

---

## 3. Usage-based billing (events, meters, credits)

- **Ingest:** `polar.events.ingest({ events: [{ name, external_customer_id | customer_id, external_id?, timestamp?, parent_id?, metadata }] })` returns `{ inserted, duplicates }` (VERIFIED types). Metadata may include reserved `_cost: { amount, currency }` and `_llm: { vendor, model, input_tokens, output_tokens, total_tokens, … }` (`CostMetadataInput`, `LLMMetadata`).
- `external_id` deduplicates events, per the SDK's bundled guidance. **Events are immutable and cannot be deleted** (https://polar.sh/docs/features/usage-based-billing/event-ingestion.md).
- Events are attributed to the billing period in which **Polar receives them**, not their `timestamp`.
- **UNVERIFIED:** batch size limits.
- **Meters:** `meters.create({ name, filter, aggregation: count | property sum/max/min/avg | unique, unit, custom_multiplier })`. `meters.quantities(id, {start, end, interval})`.
- **Customer meters** (`customerMeters.list/get`, plus `active_meters` in customer state) report `consumed_units`, `credited_units` and `balance`.
- **Credits:** a `meter_credit` benefit grants `units` on every cycle (subscription) or once (one-time product), with optional `rollover`. Usage draws credits down first; past zero, metered prices bill overage (https://polar.sh/docs/features/usage-based-billing/credits.md).
- **Polar never blocks usage.** Ingestion succeeds whatever the balance, so the app must enforce limits.
- **Fit for this repo: poor. Keep the internal ledger.**
  - Our credits are **dollar-denominated, variable-amount prepaid top-ups**. A meter-credit benefit grants a fixed number of units per product, not "units = amount paid".
  - Our metering is micro-USD with hold/settle/reconcile semantics, plus the PoolBank Durable Object.
  - Polar meters are eventually consistent, immutable, and bill only through recurring products.
  - Mirroring usage into Polar events for analytics is optional and non-authoritative.

---

## 4. Webhooks

- **Configure** in Settings → Webhooks, or through the API (`webhooks.createWebhookEndpoint`). Formats are `raw`, `discord` and `slack`; use `raw`. Pick event types per endpoint.
- **Envelope** (VERIFIED types): `{ type, timestamp, api_version, data }`. `data` is the full resource (`Order`, `Subscription`, `Refund`, `CustomerState`, …), in snake_case, for the endpoint's API version.
- **Events** (2026-10, VERIFIED):
  - `checkout.created/updated/expired`
  - `customer.created/updated/deleted/state_changed`
  - `customer_seat.assigned/claimed/revoked`, `member.created/updated/deleted`
  - `order.created/updated/paid/refunded`
  - `subscription.created/updated/active/canceled/uncanceled/cycled/revoked/past_due/paused/resumed/migrated`
  - `refund.created/updated`
  - `product.created/updated`, `discount.created/updated/deleted`
  - `benefit.created/updated`, `benefit_grant.created/cycled/updated/revoked`
  - `organization.updated`
  - **No dispute events. No payment-failed event** beyond `subscription.past_due`.
- **Sequences** (https://polar.sh/docs/integrate/webhooks/events.md):
  - Renewal: `subscription.cycled → subscription.updated → order.created`, then `order.updated → order.paid` once payment settles.
  - `order.created` arrives with status `pending`; **credit on `order.paid`**.
  - Cancel at period end: `subscription.updated → subscription.canceled` now, then `subscription.updated → subscription.revoked` at period end.
  - Migration: `subscription.updated → subscription.migrated`, with no `created`/`active`.
- **Signature:** Standard Webhooks headers `webhook-id`, `webhook-timestamp` and `webhook-signature` (`v1,<base64>`). The signed content is `${id}.${ts}.${body}`, HMAC-SHA256.
  - Secrets created before 2026-09-08 use the "Polar HMAC" key (the UTF-8 bytes of the full `whsec_…`). Newer secrets use the Standard Webhooks key (base64-decode of the part after `whsec_`).
  - **`validateEvent` tries both** (VERIFIED in source).
  - Timestamp tolerance is **±300 s**.
  - It needs the **raw body** (string or `Uint8Array`) and throws `PolarWebhookVerificationError`, `PolarWebhookUnknownTypeError` (with `.eventType`) or `PolarWebhookError`.
- **Delivery** (https://polar.sh/docs/integrate/webhooks/delivery.md): responses time out after 10 s, and replying within 2 s is recommended. **Up to 10 retries** with exponential backoff. **The endpoint is auto-disabled after 10 consecutive failures**, and the members are emailed. Manual redelivery is available in the dashboard or with `webhooks.redeliverWebhookEvent`.
  - No ordering guarantee is documented, so treat events as unordered.
  - Production source IPs: `3.134.238.10, 3.129.111.220, 52.15.118.168, 3.134.178.243, 74.220.50.0/24, 74.220.58.0/24`.
- **Idempotency:** dedupe on `webhook-id` or, as today, on the resource id: `order.id` for credits, `refund.id` for refunds. The repo's "idempotent on the object, not the event" design carries over directly.
- **Auto-disable risk:** today the handler throws so the provider retries, for example when the fee is unknown. Repeated throws can now disable the endpoint after 10 consecutive failures. Keep throwing rare, and alert on it.

Workers handler sketch (VERIFIED APIs):

```ts
import { webhooks } from '@polar-sh/sdk/2026-10';
app.post('/api/billing/polar/webhook', async (c) => {
  const body = await c.req.text();
  let event: webhooks.WebhookPayload;
  try {
    event = await webhooks.validateEvent(body, {
      'webhook-id': c.req.header('webhook-id') ?? '',
      'webhook-timestamp': c.req.header('webhook-timestamp') ?? '',
      'webhook-signature': c.req.header('webhook-signature') ?? '',
    }, c.env.POLAR_WEBHOOK_SECRET);
  } catch (e) {
    if (e instanceof webhooks.PolarWebhookUnknownTypeError) return c.json({ received: true }, 202);
    if (e instanceof webhooks.PolarWebhookVerificationError) return c.text('bad signature', 403);
    return c.text('bad payload', 400);
  }
  switch (event.type) {
    case 'order.paid':      /* event.data: Order — billing_reason, metadata, net_amount, tax_amount, platform_fee_amount */ break;
    case 'order.refunded':  /* Order with refunded_amount / refunded_tax_amount */ break;
    case 'refund.created': case 'refund.updated': /* Refund: amount, tax_amount, order_id, status */ break;
    case 'subscription.active': case 'subscription.canceled': case 'subscription.revoked': case 'subscription.updated': break;
  }
  return c.json({ received: true });
});
```

(`webhooks.WebhookPayload` is exported as a type from the `webhooks` namespace; VERIFIED in the export list.)

---

## 5. Merchant of Record implications and gaps vs. Stripe

**What Polar does as MoR** (https://polar.sh/docs/merchant-of-record/introduction.md): it is the seller of record and calculates (via Stripe Tax), collects, files and remits sales tax, VAT and GST worldwide. It handles EU B2B VAT, invoices and receipts, fraud screening, and dispute handling. We keep income tax only.

Consequences:
- Stripe Tax config, `automatic_tax`, `tax_id_collection` and our "tax never enters the ledger" logic simplify. We still exclude tax: use `order.net_amount`, or `subtotal - discount`, and never `total_amount`.
- Our Terms and legal docs (`docs/LEGAL.md`) must name Polar as reseller and MoR.
- The customer sees Polar on statements, receipts and the checkout.

**Payouts** (https://polar.sh/docs/features/finance/payouts.md):
- Payouts are manual withdrawals to **our own Stripe Connect payout account**: $2 per month while active, 0.25% + $0.25 per payout, and 0.25–1% FX.
- New orgs (created after 2026-05-12) have a **7-day settlement delay**. Batches run 24 h after the request, then take 4–7 business days. The USD minimum is $10.

**Fees** (https://polar.sh/docs/merchant-of-record/fees.md):

| Plan | Monthly | Per transaction |
|---|---|---|
| Starter | free | 5% + 50¢ |
| Pro | $20 | 3.8% + 40¢ |
| Growth | $100 | 3.6% + 35¢ |
| Scale | $400 | 3.4% + 30¢ |

- International (non-US) cards add **1.5%**.
- Disputes cost **$15** each, whatever the outcome.
- Fees are not returned on refunds.
- Orgs created before 2026-05-27 ("Early Member") pay 4% + 40¢, plus 0.5% on subscriptions.
- That is much higher than Stripe's 2.9% + 30¢ plus Stripe Tax. For small top-ups ($5) the fixed part dominates: on Starter a $5 top-up costs 75¢, or 15%. **Raise `MIN_TOP_UP_CENTS`** or pass fees through.

**Acceptable Use** (https://polar.sh/legal/acceptable-use-policy):
- **Prohibited:** "Donations, crowdfunding, community access, advertising, and sponsorship". **The community pool (`target: 'pool'` purchases, which fund other users' usage) could be read as donations or crowdfunding. This is a blocking question to put to Polar support before migrating the pool.**
- **Prohibited:** "Marketplaces. Selling others' products or services … with an agreed upon revenue share".
- **Restricted** (closer review): "AI Content Generation tools (text, image…)". An AI chat tutor will likely get an account review (https://polar.sh/docs/merchant-of-record/account-reviews.md).
- Prepaid credits are not explicitly prohibited.

**Gaps vs. the Stripe features this repo uses:**

| Stripe (used here) | Polar | Status |
|---|---|---|
| Checkout `mode: payment` with ad-hoc `price_data` | `checkouts.create({ prices: { [productId]: [{amount_type:'fixed', price_amount}] } })`, or a custom price with `amount` | ✅ Equivalent |
| `metadata` on session and PaymentIntent | Checkout metadata is copied to order and subscription | ✅ |
| `client_reference_id` | Metadata, plus `external_customer_id` | ✅ (workaround) |
| `automatic_tax`, `tax_behavior: exclusive`, tax-ID collection | MoR handles tax; `tax_behavior` per price; business customer, tax ID | ✅ Simpler |
| `invoice_creation` | Invoices and receipts are automatic | ✅ |
| Idempotency keys on `customers.create` | **None.** Use `external_id` uniqueness and conflict handling | ⚠️ Rework |
| Balance-transaction `fee` per charge | `order.platform_fee_amount`; system event `balance.order.fee` | ⚠️ UNVERIFIED that it's final at `order.paid` |
| `invoice.paid` for membership (first and renewals) | `order.paid` with `billing_reason` `subscription_create` / `subscription_cycle` | ✅ |
| `charge.refunded` (refund list per charge) | `refund.created/updated` (with `order_id`), `order.refunded` | ✅ |
| `charge.dispute.funds_withdrawn` / `funds_reinstated` / `closed (lost)` | **No webhooks.** Poll `disputes.list` or system events `balance.dispute` / `balance.dispute_reversal`. Polar may auto-refund to prevent disputes. | ❌ Gap: needs polling (cron) or acceptance |
| Better Auth Stripe plugin (`auth_subscriptions`, `subscription.upgrade`, `billingPortal`, `list`) | `@polar-sh/better-auth` (checkout, portal, state); **no local subscription table** | ⚠️ Rework client and membership query |
| Billing portal | `customerSessions.create(...).customer_portal_url` | ✅ |
| `customers.del` | `customers.deleteExternal(id, { anonymize })` | ✅ |
| Off-session charge / saved card | `orders.create` + `finalize`, **only if `off_session_charges_enabled`** | ⚠️ Not used today |
| Connect / payouts to third parties | **Not supported** (marketplaces prohibited) | n/a today |
| Customer balance top-ups | Polar "wallets" exist behind a flag (`wallets_enabled`). The customer portal can only list and get them; **there is no top-up or debit API** in 2026-10 | ❌ Keep own ledger |
| Arbitrary PaymentIntents | Not available; everything is checkout or order | n/a |
| Currencies | About 130 presentment currencies; payouts via Stripe | ✅ |

---

## 6. Sandbox, tokens, rate limits

- Sandbox dashboard is https://sandbox.polar.sh/start; the API is `https://sandbox-api.polar.sh` (SDK `environment: 'sandbox'`). It needs its own org, OAT, products and webhook secret.
- Test card: `4242 4242 4242 4242`, any future date and CVC. Sandbox emails go only to org members.
- Migrations can't copy real cards in sandbox.
- Source: https://polar.sh/docs/integrate/sandbox.md
- **Rate limits:** **500 req/min in production** and **100 req/min in sandbox**, per organization, customer or OAuth client. License-key endpoints allow 3 req/s.
  - A 429 comes with `Retry-After`, which the SDK surfaces as `PolarRateLimitError.retryAfter`.
  - The SDK does not retry.
  - Source: https://polar.sh/docs/api-reference/2027-01/introduction.md
- Secrets for `wrangler.jsonc` and `.dev.vars`: `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_SERVER` (`sandbox|production`), `POLAR_CREDITS_PRODUCT_ID`, `POLAR_MEMBERSHIP_PRODUCT_ID`.

---

## 7. Migrating existing data

Polar has a built-in **Stripe migration** at Settings → Migrations. It's an org feature flag (`merchant_migration_enabled`); if it's missing, contact support. Source: https://polar.sh/docs/migrate.md

- Phases:
  1. Route new sales to Polar.
  2. Connect Stripe.
  3. Assess and import the catalog and customers.
  4. **Transfer cards account-to-account.** Stripe copies payment methods to Polar.
  5. Switch selected subscriptions. They stop renewing on Stripe and continue on Polar, and `subscription.migrated` fires with `provider_subscription_id`.
  6. Reconcile.
- Limits:
  - Stripe Connect platform accounts and Indian accounts are not supported.
  - Multi-item subscriptions, quantity > 1, past-due or paused subscriptions, and any renewing within about 24 h stay on Stripe.
  - **Switching cannot be undone.**
  - Stripe metadata is not carried over.
  - **Historical Stripe payments do not become Polar orders.**
- Matching: set Polar `external_id` = our user id. Match imported customers by email first, then set `external_id`.
- Implications for this repo:
  - The yearly membership subscriptions are single-item, quantity 1, so they are eligible.
  - Run Stripe and Polar side by side: keep the Stripe webhook handler alive for refunds and disputes on **historical Stripe charges** (top-ups and membership invoices) until the refund and dispute windows close, about 120+ days.
  - Keep `stripe_customer_id`.
  - The ledger's `stripe_ref` idempotency column needs a provider-neutral ref, e.g. a `polar:` prefix or a `provider` column.
- There is also a "Migrate away from Polar" guide (https://polar.sh/docs/migrate-away.md) for card portability out.

---

## 8. Open questions and UNVERIFIED items to resolve in later stages

1. **Pool purchases vs. the AUP ban on "donations, crowdfunding, community access … sponsorship"**: ask Polar support in writing before migrating `target: 'pool'`.
2. Is `order.platform_fee_amount` final at `order.paid`, and does it include the 1.5% international surcharge? Compare it with the `balance.order` system event's `fee` in sandbox.
3. Disputes: poll `disputes.list` (needs `disputes_enabled`?) or system events from the existing cron, or drop dispute-driven debits and pool suspension in favour of Polar's MoR handling.
4. Does `@polar-sh/better-auth@2.0.1` bundle and run under workerd? Only the SDK was verified. Decide between the plugin and own routes.
5. The default checkout expiry, the event-ingest batch limits, and the OAT scope list and expiry options.
6. Whether customer email uniqueness collides with Better Auth email changes or deletions (`deleteExternal` with `anonymize`).
7. Fee impact: minimum top-up and pricing pass-through (section 5).

---

## Sources

- npm: https://www.npmjs.com/package/@polar-sh/sdk (1.0.2), https://www.npmjs.com/package/@polar-sh/better-auth (2.0.1), `@polar-sh/hono` 0.5.6, `@polar-sh/nextjs` 1.0.1, `@polar-sh/checkout` 0.4.2, `@polar-sh/ingestion` 0.4.2
- SDK bundled docs: `node_modules/@polar-sh/sdk/.agents/skills/polar-typescript-sdk/{SKILL.md,references/*.md}`
- Docs index: https://polar.sh/docs/llms.txt
- API intro and rate limits: https://polar.sh/docs/api-reference/2027-01/introduction.md
- Versioning: https://polar.sh/docs/api-reference/2027-01/versioning.md
- Webhooks: https://polar.sh/docs/integrate/webhooks/endpoints.md, https://polar.sh/docs/integrate/webhooks/delivery.md, https://polar.sh/docs/integrate/webhooks/events.md
- Customer state: https://polar.sh/docs/integrate/customer-state.md
- Customer portal: https://polar.sh/docs/features/customer-portal/introduction.md
- Checkout: https://polar.sh/docs/features/checkout/session.md
- Orders: https://polar.sh/docs/features/orders.md
- Refunds: https://polar.sh/docs/features/refunds.md
- Usage billing: https://polar.sh/docs/features/usage-based-billing/introduction.md, …/event-ingestion.md, …/meters.md, …/credits.md
- MoR: https://polar.sh/docs/merchant-of-record/introduction.md
- Fees: https://polar.sh/docs/merchant-of-record/fees.md
- AUP: https://polar.sh/legal/acceptable-use-policy
- Account reviews: https://polar.sh/docs/merchant-of-record/account-reviews.md
- Payouts: https://polar.sh/docs/features/finance/payouts.md
- Sandbox: https://polar.sh/docs/integrate/sandbox.md
- Auth: https://polar.sh/docs/integrate/authentication.md
- Migration: https://polar.sh/docs/migrate.md
