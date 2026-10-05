# Stripe → Polar mapping (stage 2)

Date: 2026-10-05. Input: [01-polar-research.md](01-polar-research.md) (SDK `@polar-sh/sdk@1.0.2`, imports from `@polar-sh/sdk/2026-10`). Every Stripe touchpoint below came from `git ls-files | xargs grep -il stripe`: 102 tracked files, of which 11 are drizzle snapshots and one is `pnpm-lock.yaml`. No code was changed.

How to read this document:

- §1 is the launch-status finding. It drives the whole cutover plan.
- §2 maps each concern, from checkout to cron.
- §3 is the file-by-file table: every file that mentions Stripe and what happens to it.
- §4 lists DB, env and dependency changes.
- §5 lists the open decisions, each with a recommended answer.
- §6 is the cutover plan.

`PLAUSIBLE` marks a Polar behaviour stage 1 could not verify. Each one needs a sandbox check in stage 3 or 4.

---

## 1. Is the app launched? No. It is pre-launch, so do a hard cutover with no Stripe legacy path

Evidence:

| Signal | What it says |
|---|---|
| `git log` | The first commit, "Scaffold monorepo…", is dated **2026-09-29**, six days ago. There are 108 commits, all feature work, and no release or tag. |
| `docs/pool/SPEC.md:5` | "Billing is planned with Stripe, but **the Stripe account is not live yet**." Spec §6 is titled "Purchases (Stripe, built ahead of go-live)". |
| `docs/PLAN.md:609` | "**Not verified against live accounts:** Stripe and OpenRouter are exercised against mocks". |
| `apps/worker/wrangler.jsonc` (committed deploy config) | `STRIPE_CREDITS_PRODUCT_ID: ""` means `topUpsEnabled` is false, so no top-up or pool purchase can be sold. `STRIPE_MEMBERSHIP_PRICE_ID: ""` means `membershipPlans()` returns `[]`, so the plugin can't sell a membership. `ANNUAL_FEE_ENABLED: "false"`, `POOL_ENABLED: "false"`. With this config **no Stripe charge can be created, even if the secrets are set.** |
| README "Not included yet" | Still lists launch blockers. |
| `docs/DEFERRED.md` | Mentions "monthly-plan subscriptions from before the membership". This is hypothetical code-path wording, not evidence of real subscribers. |

**Conclusion:** there are no live Stripe customers, subscriptions or charges. **Recommendation:**

- Skip Polar's Stripe merchant migration (`merchant_migration_enabled`).
- Don't keep the Stripe webhook alive for 120 days.
- Delete the Stripe code, dependencies and secrets in one change.
- Rename the Stripe-named columns now, while doing so costs nothing.

Guard step before cutover: the operator runs the read-only checks in §6 step 0. If any of them finds a live Stripe object, switch to the fallback in §6.

---

## 2. Concern-by-concern mapping

### 2.1 Checkout: credit top-ups and pool purchases (`target: personal | pool`)

| Stripe today (`billing/service.ts` `createCreditCheckout`) | Polar equivalent | Behavioural difference / action |
|---|---|---|
| `stripe.checkout.sessions.create({ mode: 'payment', … })` | `polar.checkouts.create({...})` (2026-10) | Returns `{ url }`. Keep the `CheckoutResponse` shape. |
| `line_items[0].price_data { currency:'usd', product: STRIPE_CREDITS_PRODUCT_ID, unit_amount: amountCents, tax_behavior:'exclusive' }` | `products: [POLAR_CREDITS_PRODUCT_ID]`, `prices: { [id]: [{ amount_type:'fixed', price_amount: amountCents, price_currency:'usd', tax_behavior:'exclusive' }] }` | The credits product must be a **one-time** Polar product with a USD price. The ad-hoc price is marked `source:"ad_hoc"`. Server-side bounds validation stays. |
| `customer: ensureStripeCustomer(...)` | `external_customer_id: user.id`, `customer_email`, `customer_name` | Polar creates or links the customer itself. There is no lazy-create call and no idempotency key (§2.2). |
| `client_reference_id: accountId` | none; carried in `metadata.accountId` | |
| `metadata` + `payment_intent_data.metadata` `{kind:'credits', target, accountId, userId, amountCents}` | `metadata` with the same keys | Checkout metadata is **copied to the order**, so `order.metadata` replaces both Stripe copies. Values must be strings, ints or bools. Add `v: 1` for future-proofing (optional). |
| `automatic_tax`, `customer_update`, `billing_address_collection:'required'`, `invoice_creation` | Drop all of them | Polar is the MoR: tax, invoices and receipts are automatic. Don't pass `require_billing_address` (decision D9). |
| `success_url: …?checkout=success[&target=pool]` | `success_url: …?checkout=success[&target=pool]&checkout_id={CHECKOUT_ID}` | The frontend keeps polling the summary as today. `checkout_id` is informational. |
| `cancel_url: …?checkout=cancel` | `return_url: …?checkout=cancel` | Polar has no cancel URL, only a "back" link (`return_url`). An abandoned checkout simply expires (`checkout.expired`, which we ignore). |
| Currency: always USD | Set `currency: 'usd'` in the body, and keep the product's only price in USD | Polar supports about 130 presentment currencies. Reject or log non-USD orders in fulfilment, as today. |
| Pool target (`purchases.ts` `assertPurchasable`, pool min $10) | Same code, `polarPurchases(env)` | **Blocked by the AUP** (decision D1) and by **fee math** (D4): an 8 % margin at $10 does not cover Polar's 5 % + 50¢ (+1.5 % on international cards). |
| `checkout.session.async_payment_succeeded` | n/a | Polar fulfils on `order.paid` for every payment method. |

### 2.2 Customers

| Stripe | Polar | Action |
|---|---|---|
| `stripe.customers.create(..., { idempotencyKey: 'customer-<userId>' })` and `auth_users.stripe_customer_id` (`billing/stripe.ts` `ensureStripeCustomer`) | Implicit through `checkouts.create({ external_customer_id: user.id })`. `external_id` is unique per org and immutable. | Delete `ensureStripeCustomer`. There is nothing to race: `external_id` uniqueness is the idempotency. |
| `userIdForCustomer(db, customerId)`: `SELECT … WHERE stripe_customer_id = ?` | `order.customer.external_id` / `subscription.customer.external_id` in the webhook payload | No DB lookup is needed. Fall back to `metadata.userId`. Log and skip when both are missing, e.g. a dashboard-created customer. |
| `metadata.customerType:'user'` (plugin key) | `customer_metadata` on the checkout (optional) | Not needed. |
| Email unique per org (Polar only) | `customers.updateExternal(userId, { email })` | The app has no email-change flow today, so nothing to do. Revisit this if one is added (DEFERRED). |
| Store the provider customer id? | Optional | Store Polar's `customer.id` in `auth_users.billing_customer_id`, set from the first `order.paid` or `subscription.*` webhook. It is used only to know whether account deletion must call Polar, and for admin lookups (decision D6). |

