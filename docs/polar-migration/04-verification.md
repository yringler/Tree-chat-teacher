# Polar implementation: notes and sandbox verification (stage 4)

Date: 2026-10-05. Inputs: [01-polar-research.md](01-polar-research.md), [02-stripe-to-polar-mapping.md](02-stripe-to-polar-mapping.md) and [03-architecture.md](03-architecture.md). This document records what changed while implementing the §9 plan of 03, and what still has to be checked against a real Polar sandbox before production.

---

## 1. Implementation notes

### Decisions taken during implementation

- **D4 (user): pool aligned with personal — fee passed through, 5% per-call markup, $10 min.** This supersedes stage 2's D4 recommendation and the earlier "keep the pool margin as-is" instruction.
  - A pool purchase is credited `gross − actual processor fee`, through the same `netOfFee` as a personal top-up (`billing/purchases.ts`). The flat margin is gone: `POOL_MARGIN_BPS`, `MARGIN_PERCENT`, `DEFAULT_POOL_MARGIN_BPS`, `poolCreditMicros` and `PoolConfig.marginBps` were removed. New `credit_grants` rows carry `margin_bps = 0`; the column stays for older rows.
  - The operator earns a per-call markup on the pool instead: `POOL_MARKUP_BPS` (default `500`, +5%). Pool reservations store it on the usage row (`usage_events.markup_bps`), and every settle path (the meter and `PoolBank` expiry) charges `chargeMicros(cost, markup, fee)` = cost × (1 + fee) × (1 + markup). Holds (`worstCaseHoldMicros`, `ceilingHoldMicros`) price the same factors, so a hold always covers its charge. `releaseUndispatched` still settles at 0.
  - Refunds and disputes of a pool purchase debit what the purchase actually credited (the grant's amount, prorated for partial refunds through `creditEquivalentMicros`), clamped by `PoolBank.debit` as before.
  - `POOL_MIN_PURCHASE_CENTS` stays `1000` ($10) and `MIN_TOP_UP_CENTS` stays `500` ($5), now as plain business choices; nothing relies on a margin covering a fee.
  - Shared `PoolStatusResponse.marginBps` became `markupBps`, and `poolMarginText` became `poolPricingText`: "A pool purchase adds what you paid minus the card processing fee. Each reply from the pool costs the AI provider's price plus a 5% markup."
- **Minimums remain configuration.** `MIN_TOP_UP_CENTS` (shared constant) and `POOL_MIN_PURCHASE_CENTS` (var) were not changed. Polar's fees (Starter 5% + 50¢, +1.5% on international cards) take 15% of a $5 top-up; revisit the minimums once real fees are known.

### Deviations from the 03 §9 plan

- **Synthetic Polar fixtures are TypeScript, not JSON** (`apps/worker/test/fixtures/polar.ts`). Each builder returns an SDK model (`models.Order`, `models.Refund`, `models.Subscription`, `models.Dispute`) so the type checker catches field-name mistakes against `@polar-sh/sdk@1.0.2`. The file is marked `SYNTHETIC`. Recorded sandbox deliveries can still be dropped in as JSON and fed to the same tests.
- **`webhook-id` is the delivery id.** The adapter rejects a signed delivery without one (`WebhookSignatureError`), since `validateEvent` already requires it.
- **A signed but unparsable delivery is acknowledged (202) and logged** (`polar_webhook_unreadable`) instead of answering 400: Polar would redeliver the same bytes, and repeated failures auto-disable the endpoint.
- **Membership version fallback.** `MembershipChanged.version` is `Subscription.modified_at`, else `created_at` (not the webhook timestamp): no later modification can precede the creation time, so the version guard stays monotonic.
- **Lost disputes suspend once.** Polar disputes are polled, so the same `lost` dispute is seen on every run. `apply.ts` writes a zero-amount `adjustment` row keyed `<disputeRef>:lost` the first time and suspends only then, so an admin lifting the suspension is not undone by the next poll.
- **Dispute polling window.** The poller reads the newest 300 disputes (3 pages of 100, statuses `needs_response`, `under_review`, `lost`, `won`) every 10 minutes. Older disputes are assumed settled.