### 2.3 Membership (yearly subscription)

| Stripe today | Polar | Action |
|---|---|---|
| Better Auth Stripe plugin `subscription.upgrade({ plan:'membership' })`: Stripe Checkout `mode:'subscription'` on `STRIPE_MEMBERSHIP_PRICE_ID`, with automatic tax and tax-ID collection | Our route `POST /api/billing/membership/checkout` → `polar.checkouts.create({ products:[POLAR_MEMBERSHIP_PRODUCT_ID], external_customer_id, customer_email, metadata:{ kind:'membership', userId }, success_url, return_url })` | The product is **recurring yearly** at $10, `tax_behavior:'exclusive'`. If the user already has a paying row in `billing_subscriptions`, return the portal URL instead; this mirrors the plugin's `returnUrl` behaviour. Polar's default of one subscription per customer is a second guard. |
| `auth_subscriptions` table, synced by the plugin from `customer.subscription.*` | **No plugin table** (stage 1 §1.3). Add our own `billing_subscriptions` table, upserted from the `subscription.created/updated/active/canceled/uncanceled/revoked/past_due` webhooks. `event.data` is the full `Subscription`. | Upsert keyed on the Polar subscription id. Guard against out-of-order delivery with `WHERE excluded.modified_at >= billing_subscriptions.modified_at` (PLAUSIBLE: `Subscription.modified_at` exists). Membership is recognised by `product.id === POLAR_MEMBERSHIP_PRODUCT_ID` **or** `metadata.kind === 'membership'`. The second test survives a product change, like today's `isMembershipInvoice` fallback. |
| `membership.ts` `ACTIVE_STATUSES = active, trialing, past_due` | Polar `SubscriptionStatus` has the same names: `active`, `trialing`, `past_due`, `canceled`, `unpaid`, `incomplete*`, `paused` | Same rule. Cancel-at-period-end stays `active` with `cancel_at_period_end=true` until `subscription.revoked` sets `canceled`. That matches today's display. |
| `membershipFor()` joins `auth_subscriptions` on `reference_id`, `plan` | Join `billing_subscriptions` on `user_id` (and `kind='membership'`) | Same single D1 query on the hot path (`assertMember` runs on every generate). **Do not** call `customers.getStateExternal` per request, because of the 500 req/min limit and latency. |
| `period_end` (ms), `cancel_at_period_end` | `current_period_end` (ISO), `cancel_at_period_end`, `ends_at` | Store ISO text. `MembershipInfo.periodEnd` is ISO already. |
| `MembershipInfo.stripeStatus` | Rename it to `providerStatus` (`packages/shared/src/billing.ts`) | Touches 6 non-test consumers plus about 15 spec fixtures (§3). |
| `invoice.paid` (first year and renewals) → +`MEMBERSHIP_CREDIT_CENTS`, ref = invoice id | `order.paid` with `billing_reason ∈ {subscription_create, subscription_cycle}`, `subscription_id` set, a membership product, and `total_amount > 0` → same grant, ref `polar:order:<order.id>` | Renewal order: `subscription.cycled → order.created (pending) → order.paid`. Credit on `order.paid` only. Ignore `subscription_update` and `subscription_meter_cycle`. |
| Customer Portal (`subscription.billingPortal`) | Our route `POST /api/billing/portal` → `polar.customerSessions.create({ external_customer_id: userId, return_url })` → `{ url: customer_portal_url }` | If Polar returns 404 (no customer yet), answer 404 `no_customer`. The UI maps it to today's "nothing to manage yet" text. In Polar settings, enable invoices and cancellation and disable plan switching. |
| `subscription.list` (client) | Delete it: nothing calls `BillingClient.list()` | |
| `requireEmailVerification` | n/a | Users are always verified (`auth.ts` hook). |
| Waiver (`membership_waived`) | Unchanged | It is provider-independent. |

### 2.4 Webhooks and idempotency

| Stripe today | Polar | Action |
|---|---|---|
| One endpoint `/api/auth/stripe/webhook` inside the Better Auth plugin; `onEvent` → `handleStripeEvent`; a throw gives 400 and a retry | Our Hono route **`POST /api/webhooks/polar`**, registered in `app.ts` **before** `sessionMiddleware` (next to `/api/pool/status`). It calls `webhooks.validateEvent(rawBody, {webhook-id, webhook-timestamp, webhook-signature}, POLAR_WEBHOOK_SECRET)`. | A bad signature answers 403. An unknown type (`PolarWebhookUnknownTypeError`) answers 202. A handler throw answers **500**, and Polar retries up to 10 times. **The endpoint is auto-disabled after 10 consecutive failures**, so log `polar_webhook_failed` and add an alert. |
| Signature: Stripe `whsec_` HMAC | Standard Webhooks, ±300 s tolerance; `validateEvent` handles both key formats | The raw body must be read with `c.req.text()` before any JSON parsing. |
| Events subscribed (README): `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created/updated/deleted`, `invoice.paid`, `charge.refunded`, `charge.dispute.funds_withdrawn/funds_reinstated/closed` | Subscribe to: `order.paid`, `refund.created`, `refund.updated`, `subscription.created`, `subscription.updated`, `subscription.active`, `subscription.canceled`, `subscription.uncanceled`, `subscription.revoked`, `subscription.past_due` | Not needed: `order.created`/`order.updated` (pending), `order.refunded` (covered by `refund.*`), `checkout.*`, `customer.*`, `benefit_grant.*`. There are **no dispute events** (§2.6). |
| Idempotency on the Stripe **object** id, through the unique `credit_grants.stripe_ref` | Same principle on Polar object ids, column renamed `provider_ref` | Ref scheme: `polar:order:<id>` (purchase or membership credit), `polar:refund:<id>`, `polar:membership-refund:<order_id>`, `polar:dispute:<id>`, `polar:dispute:<id>:reinstated`. `admin:` and `dev:` are unchanged. Polar ids are UUIDs; the prefix keeps them readable and unambiguous. |
| `hasGrant(session.id)` before the fee lookup | `hasGrant('polar:order:'+id)` before any API call | |
| Event ordering | Not guaranteed by Polar | Order-level grants are independent. Subscription rows use the `modified_at` guard. A refund that arrives before its `order.paid` throws, so it is retried (see §2.5). |

### 2.5 Fulfilment into the ledger, fees, refunds

| Stripe today (`billing/webhook.ts`, `billing/purchases.ts`) | Polar | Action |
|---|---|---|
| `creditCheckout`: needs `kind==='credits'` and `payment_status==='paid'`; gross = `session.amount_subtotal` | `order.paid` with `billing_reason==='purchase'` and `metadata.kind==='credits'`; **gross = `order.net_amount`** (after discount, before tax; **never** `total_amount`) | `fulfilPurchase` (the only place credit is computed) is unchanged. `PaidPurchase.ref` = `polar:order:<id>`. |
| Fee = the charge's balance-transaction `fee` (`paymentIntents.retrieve` expand) with FX handling; throws to retry when not settled | `order.platform_fee_amount` (and `platform_fee_currency`, which must be `usd`) | No extra API call. PLAUSIBLE: the fee is final at `order.paid` and includes the +1.5 % international surcharge. Verify it in sandbox against the `balance.order` system event's `fee` (decision D3). A null fee throws, so the event is retried. |
| Personal top-up: credit = subtotal − fee (`netOfFee`) | Same, with Polar's fee | Polar's fee is much larger: on Starter, $5 gives 75¢ (15 %) and $10 gives $1.00 (10 %). See D4 on minimums. |
| Pool purchase: credit = gross / (1 + `POOL_MARGIN_BPS`); fee recorded only | Same formula | The margin no longer covers the fee at $10 (D4). |
| `charge.refunded` → `refunds.list(charge)`, `checkout.sessions.list({payment_intent})` to find the session, `invoicePayments.list` for membership invoices; pre-tax ratio = subtotal/total | `refund.created` / `refund.updated` (`data: Refund {id, order_id, amount, tax_amount, status}`). Look up the original grant **locally** by `provider_ref = 'polar:order:'+order_id`, which gives `account_id`, `kind`, `user_id`, gross and amount. | No API calls and no ratio: PLAUSIBLE that `Refund.amount` is pre-tax (tax is in `tax_amount`). Verify in sandbox. Debit **only when `status==='succeeded'`**, keyed on the refund id. Today pending refunds are debited too, but a failed refund was never reversed; under Polar, pending refunds are not debited. If no local grant exists for the order, call `orders.get(order_id)`. If it is a credits order not yet credited, throw (retry). If it is a membership order that granted nothing, do nothing. |
| Personal refund: −pre-tax share in full (the fee is kept by the processor) | Same: `grantCredit({ kind:'refund', amountMicros: −amount, grossMicros: −amount, ref:'polar:refund:'+id })` | Polar also keeps its fee on refunds. |
| Pool refund: `debitPoolPurchase` (credit-equivalent, clamped by `PoolBank.debit`) | Same function, fed by the local grant | `PoolDebitRequest.refId` gets the new refs. |
| Membership refund: take back the included credit once, keyed on the first refund id | Same, keyed on **`polar:membership-refund:<order_id>`** | Simpler and stable, with no "first refund" sort. `order.billing_reason` comes from the local grant (`kind='subscription'`). If the refund was issued with `revoke_benefits`, the subscription is ended by `subscription.revoked`. |
| **Polar may refund on its own** within 60 days to prevent chargebacks | The same refund webhook | Handled automatically. Document it. |
| `tax never enters the ledger` | Same (`net_amount`) | Polar is MoR, so the operator never holds tax. |

### 2.6 Disputes (no Polar webhooks)

| Stripe today | Polar | Action |
|---|---|---|
| `charge.dispute.funds_withdrawn` → debit the disputed top-up or pool purchase (ref dispute id) | **Poll** `polar.disputes.list({ status: [...] })` from the cron (§2.9). For each dispute in `needs_response`, `under_review` or `lost` whose order has a credits grant: debit like a refund, ref `polar:dispute:<id>` | `prevented` and `early_warning` disputes end in a Polar refund, which arrives as `refund.*`, so they get no action (otherwise we would debit twice). The pre-tax amount comes from the dispute `amount` minus `tax_amount` (PLAUSIBLE field names), or a ratio from the order. |
| `charge.dispute.funds_reinstated` → credit back what was debited | Poll: status `won` and `polar:dispute:<id>` exists → credit `polar:dispute:<id>:reinstated` | Same `reinstateDispute` logic. No retry is needed: the next poll catches it. |
| `charge.dispute.closed` with `lost` → `pool_suspended=1` and identity suspension | Poll: status `lost` → the same `suspendForLostDispute` | It is idempotent (UPDATE). |
| Membership disputes: left to the operator | Same | |
| Alternative source | Events API system events `balance.dispute` / `balance.dispute_reversal` | Use it only if `disputes.list` needs `disputes_enabled` and support won't turn it on (D5). |

Cost: one `disputes.list` call per cron run is negligible against the 500 req/min limit. Every dispute costs $15 regardless of outcome. That is an operator cost, not a ledger entry.

### 2.7 Account deletion (`auth/delete-account.ts`)

| Stripe | Polar | Action |
|---|---|---|
| `stripe.customers.del(stripe_customer_id)` cancels subscriptions; a `resource_missing` error is ignored; any other failure aborts the deletion | `polar.subscriptions.list({ external_customer_id: userId, active: true })` → `subscriptions.revoke(id)` for each, then `polar.customers.deleteExternal(userId, { anonymize: true })` | It is PLAUSIBLE that deleting a customer revokes subscriptions, so revoke explicitly. Anonymize keeps the MoR's tax records and removes PII, which matches the privacy policy. Treat a 404 as "no customer". Call Polar only when `billing_customer_id` is set or a `billing_subscriptions` row exists (D6); without that, call once and accept the 404. Keep the "abort the deletion on failure" contract. |
| `DELETE FROM auth_subscriptions WHERE reference_id` | `DELETE FROM billing_subscriptions WHERE user_id` | |
| `DeletedUser.stripeCustomerDeleted` | `billingCustomerDeleted` | Update `test/accounts.test.ts` and `multi-user.test.ts`. |
| Copy: "your customer record with Stripe, which cancels your…" (`web-shared/account/delete-account.ts`, `shared/api.ts`, `legal.ts`) | "your customer record with Polar (anonymised), which cancels your membership" | |

### 2.8 Gating and summary flags

| Today | Polar |
|---|---|
| `billingConfigured(env)` = `STRIPE_SECRET_KEY` && `STRIPE_WEBHOOK_SECRET` | `POLAR_ACCESS_TOKEN` && `POLAR_WEBHOOK_SECRET` |
| `topUpsEnabled` = configured && `STRIPE_CREDITS_PRODUCT_ID` | configured && `POLAR_CREDITS_PRODUCT_ID` |
| `membershipRequired` = `ANNUAL_FEE_ENABLED` && configured && `STRIPE_MEMBERSHIP_PRICE_ID` | … && `POLAR_MEMBERSHIP_PRODUCT_ID` |
| `PoolStatusResponse.fundingOpen` = `topUpsEnabled` | `topUpsEnabled && poolPurchasesEnabled` (new flag, D1) |
| `services.ts` `personalCreditReady` = configured \|\| `PERSONAL_CREDIT_ENABLED` | Unchanged (it imports the new `billingConfigured`) |

### 2.9 Cron and reconcile

`src/cron.ts` (`*/10 * * * *`) currently runs OpenRouter usage reconciliation and pool expiry. Neither touches Stripe.

**Add** a `polarDisputes(env, now)` job to `CRON_FREQUENT`. Wrap it in `.catch` and log, so a Polar outage never blocks reconcile. Add `pollDisputes` to the `CronJobs` interface so tests can spy on it.

A membership reconcile against `subscriptions.list` is not needed: webhooks are retried and can be redelivered from the dashboard. A nightly drift check is optional (DEFERRED).

### 2.10 Admin tooling

| Today | Polar |
|---|---|
| `POST /api/admin/credit` (`adjustment` / `simulated_purchase`) "without Stripe" | Unchanged. Reword the comments and copy to "without a payment" (`routes/admin.ts`, `shared/admin.ts`, `apps/admin/src/app/pool-page.ts`, `web-shared/core/api-client.ts`). `simulated_purchase` stays `dev:<key>` with fee 0. |
| Refunds are issued in the Stripe dashboard | Refunds are issued in the Polar dashboard (or with `refunds.create`). No admin UI is needed; the webhook debits automatically. |
| Disputes are handled in the Stripe dashboard | The Polar dashboard (`disputes.accept`) |

### 2.11 Pricing configuration

| Item | Today | Under Polar |
|---|---|---|
| `MIN_TOP_UP_CENTS` (`shared/billing.ts`) | 500 | **1000** recommended (D4) |
| `MAX_TOP_UP_CENTS` | 50 000 | Unchanged (Polar's custom-price bounds are $0.50–$999,999.99) |
| `POOL_MIN_PURCHASE_CENTS` / `POOL_MARGIN_BPS` | 1000 / 800 | Not enough for Polar's fees; see D4 |
| `MEMBERSHIP_PRICE_CENTS` (display) | 1000 | Unchanged; the Polar product price must match |
| `MEMBERSHIP_CREDIT_CENTS` | 200 | Unchanged |
| "plus tax" copy | Stripe Tax on exclusive prices | Keep `tax_behavior:'exclusive'` on both products, so "plus tax" stays true. Polar computes the tax. |
| README worked example (2.9 % + 30¢ + 0.5 % Stripe Tax) | — | Rewrite with Polar's 5 % + 50¢ (+1.5 % international) and a pointer to https://polar.sh/docs/merchant-of-record/fees.md |

---

## 3. File-by-file mapping

Legend: **R** = rewrite, **E** = edit, **D** = delete, **N** = new, **C** = copy/comment-only change, **K** = keep (history).

### 3.1 Worker source (`apps/worker/src`)

| File | Stripe touchpoints | Change |
|---|---|---|
| `billing/stripe.ts` | `getStripe`, `STRIPE_API_VERSION`, `billingConfigured`, `membershipPriceId`, `accountIdForUser`, `userIdForCustomer`, `ensureStripeCustomer` | **D**, replaced by **N** `billing/polar.ts`: `getPolar(env)` (`createPolar({ accessToken, server: POLAR_SERVER, timeout: 15 })`, cached per token), `billingConfigured`, `membershipProductId`, `creditsProductId`. Move `accountIdForUser` to `auth/account.ts` (it has nothing to do with payments). `userIdForCustomer` and `ensureStripeCustomer` are deleted. |
| `billing/service.ts` | `createCreditCheckout` (Checkout Session), `topUpsEnabled`, comments | **E**: `polar.checkouts.create` per §2.1; `topUpsEnabled` reads `POLAR_CREDITS_PRODUCT_ID`; the `checkoutReturnUrl` cancel URL becomes `return_url`. Add `createMembershipCheckout` and `createPortalSession` (or put them in `membership.ts`). |
| `billing/webhook.ts` | The whole file (`handleStripeEvent` and 6 Stripe event types, PaymentIntent/charge/refund/dispute/invoice lookups) | **R** as `billing/polar-webhook.ts`: `handlePolarEvent(env, event)` for `order.paid` (credits and membership), `refund.created/updated`, `subscription.*` (upsert). Keep the provider-independent helpers: `debitPoolPurchase`, the logic in `disputeDebit`/`reinstateDispute`/`suspendForLostDispute` (re-typed), and `MEMBERSHIP_CREDIT_NOTE`. Delete `chargeFeeCents`, `paymentIntentFee`, `purchaseShare`, `invoiceOfCharge`, `disputedPaymentIntent` and `isMembershipInvoice` (replaced by the product/metadata check). |
| **N** `billing/polar-disputes.ts` | — | The cron dispute poller (§2.6) |
| **N** `routes/polar-webhook.ts` | — | The Hono route `POST /api/webhooks/polar` (signature check, 202/403/500 contract) |
| `billing/purchases.ts` | `stripePurchases`, comments ("Stripe's fee", "Checkout Session id") | **E**: rename to `polarPurchases`. `PaidPurchase.ref` docs become `polar:order:<id>`. Add the `poolPurchasesEnabled` check to `assertPurchasable` (D1). |
| `billing/ledger.ts` | `CreditGrantInput.stripeRef`, SQL `stripe_ref`, `ON CONFLICT(stripe_ref)`, `hasGrant`/`grantByRef` | **E**: rename to `providerRef` / `provider_ref` (migration 0014). Update the docs on fee and gross ("the processor's fee"). |
| `billing/membership.ts` | `auth_subscriptions` join, `stripeStatus`, `billingConfigured`/`membershipPriceId` imports, comments | **E**: join `billing_subscriptions`. `providerStatus`. `membershipRequired` uses `membershipProductId`. |
| `billing/reconcile.ts`, `meter.ts`, `gate.ts`, `usage-store.ts`, `pricing.ts` | none | Unchanged. |
| `auth/auth.ts` | `import { stripe } from '@better-auth/stripe'`, `stripePlugin`, `membershipPlans`, `subscription: authSubscriptions` mapping, `handleStripeEvent` import, header comment | **E**: remove the plugin, the `subscription` schema mapping and the related imports. **Decision D2: do not add `@polar-sh/better-auth`.** |
| `auth/delete-account.ts` | `import Stripe`, `deleteStripeCustomer`, `stripe_customer_id` select, `auth_subscriptions` delete, `stripeCustomerDeleted`, the error text "Couldn't cancel your billing with Stripe" | **E** per §2.7 |
| `auth/account.ts` | imports `accountIdForUser` from `billing/stripe.js` | **E**: define it here (or import it from `billing/polar.ts`) |
| `pool/supporter.ts` | imports `accountIdForUser` from `billing/stripe.js` | **E**: import path |
| `pool/pool-bank.ts` | `stripeRef: req.refId` (l.476), comment (l.149) | **E**: `providerRef`; comment |
| `routes/billing.ts` | `stripePurchases`, comment on `/api/auth/subscription/*` | **E**: `polarPurchases`. Add `POST /membership/checkout` and `POST /portal` (both `sameOriginOnly`, signed-in). |
| `routes/admin.ts` | `stripeRef: ref` (l.413), comments | **E/C** |
| `app.ts` | (indirect: `/api/auth/*` carried the Stripe webhook) | **E**: register `app.post('/api/webhooks/polar', …)` before `sessionMiddleware` |
| `cron.ts` | none | **E**: add the `polarDisputes` job |
| `services.ts` | imports `billingConfigured` from `billing/stripe.js` | **E**: import path |
| `config.ts` | comments (l.154–164) naming Stripe and `STRIPE_MEMBERSHIP_PRICE_ID` | **C**. Add `flags.poolPurchasesEnabled` (D1). |
| `env.ts` | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | **E**: `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET` (secrets) |
| `db/schema.ts` | `authUsers.stripeCustomerId` + `auth_users_stripe_customer_idx`; `authSubscriptions` (`stripe_customer_id`, `stripe_subscription_id`, `stripe_schedule_id`); `creditGrants.stripeRef`; comments | **E** per §4.1 |
| `http/landing.ts` (l.269) | "manage billing in Stripe"; "Payment processing fees come out of each purchase" | **C**: "…manage billing in the Polar customer portal". The fee sentence stays. |
| `http/legal.ts` | l.11 ("Stripe public details"), l.111 (Stripe customer id, card data goes to Stripe), l.130 (processor list), l.153 (Stripe keeps records), l.161 (deletes Stripe customer, "monthly plan"), l.226 (Stripe fee), l.229 (refund/withdrawal) | **E**, legal substance: name **Polar Software Inc. as Merchant of Record/reseller** (purchases are made from Polar; Polar's buyer terms apply; Polar handles tax, invoices and refunds); processors become "Polar (USA): payments as merchant of record, tax, invoices; Polar uses Stripe"; the deletion text says the Polar customer record is anonymised and the membership cancelled; bump `LEGAL_UPDATED`. Have the operator review. |

### 3.2 Worker config, migrations, tests (`apps/worker`)

| File | Change |
|---|---|
| `package.json` | Remove `stripe@^22.6.2` and `@better-auth/stripe@1.7.7`. Add `@polar-sh/sdk@1.0.2` (pin exactly; the API version is in the import path). |
| `wrangler.jsonc` | Vars: `STRIPE_CREDITS_PRODUCT_ID` → `POLAR_CREDITS_PRODUCT_ID`, `STRIPE_MEMBERSHIP_PRICE_ID` → `POLAR_MEMBERSHIP_PRODUCT_ID`, plus new `POLAR_SERVER` (`"production"` in the deployed config, D8) and `POOL_PURCHASES_ENABLED: "false"`. Rewrite the comments (l.142–195) and the secrets list (l.273). |
| `worker-configuration.d.ts` | Regenerate (`wrangler types`). |
| `.dev.vars.example` | Replace the Stripe block (l.41–60, 73–75) with Polar sandbox: `POLAR_ACCESS_TOKEN=polar_oat_…`, `POLAR_WEBHOOK_SECRET=whsec_…`, `POLAR_SERVER=sandbox`, product ids. Local webhooks need a tunnel, e.g. `cloudflared tunnel --url localhost:8787`, because Polar has no `listen` CLI (PLAUSIBLE; check the docs for an ngrok/CLI forwarder). Replace the Option C placeholders with `POLAR_ACCESS_TOKEN=polar_oat_placeholder` etc. |
| `migrations/0003_billing.sql`, `meta/0003…0013_snapshot.json` | **K**: history is immutable. |
| **N** `migrations/0014_polar.sql` + `meta/0014_snapshot.json` | §4.1 (generate with drizzle-kit, then review the renames by hand) |
| `vitest.config.ts` | Replace `mockStripe`/`STRIPE_ORIGIN` with `mockPolar`/`POLAR_ORIGIN` (`https://sandbox-api.polar.sh` with `POLAR_SERVER: 'sandbox'`). Bindings: `POLAR_ACCESS_TOKEN: 'polar_oat_test'`, `POLAR_WEBHOOK_SECRET: 'whsec_<base64>'`, `POLAR_CREDITS_PRODUCT_ID`, `POLAR_MEMBERSHIP_PRODUCT_ID: ''`. |
| `test/env.d.ts` | Binding names |
| `test/mocks/stripe.ts` | **D** → **N** `test/mocks/polar.ts`. Mock endpoints: `POST /v1/checkouts/`, `POST /v1/customer-sessions/`, `GET /v1/orders/:id`, `GET /v1/disputes/`, `GET /v1/subscriptions/`, `POST/DELETE` on subscription revoke, `DELETE /v1/customers/external/:id`. Keep the `/__mock/calls|objects|reset` control endpoints and the auth check (`Bearer polar_oat_`). |
| `test/mocks/billing-helpers.ts` | `insertUser(stripeCustomerId)` → `billingCustomerId`; `insertSubscription` → the `billing_subscriptions` row; `grantsFor` and others read `provider_ref`; `stripeCalls` → `polarCalls`. Add a `signPolarWebhook(body, secret)` helper (Standard Webhooks HMAC-SHA256 over `${id}.${ts}.${body}`). |
| `test/billing-webhook.test.ts` (95 hits) | **R**: same scenarios on Polar payloads: credit once on redelivery; fee from `platform_fee_amount`; null fee → throw; non-USD ignored; membership credit on `subscription_create`/`subscription_cycle` only; refunds (personal, pool clamped, membership once, out-of-order refund → throw); unknown target. |
| `test/billing-webhook-endpoint.test.ts` | **R**: the real route, signed deliveries; 403 on a bad signature, 202 on an unknown type, 500 on a handler throw, raw body. |
| `test/pool-purchase.test.ts` (66) | **R**: checkout metadata (Polar mock), pool fulfilment margin, refund and dispute debits, `POOL_PURCHASES_ENABLED` gate |
| `test/billing-checkout.test.ts` (19) | **R**: the `checkouts.create` body (ad-hoc price, `external_customer_id`, metadata, URLs), no customer pre-creation |
| `test/billing-ledger.test.ts` (23), `multi-user.test.ts` (20), `billing-membership.test.ts`, `annual-fee.test.ts`, `accounts.test.ts`, `billing-routes.test.ts`, `auth.test.ts`, `pool-pages.test.ts`, `pool-abuse.test.ts`, `pool-impact-tagging.test.ts`, `pool-bank.test.ts`, `pool-helpers.ts`, `pool-routing.test.ts`, `supporter.test.ts`, `config.test.ts`, `billing-meter.test.ts`, `session-client.ts` | **E**: env names, `stripe_ref` → `provider_ref`, `stripeStatus` → `providerStatus`, the subscription fixtures, the deletion result field. Mostly mechanical. |
| **N** `test/polar-disputes.test.ts` | The poller: debit on `needs_response`, no-op on `prevented`, reinstate on `won`, suspend on `lost`, idempotent across runs, a Polar error doesn't throw out of the cron |
| `test/cron.test.ts` (if it exists) / cron spies | Add the new job |

### 3.3 Shared types (`packages/shared/src`)

| File | Change |
|---|---|
| `billing.ts` | `MembershipInfo.stripeStatus` → `providerStatus`; reword comments l.10, 55, 74, 85–92, 106, 112, 130, 139, 149 (Stripe Tax → tax added at checkout by Polar; "Stripe's fee" → "the payment processor's fee"). `MIN_TOP_UP_CENTS` per D4. `MEMBERSHIP_PLAN` stays as the metadata `kind` value or is renamed `MEMBERSHIP_KIND`. |
| `api.ts` | Route table l.73–75: remove `/api/auth/subscription/*` and `/api/auth/stripe/webhook`; add `POST /api/billing/membership/checkout`, `POST /api/billing/portal`, `POST /api/webhooks/polar`. Comments l.207 and l.305. Add a `PortalResponse { url }` type if it doesn't reuse `CheckoutResponse`. |
| `pool.ts` (l.102) | Comment: `fundingOpen` = credits product set up **and** pool purchases enabled |
| `admin.ts` (l.151–154) | **C** |

### 3.4 Frontend (`packages/web-shared`, apps)

| File | Change |
|---|---|
| `packages/web-shared/package.json`, `apps/simple/package.json` | Remove `@better-auth/stripe`. No Polar package is needed in the browser (hosted checkout). |
| `core/auth-client.ts` | Remove `stripeClient({ subscription: true })` and its comment |
| `core/billing-client.ts` | **R**: `upgrade()` → `POST /api/billing/membership/checkout` → `location.assign(url)`; `portal()` → `POST /api/billing/portal`; delete `list()` and `BillingSubscription` (Stripe-shaped); map 404 `no_customer` to a `BillingError` code. It can move onto `ApiClient`. |
| `core/api-client.ts` | Comments l.155 and l.342; add `membershipCheckout()` and `portal()` if `BillingClient` is folded in |
| `billing/membership.ts` | `stripeStatus` → `providerStatus`; comments l.17, 30, 40, 49; `MembershipUpgrader.upgrade` signature simplifies (no `plan`) |
| `billing/billing-controller.ts` | `portalMessage` codes `CUSTOMER_NOT_FOUND`/`SUBSCRIPTION_NOT_FOUND` → `no_customer`; comments |
| `billing/billing-page.ts` | `stripeStatus` (l.116, 128, 227) → `providerStatus`; copy l.41–42, 345, 394 |
| `billing/membership-gate.ts` | Comments l.76, 103 |
| `pool/pool-fund-controller.ts`, `pool-fund-section.ts`, `pool-block-notice.ts` | Comments; the "funding opens soon" state now also covers `POOL_PURCHASES_ENABLED` off |
| `account/delete-account.ts` (l.20) | Copy: "…your customer record with Polar, which cancels your membership" |
| `demo/backend.ts` (l.80), `demo/index.ts` (l.28) | `providerStatus: null`; comment "Stripe plans" → "payments" |
| Specs: `billing-client.spec.ts`, `billing-controller.spec.ts`, `membership.spec.ts`, `membership-gate.spec.ts`, `api-client.spec.ts`, `auth.spec.ts`, `pool-fund-controller.spec.ts`; `apps/canvas/.../canvas-store.spec.ts`, `apps/simple/.../account-store.spec.ts`, `lesson-store.spec.ts`, `apps/web/.../tree-store.spec.ts` | Fixture rename `stripeStatus` → `providerStatus`; URLs `checkout.stripe.com` → `polar.sh/checkout/...`; "Stripe is down" → "Payments are down"; billing-client spec rewritten for the new endpoints |
| `apps/web/src/app/app.routes.ts` (l.13), `apps/simple/src/app/app.routes.ts` (l.16) | **C**: "where checkout sends the browser back" |
| `apps/admin/src/app/pool-page.ts` (l.64) | **C** |

### 3.5 Docs

| File | Change |
|---|---|
| `README.md` (42 hits) | Rewrite "Membership, credit and billing": Polar dashboard setup (org, sandbox then production, the credits one-time product with a USD price, the membership yearly product $10 exclusive, portal settings, the webhook endpoint URL `/api/webhooks/polar` and the event list in §2.4, OAT scopes `checkouts:write, customers:read/write, customer_sessions:write, orders:read, refunds:read, disputes:read, subscriptions:read/write`), the secrets, "How pricing works" (Polar fees, MoR, no tax registration), refunds and disputes (polling), local testing, and the env table rows l.409–414. Remove the "Stripe Managed Payments" note (Polar is the MoR). |
| `docs/DECISIONS.md` | Add a "Payments on Polar" section that supersedes l.156–171, 231–235, 255–256. Each superseded bullet gets "(superseded by Polar, see …)", or move them to a history note. |
| `docs/PLAN.md` | §2.3 architecture diagram l.25–28, l.52–53, l.94–104, the l.122–124 table, l.488, l.605–610, l.632 |
| `docs/LEGAL.md` | l.37, 43, 70–74, 107, 148–153: Polar public details (org name, support email, terms and privacy links), tax registration items → "Polar is MoR; only income tax"; DPA with Polar; the EU withdrawal acknowledgment is now Polar's checkout terms (PLAUSIBLE that Polar's checkout collects it; verify) |
| `docs/DEFERRED.md` | l.9, 11, 14: reword for Polar (renewal emails are Polar's customer emails; old monthly plans are moot) |
| `docs/RESEARCH.md` | Historical; add a pointer to `docs/polar-migration/` |
| `docs/pool/SPEC.md`, `docs/pool/PLAN.md` | Historical design docs: **K**, plus a single note at the top that payments moved to Polar. Update PLAN.md l.749/777 (margin covers the fee) via D4. |

---

## 4. DB, env and dependency changes

### 4.1 Migration `0014_polar.sql` (pre-launch: rename and drop)

```sql
-- credit_grants: provider-neutral idempotency key
ALTER TABLE credit_grants RENAME COLUMN stripe_ref TO provider_ref;
DROP INDEX credit_grants_stripe_ref_unique;
CREATE UNIQUE INDEX credit_grants_provider_ref_unique ON credit_grants (provider_ref);

-- auth_users: provider customer id (Polar customer UUID, set from webhooks; informational)
ALTER TABLE auth_users RENAME COLUMN stripe_customer_id TO billing_customer_id;
DROP INDEX auth_users_stripe_customer_idx;
CREATE INDEX auth_users_billing_customer_idx ON auth_users (billing_customer_id);

-- membership: our own table (the Polar Better Auth plugin keeps none)
DROP TABLE auth_subscriptions;
CREATE TABLE billing_subscriptions (
  id TEXT PRIMARY KEY,               -- Polar subscription id
  provider TEXT NOT NULL DEFAULT 'polar',
  user_id TEXT NOT NULL,             -- customer.external_id
  kind TEXT NOT NULL,                -- 'membership'
  product_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_period_start TEXT, current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  canceled_at TEXT, ends_at TEXT, ended_at TEXT,
  modified_at TEXT NOT NULL,         -- provider's, for out-of-order guards
  updated_at TEXT NOT NULL
);
CREATE INDEX billing_subscriptions_user_idx ON billing_subscriptions (user_id, kind);
```

Notes:

- D1 is SQLite ≥ 3.45, so `RENAME COLUMN` works. The Drizzle snapshot must match: run `drizzle-kit generate` from the edited `schema.ts`, then **check by hand** that it emitted renames, not drop and add.
- Existing rows: pre-launch, so `credit_grants` holds only `admin:`/`dev:` refs and perhaps test-mode `cs_…`/`in_…`/`re_…`/`du_…` ids from local testing. They stay valid as opaque unique strings and can't collide with `polar:`-prefixed refs. `auth_users.stripe_customer_id` values (test mode at most) become meaningless; set them to NULL in the same migration (`UPDATE auth_users SET billing_customer_id = NULL`). `auth_subscriptions` is dropped; any test-mode rows go with it.
- No disputes table is needed: ledger refs make the poller idempotent.

### 4.2 Env and secrets

| Remove | Add | Kind |
|---|---|---|
| `STRIPE_SECRET_KEY` | `POLAR_ACCESS_TOKEN` (`polar_oat_…`, org-scoped) | secret |
| `STRIPE_WEBHOOK_SECRET` | `POLAR_WEBHOOK_SECRET` (`whsec_…`) | secret |
| `STRIPE_CREDITS_PRODUCT_ID` | `POLAR_CREDITS_PRODUCT_ID` (UUID) | var |
| `STRIPE_MEMBERSHIP_PRICE_ID` | `POLAR_MEMBERSHIP_PRODUCT_ID` (UUID; a product, not a price) | var |
| — | `POLAR_SERVER` (`sandbox` \| `production`) | var |
| — | `POOL_PURCHASES_ENABLED` (`"false"`) | var |

After deploying, run `wrangler secret delete STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET` (if set) and delete the Stripe webhook endpoint in the Stripe dashboard.

### 4.3 Dependencies

- `apps/worker`: −`stripe`, −`@better-auth/stripe`, +`@polar-sh/sdk@1.0.2`.
- `packages/web-shared`, `apps/simple`: −`@better-auth/stripe`.
- Regenerate `pnpm-lock.yaml`.
- Plan a Polar API version bump about every 6 months: `2026-10` is deprecated around April 2027.

---

## 5. Open decisions, each with a recommended answer

| # | Decision | Recommendation |
|---|---|---|
| D0 | Launched or pre-launch? Legacy Stripe path? | **Pre-launch (§1). Hard cutover.** No Polar Stripe migration, no 120-day legacy webhook, delete the Stripe code. Gate this on the §6 step 0 checks; if they find live objects, use the fallback. |
| D1 | Community pool purchases vs Polar's AUP ("donations, crowdfunding, community access … sponsorship" are prohibited) | **Ask Polar support in writing before the switch.** Ship with `POOL_PURCHASES_ENABLED="false"`: `fundingOpen` false and `target:'pool'` refused (400). Personal top-ups, the membership and admin/operator pool adjustments keep working. The operator can still fund the pool by admin adjustment from their own revenue. Flip the flag only on Polar's written OK. If Polar says no, the options are a separate processor for pool purchases, or a pool funded only by the operator. **Resolved 2026-10-05 (owner): revenue-funded pool, no customer pool purchases.** The pool purchase path, `POOL_PURCHASES_ENABLED` and the pool minimum are removed; Tangent adds `POOL_REVENUE_SHARE_BPS` (20%) of each membership payment after fees and of the markup on personal credit as it is used, as an operator expense (docs/DECISIONS.md "Revenue-funded community pool", [05](05-pool-framing.md)). Nothing to ask Polar. |
| D2 | `@polar-sh/better-auth` plugin vs own routes | **Own routes.** The plugin keeps no subscription table, can't do ad-hoc top-up prices, is a fast-moving 2.x adapter, and is unverified under workerd. We still need our own webhook for the ledger. That is three small routes plus one webhook route, with no new Better Auth surface. |
| D3 | Source of the processor fee for personal top-ups | **`order.platform_fee_amount`** (USD), read in `order.paid`. Verify in sandbox that it is non-null and final at `order.paid`, and compare it with `balance.order.fee` from the Events API. If it turns out to be absent at `order.paid`, fall back to a configured estimate (`POLAR_FEE_BPS` and `POLAR_FEE_FIXED_CENTS`, logged `fee_estimated`) rather than throw-and-retry, because 10 consecutive failures auto-disable the endpoint. |
| D4 | Minimums and margins given Polar's fees (Starter 5 % + 50¢, +1.5 % international; $15 per dispute) | `MIN_TOP_UP_CENTS` 500 → **1000** (the fee drops from 15 % to 10 % of a top-up; the fee is still passed through exactly). Pool (when D1 allows): `POOL_MIN_PURCHASE_CENTS` **2000** and `POOL_MARGIN_BPS` **1200**. At $20, the worst case is 6.5 % + 50¢ = $1.80, and the margin is $20 − $20/1.12 = $2.14. Update the PLAN tests that assert "margin ≥ fee" to the Polar fee formula. Move to Polar Pro ($20/month, 3.8 % + 40¢) once volume justifies it, and make the fee formula in tests configurable. **Pool part moot since 2026-10-05:** nobody buys pool credit and pool replies carry no markup (`POOL_MARKUP_BPS`, `POOL_MIN_PURCHASE_CENTS` removed); only the personal top-up minimum remains. |
| D5 | Disputes without webhooks | **Poll `disputes.list` in the 10-minute cron** (§2.6), with ledger-ref idempotency. Ask Polar to enable `disputes_enabled` if the list needs it. If it stays unavailable, poll Events API `balance.dispute` / `balance.dispute_reversal` instead. Acting only on `needs_response`/`under_review`/`lost` avoids double-debiting disputes Polar prevented with a refund. |
| D6 | Store Polar's customer id? | **Yes, informationally**, as `auth_users.billing_customer_id`, set from `order.customer.id` / `subscription.customer.id`. Polar is addressed by `external_id = user.id`. The stored id only decides whether deletion must call Polar and helps admin lookups. |
| D7 | Membership state source | **A local `billing_subscriptions` table upserted from `subscription.*` webhooks**, read by the one existing D1 query. Not `customers.getStateExternal` per request (rate limit and latency), and not a feature-flag benefit (an extra Polar concept with no gain for one plan). Optional: a weekly drift check against `subscriptions.list` (DEFERRED). |
| D8 | `POLAR_SERVER` default | Code default **`sandbox`**, so a missing var can't charge real cards. Committed `wrangler.jsonc`: `"production"`. `.dev.vars.example`: `sandbox`. Products and tokens differ between the environments, so a mismatch fails loudly (404/401) instead of charging. |
| D9 | Billing address on checkout | **Polar defaults** (it collects what tax needs; we no longer compute tax). Pass `require_billing_address: true` only if the operator wants addresses on invoices. |
| D10 | Refund debit timing | **Debit on `status === 'succeeded'`** (from `refund.created` or `refund.updated`), idempotent on the refund id. A pending refund that later fails then never removes credit. |
| D11 | Column naming | `provider_ref`, `billing_customer_id`, `billing_subscriptions` (provider-neutral, so a future processor change is not another schema rename). `MembershipInfo.providerStatus`. |
| D12 | Embedded vs hosted checkout | **Hosted** (a redirect, as today). The return/poll UX is unchanged. Embedded needs `@polar-sh/checkout` (React) and CSP changes, which don't fit the Angular apps. |
| D13 | Mirror usage into Polar events/meters | **No.** The internal micro-USD ledger stays authoritative (stage 1 §3). |
| D14 | Legal wording | Name Polar as MoR/reseller in `/terms` and `/privacy`, and in `docs/LEGAL.md`. Have the operator, or counsel, review before production. Bump `LEGAL_UPDATED`. |
| D15 | Polar account review ("AI content generation" is restricted) | Start Polar's account review **before** stage 4 code lands in production. Describe the product as a tutoring chat sold as prepaid usage credit plus a yearly membership, with a free tier, the community pool, funded by Tangent from its own revenue (20% of membership payments after fees and of the markup on credit as it is used; D1 resolved, nobody can buy pool credit). Reviewers will see the pool on the landing page and at `/pool`, which say the same. |

---

## 6. Cutover plan

0. **Confirm pre-launch (read-only; do this before deleting anything).**
   - Stripe Dashboard in **live** mode: Payments, Subscriptions and Customers are empty.
   - Remote D1:
     ```sql
     SELECT COUNT(*) FROM auth_subscriptions;
     SELECT COUNT(*) FROM auth_users WHERE stripe_customer_id IS NOT NULL;
     SELECT COUNT(*) FROM credit_grants WHERE stripe_ref NOT LIKE 'admin:%' AND stripe_ref NOT LIKE 'dev:%' AND stripe_ref IS NOT NULL;
     ```
   - `wrangler secret list`: is `STRIPE_SECRET_KEY` an `sk_live_` key? (Ask the operator; the value isn't readable.)
   - All zero or test-mode only: proceed. **Fallback if live objects exist:** keep the current Stripe webhook code as a legacy path at the same endpoint for 120 days, handling only `charge.refunded` and `charge.dispute.*`. Keep the `stripe_customer_id` column. Prefix new refs `polar:` (already planned). Move yearly subscribers with Polar's Stripe migration (they are single-item, quantity 1, so eligible; `subscription.migrated` → upsert `billing_subscriptions`). Raise the request for `merchant_migration_enabled` early.
1. **Polar setup (sandbox).** Create the org, the OAT with scopes (README list), the credits product (one-time, USD), the membership product (yearly $10, exclusive tax), the portal settings, and the webhook endpoint `https://<host>/api/webhooks/polar` with the §2.4 events. Ask support about D1 (pool) and D5 (`disputes_enabled`). Start the account review (D15).
2. **Stage 3: implement.** One branch, following §3 and §4. Order: migration and schema; `billing/polar.ts`; checkout routes; webhook route and handler; deletion; dispute poller; frontend; copy and legal; tests. `pnpm -w test` and typecheck must be green, with no `stripe` match left except migrations and history docs: `git grep -il stripe -- ':!apps/worker/migrations' ':!docs/pool' ':!docs/polar-migration'` should return only intentional mentions (Polar's use of Stripe in legal copy).
3. **Sandbox verification (stage 4)**, against the PLAUSIBLE items:
   - `platform_fee_amount` at `order.paid` (D3);
   - `Refund.amount` excludes tax;
   - `Subscription.modified_at` is present;
   - renewal order `billing_reason`;
   - customer deletion revokes subscriptions or not;
   - `disputes.list` access;
   - checkout `currency` forcing;
   - the webhook route under workerd with a real Polar delivery (tunnel);
   - the portal URL flow.
   Use test card 4242…; full refund, partial refund, and a membership subscribe/cancel/revoke.
4. **Production.** Create the production org, products and webhook. `wrangler secret put POLAR_ACCESS_TOKEN POLAR_WEBHOOK_SECRET`. Set the vars (`POLAR_SERVER=production`, product ids). `pnpm db:migrate:remote` (0014), then deploy. Delete the Stripe secrets and the Stripe webhook endpoint, and close or leave dormant the unused Stripe account. Turn on `ANNUAL_FEE_ENABLED` / `POOL_ENABLED` / `POOL_PURCHASES_ENABLED` only on their own schedules, the last one only after D1.
5. **Post-launch watch.** Alert on `polar_webhook_failed` (auto-disable risk), `pool_debit_shortfall`, `dispute_*` logs, and Polar's "endpoint disabled" email. Schedule the API-version bump (`2026-10` → `2027-01`) before about April 2027.
