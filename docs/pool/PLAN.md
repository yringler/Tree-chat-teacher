# Community credit pool: implementation plan

This plan implements [SPEC.md](SPEC.md). It was written after reading the billing, metering, routing, auth, admin, frontend and data-layer code. File and line references are to the tree at commit `0462820` (2026-10-05). Baseline: `pnpm -r typecheck` passes and `apps/worker pnpm test` passes 280/280.

The stages below are S2 to S8b. The spec's step 1 is this document. Each stage typechecks, passes the tests, and is committed on its own. Every new behaviour ships behind `POOL_ENABLED`, which is off in `wrangler.jsonc` and on in `vitest.config.ts`, so `master` stays deployable between stages. Revision 2 of this plan answers a round of review; §11 lists the review points that were not adopted as proposed and why.

---

## 0. Summary of the key decisions

| Spec asks for | What exists | Decision |
|---|---|---|
| Append-only ledger with entry types `purchase`, `reservation`, `settlement`, `refund_of_reservation`, `admin_adjustment` | `credit_grants` (kinds purchase/subscription/refund/adjustment, idempotent on `stripe_ref`) plus `usage_events` (pending → settled/unresolved) (`billing/ledger.ts`, `usage-store.ts`) | **Adapt.** The pool is another ledger account id in the same two tables. Spec entry types map onto them as shown in §1.1. A settlement and its release are one row transition, made auditable by `settle_reason` (§1.1). **Spec deviation, needs sign-off (D1).** |
| Millicents | Integer micro-USD for the ledger, nano-USD for provider cost, BigInt rounding (`billing/pricing.ts`) | **Keep micro-USD.** 1 millicent = 10 micro-USD, so micro-USD is finer and already used everywhere. |
| `PoolBank` Durable Object for atomic spend | No money DO. Personal spend is check-then-insert and allows a bounded overdraft by design (`service.ts:34-38`, DECISIONS.md:155 and :222) | **Add `PoolBank`.** It serialises everything that can lower pool `available`. D1 is the authority; `PoolBank` keeps only a checkpointed sum of immutable rows (§1.2), verified by the cron. |
| Worst-case reservation | Flat `USAGE_HOLD_MICROS` hold (meter.ts:175-193) | **Two-step hold.** The reply is reserved in `TreeSession.send` before any node is written, at a ceiling computed from config (§1.2). The meter then shrinks it to the exact worst case of the assembled request. Summary, title and tagging calls reserve their exact worst case in the meter. |
| Release on failure or timeout (spec 2.4) | Personal: no cost and no generation id → settle at 0 | **Release only when nothing was sent upstream.** Once the request is dispatched, an abort or timeout settles from reported cost, then tokens × price, then the full hold. **Spec deviation, needs sign-off (D2):** the operator must not pay for upstream work the pool did not pay for. |
| Settlement | `settleUsage` conditional `UPDATE … WHERE status='pending'`, inline settle, OpenRouter reconcile, cron | **Reuse**, plus: pool charges clamp to `hold_micros`, the overage is recorded (`overage_micros`) and feeds a circuit breaker (§1.4), and `settle_reason` is written. |
| Per-model price table | None. Cost comes from OpenRouter `usage.cost` (DECISIONS.md:148) | **Add it to the config module**, with an optional per-entry `feeBps`. It bounds reservations, caps OpenRouter routing price (`provider.max_price`), and settles when no cost is reported. The reported cost still wins, so DECISIONS.md:148 gets a "(Since the pool, …)" note. |
| `MARGIN_PERCENT` applied at purchase, for all purchases | `MARKUP_BPS` at usage time plus the OpenRouter fee pass-through; purchases credited net of Stripe's fee | **Pool only:** margin at purchase (`POOL_MARGIN_BPS`, default 800; `MARGIN_PERCENT` is accepted as an alias, ×100). Personal credit keeps today's model because repricing existing balances contradicts Terms §7. **Spec deviation, needs sign-off (D3)**; the DEFERRED entry names the unification work. |
| Stripe webhook idempotent on the event ID | Idempotent on the Stripe **object** id (`stripe_ref` UNIQUE + `ON CONFLICT DO NOTHING`) | **Keep the object id.** It is strictly stronger: the same session arriving through both `checkout.session.completed` and `checkout.session.async_payment_succeeded` still credits once. Refunds key on the refund id, disputes on the dispute id (§1.3). |
| Funding source per request | `PAYMENT_HEADER` (`own-key`/`credit`) → `AccountContext.builtIn` (`auth/account.ts:48-99`) | **Extend.** `LearnPayment` gains `'pool'`. `AccountContext` gains `funding` and, for pool, a `pool: PoolParams` block resolved Worker-side from `appConfig(c.env)` (§3). The server decides. |
| `ANNUAL_FEE_ENABLED` | The fee is implicitly on when `STRIPE_MEMBERSHIP_PRICE_ID` is set (`membership.ts:24-26`) | **AND the flag into `membershipRequired`.** No code path is deleted. |
| Per-IP and per-user rate limits | CF rate-limit bindings exist and fail open (`byok/guard.ts`, `share/rate-limit.ts`) | **Counters in `PoolBank`'s SQLite storage** (the spec's DO alternative), so limits and periods live in `config.ts`. IPv6 is keyed on its /64. Pool limits **fail closed**. No new rate-limit binding, and `CHAT_RATE_LIMITER` is not shared. |
| Admin suspend flag | `auth_users.share_allowed` pattern (migration 0009, admin PATCH) | **Copy the pattern** as `pool_suspended`. |
| Turnstile on signup and first login | Turnstile protects only `/sign-in/magic-link`. OAuth relies on the provider's bot checks (`auth.ts:247-249`) | **Default: one server-verified Turnstile pass before first pool use**, plus one pool identity per normalised mailbox. **Spec deviation, needs sign-off (D4)**; the spec-literal alternative (post-OAuth interstitial) is specified in §9 so it can be switched on without redesign. |
| Featured conversations | None. Share links are gated by `DMCA_AGENT_REGISTERED` | **Stub only** (§S8b). |

Where the pool appears in the apps:

* **Learn (`apps/simple`)** is the only app that spends from the pool.
* **Power (`apps/web`)** and the shared billing page get only the fund-the-pool section.
* **Canvas** gets nothing. It acts as the power account and only links to `/billing`.

---

## 1. Ledger and the never-negative invariant

### 1.1 Entry-type mapping (documented in DECISIONS)

| Spec entry | Stored as |
|---|---|
| `purchase` | `credit_grants` row, `kind='purchase'`, `account_id = 'u_<uid>'` or the pool id, `user_id` = buyer, `gross_micros` = pre-tax gross, `margin_bps` = margin applied (pool) or 0 |
| `admin_adjustment` | `credit_grants` row, `kind='adjustment'`, `stripe_ref = 'admin:<idempotencyKey>'`, `user_id` = target user or null, `gross_micros` null |
| `reservation` | `usage_events` row inserted `status='pending'`, `hold_micros` = worst case, `funding='pool'` |
| `settlement` | the same row moved to `status='settled'`, `charge_micros = min(actual, hold_micros)`, `overage_micros = max(0, actual − hold)`, `settle_reason ∈ cost|generation|tokens|hold` |
| `refund_of_reservation` | the same transition with `settle_reason='released'` and `charge_micros = 0`. `hold − charge` is the released amount, readable from the row |
| refund or dispute of a pool purchase | negative `credit_grants` `kind='refund'`, written through `PoolBank.debit` (§1.3), always written even when clamped to 0 |

Notes:

* A row never mutates once it leaves `pending`, so the table stays effectively append-only, as for the personal ledger. A replay or audit distinguishes a release (`released`) from a zero-cost call (`cost`, cost 0). This is deviation D1: spec entries are row states, not separate rows.
* Stripe ids start with `cs_`, `in_`, `re_` or `du_`, so the `admin:` prefix can never collide.

### 1.2 Mechanism

```
available(pool) = Σ credit_grants.amount_micros(pool)
                − Σ settled usage_events.charge_micros(pool)
                − Σ pending usage_events.hold_micros(pool)
```

The invariant is `available(pool) ≥ 0` at all times.

The only operations that can **lower** `available` are:

1. reserve (inserting a pending row),
2. a negative grant (refund, dispute or negative adjustment).

**Both run only inside `PoolBank`, under its lock, one at a time.** Everything else can only raise `available` and may run anywhere, concurrently, without the lock:

* a settle replaces a hold with a charge ≤ the hold (clamped);
* shrinking a pending hold (`UPDATE … SET hold_micros = MIN(hold_micros, ?) WHERE status='pending'`);
* expiry, which is a settle;
* a positive grant.

**`PoolBank` design** (`apps/worker/src/pool/pool-bank.ts`):

* `extends DurableObject<AppEnv>`, one instance per pool account id (`env.POOL_BANK.idFromName(poolId)`). The pool id comes from `AccountContext.pool.accountId` (Worker-resolved `POOL_ACCOUNT_ID`, default `'pool'`), so HTTP tests use `authEnv({POOL_ACCOUNT_ID: 'pool-'+uuid})` and never share a pool.
* DO RPC methods (typed; `compatibility_date` 2026-08-15 supports them).
* A promise-chain mutex (the `sendLock` pattern, `tree-session.ts:88,136-137`) wraps `reserve`, `debit` and `admit`. DO input gates do not hold across D1 I/O. **The alarm and the cron never take the lock** because they only settle.
* **The DO reads no pool config from its own `env`.** Every limit, cap, price and TTL arrives as an RPC argument from `AccountContext.pool`, so per-request config (and per-test `authEnv`) applies.
* DO SQLite storage holds: the alarm; rate-limit window counters (§S4); the balance checkpoint `{balanceMicros, checkpointAt}`; the overage breaker state.

**Balance checkpoint.** `getBalance` sums every row ever written, which grows linearly. `PoolBank` keeps `balanceAtCheckpoint` = Σ grants with `created_at < checkpointAt` − Σ charges of rows with `status <> 'pending' AND created_at < checkpointAt`. Those rows are immutable, so the sum never goes stale. The checkpoint advances (in the cron, never under the reserve lock) to `now − 2 × giveUpMs`, and only if no pending row is older than that (all such rows are past give-up and settled). A reserve then reads `balanceAtCheckpoint + Σ newer grants − Σ newer settled charges − Σ pending holds`, served by the new indexes `usage_events_account_status_idx (account_id, status, created_at)` and `credit_grants_account_created_idx (account_id, created_at)`. The cron recomputes the full sum daily and logs a mismatch (the spec's "cached with the ledger as authority"). An empty or missing checkpoint means a full sum.

**`reserve(req)`** takes:

```ts
{ poolId, userId, ipKey, purpose, treeId, branchId, nodeId, providerId, model,
  holdMicros, feeBps, caps: PoolCaps /* free, supporter, global, ip */,
  limits: PoolRateLimits, overage: { windowMs, thresholdMicros }, countsTowardRate: boolean, now? }
```

Under the lock:

1. **Breaker:** if the overage breaker is tripped (§1.4), refuse `unpriced`.
2. **Rate** (only when `countsTowardRate`, i.e. for replies): per-user and per-IP window counters in DO storage; refuse `rate`.
3. One D1 batch:
   * the balance (checkpoint form above);
   * the user's day-to-date pool rows (`usage_events_pool_user_idx`): `requestsToday` = pending + settled `purpose='reply'`; `spendToday` = Σ settled charge + Σ pending hold, excluding `tagging`;
   * the IP key's day-to-date requests and spend (`usage_events_pool_ip_idx`);
   * the global free-tier spend today (`usage_events_pool_tier_idx`);
   * `isSupporter(db, userId, now)` (§S4), computed here, server-side, under the lock. The tier is never passed in.
4. Refuse in this order, each logged as structured JSON:
   * `cap_requests` (replies only), then `cap_spend` (`spendToday + holdMicros > cap`), per tier;
   * `cap_ip` (per-IP daily requests or spend);
   * `cap_global` (free tier only: `freeSpendToday + holdMicros > min(globalFreeDailyMicros, globalFreeDailyBps × availableAt00UTC)`);
   * `empty` (`available < holdMicros`).

   A refusal returns `{ ok:false, reason, resetAt, limit, supporter, supporterLimit }`.
5. `INSERT` the pending row (`account_id=poolId`, `funding='pool'`, `user_id`, `ip_key`, `tier`, `branch_id`, `hold_micros`, `markup_bps=0`, `fee_bps`) **before** returning `{ok:true, usageId}`.
6. Ensure an alarm at `now + reservationTtlMs` if none is earlier.

**`admit(req)`** is the rate and gate check without a reservation (used by `context?resolve`, whose summary calls then reserve through the meter).

**`debit(req)`** (S5): §1.3.

**Two-step reply hold.** The reply cannot be reserved precisely before the prompt is assembled, and it must be refused before `beginSend` writes nodes (otherwise a refusal becomes an error node, not a 402/429). So:

1. `TreeSession.send`, inside `sendLock` and **before** `chat.beginSend`, calls `PoolBank.reserve` with `holdMicros = ceilingHold(pool)` = `worstCase(inputBound = price.contextTokens, maxOutput)`. This is a true bound: any prompt larger than the context window is rejected upstream. A refusal throws `PoolBlockedError`; the DO serialises `{code, message, details}` and the Worker passes the status and details through (`errorResponse` gains `details`), so the client sees 402 `pool_empty` / 429 `pool_cap_reached` with no node written.
2. The `usageId` rides in `GenerateRequest.usageTag.reservationId`. The meter's pool strategy, on `begin`, computes the exact worst case and **shrinks** the row's hold (lock-free, only raises `available`). It never inserts a second row for that reservation.
3. If `beginSend` throws (branch busy, validation) or the run ends without calling the provider, `send`'s `finally` releases the reservation (`settle_reason='released'`), guarded by `dispatched_at IS NULL`.

The cost of this design: the last `ceilingHold` (about $0.014 on the flash model) of a user's daily spend cap cannot start a new reply. That is documented on `/pool`.

**Summary and title calls** made while serving a pool send, and tagging calls, reserve their exact hold in the meter through `PoolBank.reserve` (`countsTowardRate=false`). A refused summary returns an error event; `runGeneration` already treats a failed summary as failed (`failedSummaries`, chat-service.ts:492) and `applyBudget` falls back to truncation. A refused title call is skipped. A refused tagging call is skipped. Only the reply reservation can fail a send.

**`dispatched_at`.** The pool meter writes `usage_events.dispatched_at = now` immediately before `provider.stream()` is called, and awaits the write. Settlement for pool rows (`pool/settle-policy.ts`, shared by the meter, the alarm and the cron):

| State at settle | Charge | `settle_reason` |
|---|---|---|
| Not dispatched (`dispatched_at` null) | 0 | `released` |
| Provider returned non-2xx, or `fetch` threw before sending (the provider's error event carries `upstream: 'not_sent'|'rejected'`) | 0 | `released` |
| Reported `costUsd` | clamp(cost) | `cost` |
| Generation id, lookup succeeds | clamp(cost) | `generation` |
| Dispatched, tokens observed, no cost | clamp(tokens × price) | `tokens` |
| Dispatched, nothing observed (abort before first chunk, timeout on first token, eviction, a provider with no generation id) | full hold | `hold` |
| Generation id, still unresolved after `giveUpMs` | full hold | `hold` |

So a cancel during prefill is charged the hold, never 0. When the generation id later appears in a reconcile, an inline settle wins only if it runs first; the cron's give-up settles at the hold. Personal rows keep today's rules.

**Worst case** (`pool/pricing.ts`, extends `billing/pricing.ts`):

```
inputBound  = min(utf8Bytes(system + Σ message text) + 4·messages + 16, price.contextTokens)
holdMicros  = ceilMicros( (inputBound·inMicrosPerMTok + maxOutput·outMicrosPerMTok) / 1e6 , feeBps )
```

* Byte-level BPE tokenizers never emit more tokens than input bytes, so `utf8Bytes` is a true upper bound; chars/3.5 (`core/tokens.ts`) is not.
* `maxOutput` is the forced pool output cap, sent as `max_tokens`.
* The model priced is always `account.pool.model`, never `request.model` (§3), so a client-set `branch.model` can neither raise nor lower the hold.
* No price entry → the pool **refuses** with reason `unpriced`.

**Failure paths:**

| Situation | Outcome |
|---|---|
| Reply reserve refused | HTTP 402/429 with `PoolBlockDetails`; no node written; no upstream call |
| Summary/title/tagging reserve refused | Truncation fallback / no title / no tag; the send continues |
| Call fails before dispatch, or upstream rejects | Released at 0 |
| Call times out (`AbortSignal.any([signal, AbortSignal.timeout(callTimeoutMs)])`, default 120 s) or the user cancels | Settled per the table above (cost, tokens, or the full hold) |
| Crash between D1 insert and RPC reply | `begin`/`send` throws, no call; the row has no `dispatched_at`; the alarm releases it after the TTL |
| Crash mid-stream (eviction) | The alarm (`expirePoolReservations`) handles rows older than the TTL: no `dispatched_at` → release; generation id → one immediate lookup (`reconcileGeneration(..., {delaysMs:[0]})`); dispatched, no generation id → full hold; generation id still unresolved after `giveUpMs` (1 h) → full hold |
| Alarm lost | `alarm()` re-arms for the next pending row; the `*/10` cron also calls `expirePoolReservations` for every pool id with pending rows |

**Alarm bounds.** `expirePoolReservations` processes at most `POOL_EXPIRE_BATCH` (20) rows per call with a bounded `Promise.all`, each lookup with a single attempt and a 5 s fetch timeout, and re-arms immediately if more remain. It holds no lock, so reserves are never blocked by expiry.

**Personal reconcile.** `reconcilePendingUsage` filters in SQL: `WHERE status='pending' AND funding <> 'pool' AND created_at < ?`, so a backlog of pool rows never starves personal rows.

### 1.3 Pool purchase refunds and disputes

`charge.refunded` and `charge.dispute.funds_withdrawn` for a pool purchase both go through `PoolBank.debit`:

* `preTaxShare` (webhook.ts:190-212) also returns `metadata.userId`, `metadata.target` and the checkout session id.
* The original grant is looked up by `stripe_ref = <session id>`. The debit is credit-equivalent: `round(refundPreTaxMicros × grant.amount_micros / grant.gross_micros)`, so a $10 refund at 8% requests 9_259_259, not 10_000_000.
* `debit` inserts a negative grant of `min(requested, max(available, 0))` keyed on the refund id (or dispute id) **always**, even when the clamped amount is 0, so a redelivery or a later partial-refund event that lists earlier refunds again is a no-op. The row stores `user_id`, `gross_micros = −refundedGross` (unclamped) and the requested amount and shortfall in `note` (`requested=…;shortfall=…`). The shortfall is logged as operator-absorbed.
* `charge.dispute.funds_reinstated` (dispute won) credits back the amount actually debited, keyed on `<dispute id>:reinstated`.
* Personal purchases: refunds as today, plus `user_id` and negative `gross_micros` on the row. Disputes on personal purchases are now automatic too (a negative `refund` grant keyed on the dispute id, unclamped as for personal refunds), replacing "disputes are handled by hand" (DECISIONS.md:163 gets a "(Since the pool, …)" note).
* A lost dispute sets `auth_users.pool_suspended = 1` for the buyer, logged; an admin can lift it.

### 1.4 Overage circuit breaker and price capping

Clamped overage is real operator money, so it is bounded twice:

1. **Upstream price cap.** `poolProviderConfig` sends OpenRouter provider routing `options.extraBody = { provider: { max_price: { prompt: <in $/MTok>, completion: <out $/MTok> } } }` from the price table (`openai-compatible.ts:43-100` merges `extraBody`; `provider` is not a protected key). Over-priced routes fail upstream (non-2xx → released) instead of costing the operator. A provider config without this support (Workers AI) relies on the table being its own price.
2. **Breaker.** Every settle writes `overage_micros`. `reserve` reads Σ `overage_micros` for the pool over the last `POOL_OVERAGE_WINDOW_MS` (24 h) from the `account_status` index, cached in DO memory for 60 s. Above `POOL_OVERAGE_MAX_MICROS` (default 200_000 = $0.20) it refuses every reserve with `unpriced` and logs `pool_breaker_tripped` at error level (the operator's alert hook). The breaker resets when the window clears or an admin raises the threshold.

---

## 2. Schema migrations

All migrations are generated with `pnpm db:generate --name <name>` from `apps/worker`: `.sql`, `meta/NNNN_snapshot.json` and the `_journal.json` entry are committed together. Hand edits only append seed SQL. If another branch lands a number first, regenerate on top of it (commit 1ec0b0a). Enums stay TS-only (no CHECK constraints).

**`0010_pool_ledger` (S2)**

* `credit_grants`:
  * `+ user_id text`: buyer or beneficiary. Set on all new purchases, adjustments, refunds and disputes (refunds look it up from the original grant or metadata).
  * `+ margin_bps integer NOT NULL DEFAULT 0`.
  * `gross_micros` (exists) is now also set, negative and unclamped, on refund and dispute rows.
  * indexes `credit_grants_user_idx (user_id, kind)`, `credit_grants_account_created_idx (account_id, created_at)`.
* `usage_events`:
  * `+ funding text NOT NULL DEFAULT 'personal'` (`personal|pool`);
  * `+ user_id text` (every new row);
  * `+ branch_id text` (every new row, from `UsageTag.branchId`), so the weekly job never joins through `nodes`;
  * `+ ip_key text` (pool rows only): `HMAC-SHA256(BETTER_AUTH_SECRET, utcDay + ':' + ipPrefix)` truncated to 16 hex chars, where `ipPrefix` is the full IPv4 address or the IPv6 /64. It rotates daily, so it cannot link a user across days and stores no address;
  * `+ tier text` (pool rows: `free|supporter`);
  * `+ dispatched_at text`;
  * `+ overage_micros integer NOT NULL DEFAULT 0`;
  * `+ settle_reason text` (`cost|generation|tokens|hold|released|unresolved`; personal rows write it too);
  * the `purpose` TS enum gains `'tagging'`;
  * indexes `usage_events_pool_user_idx (account_id, user_id, created_at)`, `usage_events_pool_ip_idx (account_id, ip_key, created_at)`, `usage_events_pool_tier_idx (account_id, tier, created_at)`, `usage_events_account_status_idx (account_id, status, created_at)`.

**`0011_pool_access` (S4)**

* `auth_users`:
  * `+ pool_suspended integer NOT NULL DEFAULT 0`
  * `+ pool_verified_at text` (ISO, Turnstile pass)
  * `+ pool_identity text` with a unique partial index (`WHERE pool_identity IS NOT NULL`): SHA-256 of the normalised email (lower-cased; `+tag` stripped; dots removed for gmail.com/googlemail.com, which also map to one domain). Set at verification.
* None is a Better Auth additional field, so no auth endpoint can set them (as `share_allowed`, schema.ts:221-225).

**`0012_pool_consent_tags` (S8a)**

* `pool_consents (user_id text NOT NULL, notice_version integer NOT NULL, acknowledged_at text NOT NULL, PRIMARY KEY (user_id, notice_version))`. Writes are `INSERT … ON CONFLICT DO NOTHING`.
* `pool_topic_tags (branch_id text PRIMARY KEY, topic_id text NOT NULL, branch_depth integer NOT NULL, created_at text NOT NULL)`, index `pool_topic_tags_topic_idx (topic_id, created_at)`.
  * **No `user_id`, no `tree_id`, no text column.** A test asserts the exact column set.
  * **Sensitive topics are stored as the sentinel `topic_id = 'sensitive'`**, never the specific id. They are never named, so the specific id has no use, and storing it would be an identifiable record once joined with `usage_events.user_id`.
  * **Retention:** the weekly job deletes tags whose branch has had no pool `reply` row in the last 14 days. A branch used again later is re-tagged at its next pool exchange.
  * Account deletion: delete `pool_consents` for the user, and `pool_topic_tags` whose `branch_id` appears in the user's `usage_events`.

**`0013_pool_impact` (S8b)**

* `pool_impact_snapshots (week_start text PK, exchanges integer, learners integer, topics integer, avg_depth_milli integer, max_depth integer, deepest_topic_id text, created_at text)`
* `pool_impact_topics (week_start text, topic_id text, learners integer, exchanges integer, avg_depth_milli integer, PRIMARY KEY (week_start, topic_id))`. Published topics only.
* `pool_topic_reviews (topic_id text PK, status text NOT NULL /* pending|approved|rejected */, first_seen_week text NOT NULL, decided_at text, decided_by text)`

**Durable Object migration (S2):** `wrangler.jsonc` `migrations` gets `{ "tag": "v2", "new_sqlite_classes": ["PoolBank"] }` (v1 is never edited), plus binding `{ "name": "POOL_BANK", "class_name": "PoolBank" }`. Export it from `src/index.ts` and run `pnpm cf-typegen`.

Docs drift to fix in S2: PLAN.md:110 and README.md:263 omit 0008 and 0009; PLAN.md:124-125 table rows are malformed; the wrangler.jsonc:65 comment is stale.

---

## 3. Funding-source routing

**Header and context.**

* `LearnPayment = 'own-key' | 'credit' | 'pool'` (`packages/shared/src/billing.ts:32`). `accountRequest` accepts `'pool'`.
* `AccountContext` gains `funding: 'own-key' | 'personal' | 'pool'`, and `pool?: PoolParams` when funding is pool:

  ```ts
  interface PoolParams {
    accountId: string; model: string; price: ModelPrice /* incl. feeBps */; systemPrompt: string;
    maxInputTokens: number; maxOutputTokens: number; ttlMs: number; giveUpMs: number; callTimeoutMs: number;
    caps: PoolCaps; limits: PoolRateLimits; overage: {...}; ipKey: string;
  }
  ```

  It is resolved **Worker-side** from `appConfig(c.env)` and carried in `SessionSendBody.account` and `accountParams` (`tree-session.ts:30-58`; `pool` as one JSON param). The DO and `PoolBank` read no pool config of their own. A test asserts the round trip.

**Availability.** `builtInProviderUsable(env)` is split out of `builtInAvailable` (services.ts:130-134): the `simpleProviderConfig(env)` registry entry is available (respects `SIMPLE_PROVIDER` overrides and their `apiKeySecret`). Then:

* `builtInAvailable = personalCreditReady(env) && builtInProviderUsable(env)`, where `personalCreditReady = billingConfigured || flags.personalCreditEnabled` (`PERSONAL_CREDIT_ENABLED`, default false). This lets admin-granted personal credit be spent before Stripe is live; `assertCanSpend` uses the same predicate.
* `poolAvailable = flags.poolEnabled && builtInProviderUsable(env)`. No OpenRouter-specific key check.

**Sync step (`resolveAccount`):** simple mode: `pool` → `funding='pool'`, `builtIn = poolAvailable`; `credit` → `'personal'`; otherwise `'own-key'`. Power mode never uses the pool; a `pool` header is ignored.

**Async step (`resolveFunding`):** for **sends and `context?resolve` only**, if simple mode, `funding='personal'` and personal `available < USAGE_HOLD_MICROS`, fall back to `'pool'` when `poolAvailable`. Reviews never fall back: a Learn user with no credit who asks for a review still gets 402 `payment_required`.

**One gate helper** (`apps/worker/src/billing/gate.ts`), `assertCanGenerate(c, {providerId, model, purpose})`:

1. `assertMember`.
2. `resolveFunding`.
3. If pool: the pool gates (§S4, §S8a) then `PoolBank.admit` on `context?resolve` (sends are admitted by the reply `reserve` in the DO). Otherwise `assertGenerationAllowed` + `assertCanSpend` + `enforceRateLimit`, as today.
4. `c.set('account', final)`.

Routes call `chatOf(c, keys)` once for `getOwnedBranch`/`getOwnedNode`, then **rebuild `chat` after the gate** on send, review and `context?resolve`, so the summaries `context?resolve` generates run on the pool registry, settings and meter. `enforceRateLimit` and `isMetered` read the updated `c.var.account`.

**Pool restrictions** are injected only in `services.ts` (`services.ts:255`), and only for the chat service that generates (DO send/stream, `context?resolve`); a `generating` flag selects them. Non-generating routes (`/api/providers`, `createTree`, `createBranch`) keep `simpleProviderConfig`'s models and default, so a pool session never writes the pool model onto a branch.

* **Registry.** `poolProviderConfig(env, pool)`: `simpleProviderConfig` with `models = [pool.model]`, `defaultModel = pool.model`, `maxContextTokens = maxInput + maxOutput`, `maxOutputTokens = maxOutput`, and the `provider.max_price` `extraBody` (§1.4).
* **Forced model** (two layers):
  * *Core:* `ChatServiceDeps.pinnedModel?: string`. `beginSend` records it on the assistant node, and `runGeneration`, `budgetFor`, `summaryTarget` and `autoTitle` use it instead of `branch.model`. The branch row is not modified.
  * *Backstop:* `pinnedModelRegistry(meteredLazily(registry, …))` — the pin wraps the meter, so `request.model` is rewritten before `meter.begin` sees it. Independently, the pool funding strategy prices and records `account.pool.model` and ignores `request.model`.
* **Locked system prompt.** `ChatServiceDeps.systemPromptOverride?: string`; `loadPlanInputs` substitutes `{...tree, systemPrompt: override}`, the only entry point for the `tree-system-prompt` segment (`assemble.ts:124-135`). Anchor quotes and summaries still render as quoted context (`render.ts:31-66`); accepted.
* **Context and output limits.** `chatSettingsFor` for pool: `maxInputTokens`, `reservedOutputTokens = maxOutputTokens`, `summaryProviderId='tangent'`, `summaryModel = pool.model`, `autoTitle = true`. The gate rejects pool sends with `content.length > POOL_MAX_MESSAGE_CHARS` (400).
* **Reviews** are refused on an explicit pool header: 403 `pool_unavailable`.
* **Metering.** `meteredLazily` builds the meter with a `FundingStrategy`: `personal` (flat hold, D1 insert) or `pool` (consume `usageTag.reservationId` and shrink, or `PoolBank.reserve`; `dispatched_at`; timeout signal; pool settle policy).

---

## 4. The config module

There is one module: `apps/worker/src/config.ts`. It exports `appConfig(env): AppConfig`, parsed once per `env` object (WeakMap) and frozen. `appConfig` holds **raw parsed values only**; it imports nothing from `services.ts` (no import cycle).

Existing accessors keep their names and behaviour:

* `usageHoldMicros`, `usageMaxPending`, `markupFor`, `openRouterFeeBps` read `appConfig`.
* `membershipCreditCents` keeps its `builtInAvailable(env)` check and reads the raw cents from `appConfig`.
* `simpleMaxInputTokens` and `POOL_MAX_*` keep `positiveInt` semantics (0 is rejected and falls back); a test pins both.
* `DEFAULT_*` constants move into `config.ts` and are re-exported from their old modules.

Parsers: `intVar` (moved from `billing/vars.ts`, re-exported), `positiveInt`, `boolVar`, `jsonVar(raw, zodSchema, fallback)` (logs once, falls back).

```ts
interface ModelPrice { inMicrosPerMTok: number; outMicrosPerMTok: number; contextTokens: number; feeBps?: number /* default OPENROUTER_FEE_BPS */ }
interface AppConfig {
  flags: { poolEnabled; annualFeeEnabled; featuredConversationsEnabled; devPurchasesEnabled; personalCreditEnabled };
  prices: Readonly<Record<string, ModelPrice>>;
  billing: { usageHoldMicros; usageMaxPending; markupBps; openRouterFeeBps; membershipPriceCents; membershipCreditCentsRaw };
  pool: {
    accountId: string;                 // POOL_ACCOUNT_ID, default 'pool'
    model: string | null;              // POOL_MODEL; null → simpleFastModel(env, simpleProviderConfig(env)) at resolve time
    systemPrompt: string; marginBps: number; minPurchaseCents: number;   // 800; 1000
    maxInputTokens; maxOutputTokens; maxMessageChars;
    reservationTtlMs; giveUpMs; callTimeoutMs; expireBatch;
    sessionEstimateMicros;
    caps: {
      free: { requestsPerDay: 30; spendMicrosPerDay: 100_000 };
      supporter: { requestsPerDay: 150; spendMicrosPerDay: 500_000; monthsAfterPurchase: 12 };
      globalFree: { spendMicrosPerDay: 5_000_000; bpsOfMorningBalance: 2_000 };   // $5 or 20%, whichever is lower
      ip: { requestsPerDay: 60; spendMicrosPerDay: 300_000 };
    };
    limits: { userPerMinute: 6; ipPerMinute: 20 };
    minAccountAgeMs: number;           // default 0 (see §11)
    overage: { windowMs: 86_400_000; maxMicros: 200_000 };
    noticeVersion: number;             // code constant
  };
  impact: { minDistinctUsers: number /* default 5, floor 3 */; topicBlocklist: readonly string[];
            classifierMaxOutputTokens: 12; classifierInputChars: 2_000; tagRetentionDays: 14 };
}
```

**Safety clamps** (each logs once when it changes a value; `config.test.ts` covers them):

* `minDistinctUsers = max(3, value)`.
* `callTimeoutMs ≤ reservationTtlMs − 60_000`.
* `giveUpMs ≥ reservationTtlMs`.

**Env overrides.** Each scalar is a `wrangler.jsonc` `vars` string with a comment, pinned in `vitest.config.ts`, listed in `.dev.vars.example` where it matters, and typed by `pnpm cf-typegen`:

* `POOL_ENABLED`, `ANNUAL_FEE_ENABLED`, `FEATURED_CONVERSATIONS_ENABLED`, `DEV_PURCHASES_ENABLED`, `PERSONAL_CREDIT_ENABLED`
* `POOL_ACCOUNT_ID`, `POOL_MODEL`, `POOL_SYSTEM_PROMPT`, `POOL_MARGIN_BPS` (alias `MARGIN_PERCENT`), `POOL_MIN_PURCHASE_CENTS`
* `POOL_MAX_INPUT_TOKENS`, `POOL_MAX_OUTPUT_TOKENS`, `POOL_MAX_MESSAGE_CHARS`
* `POOL_RESERVATION_TTL_MS`, `POOL_GIVE_UP_MS`, `POOL_CALL_TIMEOUT_MS`, `POOL_EXPIRE_BATCH`
* `POOL_SESSION_ESTIMATE_MICROS`
* `POOL_FREE_REQUESTS_PER_DAY`, `POOL_FREE_SPEND_MICROS_PER_DAY`, `POOL_SUPPORTER_REQUESTS_PER_DAY`, `POOL_SUPPORTER_SPEND_MICROS_PER_DAY`, `POOL_SUPPORTER_MONTHS`
* `POOL_FREE_DAILY_GLOBAL_MICROS`, `POOL_FREE_DAILY_GLOBAL_BPS`, `POOL_IP_REQUESTS_PER_DAY`, `POOL_IP_SPEND_MICROS_PER_DAY`
* `POOL_USER_PER_MINUTE`, `POOL_IP_PER_MINUTE`, `POOL_MIN_ACCOUNT_AGE_MS`
* `POOL_OVERAGE_WINDOW_MS`, `POOL_OVERAGE_MAX_MICROS`
* `IMPACT_MIN_DISTINCT_USERS`, `POOL_TOPIC_BLOCKLIST`, `IMPACT_TAG_RETENTION_DAYS`
* `MODEL_PRICES`: JSON merged over the code defaults, validated with zod as integers.

Code rather than env: the taxonomy (`pool/taxonomy.ts`, re-exported by `config.ts`) and the notice text and version (`packages/shared/src/pool.ts`). With rate limits moved into `PoolBank`, every pool limit now lives in `config.ts`; there is no wrangler `ratelimits` exception for the pool.

**Test pins in `vitest.config.ts`** (S2): `POOL_MODEL: 'simple'` (a model the fake `tangent` provider lists); `MODEL_PRICES` with `simple: { in: 1_000_000, out: 1_000_000, context: 8_192 }` so any hold ≥ 1_500 µ$, above the fake's reported cost (0.001234 USD ≈ 1_302 µ$ at fee 550), and the clamp is hit only in the test that targets it; `POOL_FREE_REQUESTS_PER_DAY: '3'`, `POOL_FREE_SPEND_MICROS_PER_DAY: '1000000'`, supporter 6 requests; `POOL_USER_PER_MINUTE`/`POOL_IP_PER_MINUTE` above the request caps so the cap test sees `pool_cap_reached`, not `rate_limited`.

**Default prices are assumptions** (see §9): `deepseek/deepseek-v4-flash` in 100 000 / out 400 000 µ$ per MTok, context 131 072; `deepseek/deepseek-v4-pro` 500 000 / 2 000 000, context 131 072. The operator confirms them before enabling. A missing entry makes the pool refuse.

---

## 5. Tagging cost: decision

**Tagging is charged to the pool through the same reserve/settle flow**, `purpose='tagging'`, excluded from the user's daily request and spend caps and from the rate counters.

* Absorbing it in the margin would be an operator-key call outside the ledger, breaking spec property 1 and hiding the cost.
* Under the meter it inherits the worst-case hold, `dispatched_at`, the clamp, the breaker, expiry and logging.
* It is tiny: about 300 input and ≤ 12 output tokens, roughly $0.00004 on the flash model.
* If the pool cannot cover it, tagging is skipped silently; the exchange still counts in totals.

---

## 6. Stages

"Spec test" marks the bullets from the spec's Testing section (§7).

**Shared test helper.** S3 adds `apps/worker/test/pool-helpers.ts`: `poolReadyUser(env, {poolId?})` creates an `authEnv` client with a unique `POOL_ACCOUNT_ID`, seeds a pool grant, and returns `{client, poolId, userId}`. S4 extends it to set `pool_verified_at`; S8a extends it to insert a `pool_consents` row at the current version. **S4 and S8a both list "update `poolReadyUser`, re-run all S2–S7 pool tests" in their test lists**, so later gates never break earlier stages.

**Test harness facts** this plan relies on: per-test `authEnv` reaches only the Worker, which is why all pool config travels in `AccountContext.pool`; `runDurableObjectAlarm(stub)` takes no `now`, so expiry tests call a test-only `PoolBank.expire(now)` RPC (guarded by `env.TEST_SEAMS`) and use `runDurableObjectAlarm` only for re-arm/dispatch; `autoTitle` skips fake providers, so title reservation is tested in core with a recording provider.

### S2: ledger, PoolBank DO, reserve/settle/expiry

**Files to add**

* `apps/worker/src/config.ts` (§4).
* `apps/worker/src/pool/pool-bank.ts`: `reserve`, `debit` stub (S5 fills it), `admit` stub (S4), `alarm`, checkpoint, breaker, test-only `expire(now)` and `status()`.
* `apps/worker/src/pool/expiry.ts`: `expirePoolReservations(env, poolId, now, {batch})`.
* `apps/worker/src/pool/settle-policy.ts`: the §1.2 table as one pure function.
* `apps/worker/src/pool/pricing.ts`: `worstCaseHoldMicros`, `ceilingHoldMicros`, `costFromTokensNanos`, `poolCreditMicros(grossMicros, marginBps) = floor(gross·10⁴/(10⁴+margin))`.
* `apps/worker/src/pool/supporter.ts`: `isSupporter(db, userId, now, months)` (moved here from S4 because `reserve` uses it): Σ `gross_micros` over the user's `purchase` grants (any target) + Σ (negative) `gross_micros` over their `refund` grants > 0, **and** the latest purchase is within `months`. Admin adjustments never count. Legacy personal purchases (pre-0010, no `user_id`) count via `account_id = u_<uid>`.
* `apps/worker/src/pool/ids.ts`: `poolBank(env, poolId)`, `ipKey(secret, day, ip)` (IPv6 → /64).

**Files to change**

* `db/schema.ts`, migration `0010_pool_ledger`.
* `billing/ledger.ts`: `CreditGrantInput.userId?`, `marginBps?`; `getBalance` accepts an optional checkpoint.
* `billing/usage-store.ts`: new columns on `PendingUsageRow`; `markDispatched`; `shrinkHold`; settle clamp `CASE WHEN funding='pool' THEN MIN(?, hold_micros) ELSE ? END`; `overage_micros`; `settle_reason`. `settleUsage` returns `{changed, clamped}` via `UPDATE … RETURNING charge_micros, hold_micros, overage_micros` (callers updated).
* `billing/meter.ts`: `FundingStrategy`; `begin` receives the `GenerateRequest`; pool timeout signal; `dispatched_at`; pool settle policy; settlement order `costUsd` → generation lookup → tokens × price → (pool) hold / (personal) 0.
* `billing/reconcile.ts`: SQL filter `funding <> 'pool'`; cron calls `expirePoolReservations` for every pool `account_id` with pending rows and advances/verifies the checkpoint.
* `packages/providers/src/openai-compatible.ts`: error events carry `upstream: 'not_sent' | 'rejected' | 'stream'`.
* `packages/core` `UsageTag`: `+ branchId`, `+ reservationId?`.
* `billing/service.ts`, `membership.ts`, `simple-mode.ts`, `billing/vars.ts`: read through `appConfig` (§4 rules).
* `index.ts`, `wrangler.jsonc` (binding, DO migration v2, vars), `vitest.config.ts` (§4 test pins), `test/env.d.ts`, `worker-configuration.d.ts`.
* `packages/shared/src/provider.ts`: `UsagePurpose += 'tagging'`.

**Routes:** none.

**Tests** (`apps/worker/test/pool-bank.test.ts`, unique pool id per test)

* **Spec test (concurrency):** grant 50 000 µ$, `Promise.all` 40 reserves of 3 000 µ$ → exactly 16 succeed, `available ≥ 0` after each step; settle half at random actuals ≤ hold, release the rest; no pending rows, `Σcharge ≤ Σgrants`. Also end to end through `meteredRegistry` with the fake: 20 concurrent streams, all settled, balance ≥ 0.
* Caps inside `reserve`: request, spend, IP, global free ceiling; supporter computed from D1 (a supporter grant switches tiers without any argument change).
* **Spec test (expiry):** via `PoolBank.expire(now)`: undispatched row past TTL → released, `available` restored; dispatched with no generation id → charged the hold; generation id with lookup mocked to fail → hold after `giveUpMs`; `runDurableObjectAlarm` re-arms when rows remain. Cron backstop does the same.
* **Cancel before first chunk:** fake provider that waits; abort after `dispatched_at` is set → charge = hold, `settle_reason='hold'`. Upstream non-2xx → released at 0.
* Alarm bounds: 50 expired rows with generation ids and a slow lookup mock; a concurrent `reserve` completes within a bound (< 1 s) and the alarm re-arms.
* Settle clamp: actual > hold → `charge = hold`, `overage_micros` set, `clamped=true`; second settle `changed=false`.
* **Breaker:** a fake reporting cost > hold repeatedly until Σ overage > threshold → next `reserve` refuses `unpriced`.
* Checkpoint: balance with checkpoint = full sum; checkpoint not advanced while an old pending row exists.
* Personal reconcile: 250 old pool pending rows + 1 old personal row → the personal row reconciles.
* Hold shrink: reserve at ceiling, `begin` with `reservationId` shrinks and inserts no second row.
* `pool-pricing.test.ts`: ASCII/CJK byte bound, context clamp, rounding up, ceiling ≥ any exact hold, `poolCreditMicros(10_000_000, 800) = 9_259_259`, tokens × price with per-model `feeBps`.
* `config.test.ts`: defaults, overrides, malformed values, `MODEL_PRICES` validation, the three safety clamps, `MARGIN_PERCENT` alias, `positiveInt` for `SIMPLE_MAX_INPUT_TOKENS`, `membershipCreditCents` still 0 without the built-in provider.
* `supporter.test.ts`: gross netting; refund rows with `user_id`; 12-month expiry.
* Existing `billing-*.test.ts` stay green.

**Docs:** DECISIONS `## Community credit pool`: ledger mapping and D1; micro-USD; PoolBank serialises lowering operations, D1 authority, checkpoint; clamp, overage breaker, `max_price`; dispatch-based settle policy (D2); price table; pool margin at purchase vs personal markup. "(Since the pool, …)" notes on DECISIONS.md:148 and :163. PLAN.md §2 migration drift fix and a new §15 stub. README: migrations, `POOL_BANK`. wrangler comments.

### S3: funding-source routing and pool restrictions

**Files**

* `packages/shared/src/billing.ts`: `LearnPayment += 'pool'`.
* `packages/shared/src/pool.ts` (new): `FundingSource`, `PoolBlockReason = 'empty'|'cap_requests'|'cap_spend'|'cap_ip'|'cap_global'|'rate'|'unpriced'|'suspended'|'verify'|'duplicate_identity'|'too_new'`, `PoolBlockDetails`.
* `packages/shared/src/api.ts`: `ApiErrorCode += 'pool_empty' | 'pool_cap_reached' | 'pool_consent_required' | 'pool_unavailable'`; `ApiError.error.pool?: PoolBlockDetails`; route doc block.
* `packages/core/src/errors.ts`: `HTTP_STATUS` (`pool_empty` 402 for `empty`/`unpriced`, `pool_cap_reached` 429 for caps and rate, `pool_consent_required` 403, `pool_unavailable` 403) and `PoolBlockedError extends DomainError` with `details`.
* `apps/worker/src/http/errors.ts` and the DO's `errorResponse` (`tree-session.ts:120-126`): serialise `details`; the Worker's DO proxy passes status and body through.
* `env.ts`: `AccountContext.funding`, `pool?: PoolParams`, `isPoolFunded()`.
* `auth/account.ts`: header parsing, sync step, `PoolParams` resolution.
* `services.ts`: `builtInProviderUsable`, `poolAvailable`, `personalCreditReady`; `poolProviderConfig`; `registryFor`/`chatSettingsFor`/`defaultSystemPromptFor` pool branches behind `generating`; `pinnedModelRegistry` wrapping `meteredLazily`.
* `simple-mode.ts`: `poolProviderConfig`, default pool model via `simpleFastModel`.
* `do/tree-session.ts`: `accountParams`/`accountFromParams` (incl. `pool`); `send` reserves the reply under `sendLock` before `beginSend` and releases it in `finally` when undispatched; `pump()` receives the `AccountContext` from `send()` (used by S8a).
* `billing/gate.ts` (new): `assertCanGenerate`, `resolveFunding` (sends and `context?resolve` only).
* `routes/api.ts`: three call sites use the gate; `c.set('account')` then rebuild `chat`; review refused on an explicit pool header; `POOL_MAX_MESSAGE_CHARS`.
* `packages/core/src/services/chat-service.ts`: `ChatServiceDeps.pinnedModel`, `systemPromptOverride`.
* `packages/providers` fake provider: option `echoRequest: true`, which echoes the system prompt, model and `maxOutputTokens` in its reply text (test-only).
* `apps/simple` `PaymentStore.stored()` accepts `'pool'` (full UI in S6).
* `apps/worker/test/pool-helpers.ts` (`poolReadyUser`).

**Routes:** no new routes. `POST /api/branches/:id/messages` with `x-tangent-payment: pool` (or personal fallback) can answer 402 `pool_empty`, 429 `pool_cap_reached` (`pool:{reason, limit, resetAt, supporter, supporterLimit}`), 403 `pool_unavailable`, always before any node is written. `POST /api/nodes/:id/review` with a pool header → 403 `pool_unavailable`. `GET /api/branches/:id/context?resolve=true` is gated the same way.

**Tests** (`pool-routing.test.ts`; core tests in `packages/core/test/services`)

* **Spec test:** the pool ignores client-supplied model and system-prompt overrides. Tree with `model: 'smart'`, `systemPrompt: 'IGNORE ME'`, `PATCH`ed again, sent on the pool with the `echoRequest` fake → the echoed request has `model='simple'` (the pinned pool model), the locked prompt, and `maxOutputTokens = POOL_MAX_OUTPUT_TOKENS`; the usage row has `funding='pool'`, `model='simple'`, a hold priced from the `simple` entry. The same tree on personal credit still gets `smart` and its own prompt.
* Funding resolution: personal with balance → personal; personal with none → pool (send and `context?resolve`); review with none → 402 `payment_required`; `pool` header → pool; power + `pool` → never pool; `funding` and `pool` survive `accountParams`.
* **Reserve refused after the gate:** the pool emptied by a concurrent reserve → 402 `pool_empty` with details and **no user node** in the branch.
* `context?resolve=true` with fallback to pool → the summary rows are pool-funded.
* Refused summary reserve → the send completes with a truncated context. Refused title reserve (core, recording provider) → no title, send completes.
* Non-generating routes on a pool header: `/api/providers` lists the simple config's models; `createTree` stores the simple default.
* Context cap and the 400 for over-long messages. Review on the pool → 403.
* Core: `pinnedModel` (incl. `autoTitle` model with a non-fake recording provider) and `systemPromptOverride`.
* **Existing tests that change** (updated in this stage): `multi-user.test.ts:343-362` (`learn:'credit'`, no balance; the send and `context?resolve` cases now fall back to the pool, the review case keeps 402) and the similar cases at :476, :730 and :840. They run with `POOL_ENABLED: 'false'` in their `authEnv` to keep asserting the personal 402, and new cases assert the pool fallback.

**Docs:** DECISIONS (power never uses the pool; the server decides; fallback only for sends/resolve; reviews off on the pool; reply reserved before nodes). PLAN.md §15.

### S4: abuse controls

**Files**

* Migration `0011_pool_access`, `schema.ts`.
* `pool/pool-bank.ts`: rate-limit window counters (per user, per IP key; per minute) in DO SQLite storage, used by `reserve` (replies) and `admit`. Any storage or RPC error → refusal (**fail closed**).
* `pool/turnstile.ts`: `verifyTurnstile(env, token, ip)`, fail closed without `TURNSTILE_SECRET_KEY`.
* `pool/identity.ts`: `normaliseEmail`, `poolIdentity`.
* `billing/gate.ts`: pool gates in order:
  1. `userId` required (dev bypass refused: 403 `pool_unavailable`);
  2. `pool_suspended` → 403 `{reason:'suspended'}`;
  3. `pool_verified_at` null → 403 `{reason:'verify'}`;
  4. account younger than `minAccountAgeMs` → 403 `{reason:'too_new'}`;
  5. (S8a: consent);
  6. `PoolBank.admit` (resolve) / `reserve` (send, in the DO).
* `routes/pool.ts` (new, `/api/pool`, after the session middleware).
* `routes/admin.ts`, `packages/shared/src/admin.ts`: `AdminUser.poolSuspended`; `updateAdminUserRequestSchema` fields optional (at least one); the consumption report.
* Update `poolReadyUser` (sets `pool_verified_at` and `pool_identity`).

**Routes**

* `POST /api/pool/verify` (sameOriginOnly): `{ token }` → `{ verified: true }`. Sets `pool_verified_at` and `pool_identity` once; a second account with the same normalised mailbox gets 403 `pool_unavailable {reason:'duplicate_identity'}`.
* `PATCH /api/admin/users/:userId`: `{ shareAllowed?, poolSuspended? }`.
* `GET /api/admin/pool/usage?days=7&limit=50`: `{ since, rows: { userId, email, requests, spendMicros, tagging, lastAt }[] }`, by spend; plus `ipKeys: { ipKey, users, requests, spendMicros }[]` for today (farm detection).

**No OpenAI-compatible shape:** nothing is added; a test and a DECISIONS line.

**Tests** (`pool-abuse.test.ts`, `poolReadyUser` clients, which get their own IP)

* **Spec test (caps):** free tier hits `requestsPerDay` (3 in tests) → 429 `pool_cap_reached`, `resetAt` = next 00:00 UTC, not `rate_limited`. Spend cap likewise.
* **Spec test (supporter escalation):** after a simulated purchase (personal or pool) the same user gets supporter caps; a full refund (gross netting to 0) drops them back, **including when the pool refund debit was clamped to 0** (pool drained first); a purchase older than 12 months no longer counts.
* **Spec test (rate limits):** per-IP shared across two users on one IP; two IPv6 addresses in the same /64 share a bucket; different /64s are independent; a `PoolBank` error refuses.
* Per-IP daily cap and the global free ceiling refuse with `cap_ip` / `cap_global`; supporters are not counted against the global free ceiling.
* `duplicate_identity`: `a.b+x@gmail.com` after `ab@gmail.com` → 403.
* Suspend/unsuspend; unverified → 403 `verify`; verify with `'pass'` / bad token; dev bypass refused; OpenAI-compatible paths 404; extra body fields stripped; admin report order; non-admin 404.
* Re-run all S2–S3 pool tests with the updated helper.

**Docs:** DECISIONS (fail closed; limits in PoolBank; Turnstile at first pool use, D4; identity normalisation; supporter definition incl. 12 months; global ceiling). LEGAL.md (Turnstile at pool use; `ip_key` is a daily-rotating keyed hash, kept with the usage row). README (admin suspend flag, the farm report).

### S5: purchase interface, dev/admin top-up, Stripe checkout target and webhook

**Files**

* `billing/purchases.ts` (new):

  ```ts
  type PurchaseTarget = 'personal' | 'pool';
  interface CheckoutRequestInput { target: PurchaseTarget; amountCents: number; user: {id,email,name}; account: AccountContext; baseUrl: string }
  interface PurchaseProvider { createCheckout(i: CheckoutRequestInput): Promise<CheckoutResponse> }
  interface PaidPurchase { target; userId: string | null; grossCents: number; processorFeeCents: number; ref: string }
  function fulfilPurchase(env, p: PaidPurchase): Promise<boolean>   // the only place purchase credit is computed
  ```

  * `stripePurchases(env)` wraps `createCreditCheckout` (`service.ts:230-281`), adding metadata `target` and `userId` (also on `payment_intent_data`); pool uses the pool account id. Pool checkout requires `amountCents ≥ POOL_MIN_PURCHASE_CENTS` (default 1000).
  * `fulfilPurchase`: personal → `netOfFee` (unchanged); pool → `amount = poolCreditMicros(gross, POOL_MARGIN_BPS)`, `margin_bps`, `gross_micros`, `fee_micros` recorded (not deducted). Both write `user_id`; idempotent on `ref`.
* `billing/webhook.ts`: `creditCheckout` reads `metadata.target` (absent → personal); `preTaxShare` returns `userId`, `target`, session id; refunds and `charge.dispute.funds_withdrawn` / `charge.dispute.funds_reinstated` per §1.3.
* `pool/pool-bank.ts`: `debit({poolId, refId, requestedMicros, userId, grossMicros, note})` always inserts.
* `routes/billing.ts`: checkout passes `target`.
* `routes/admin.ts`: the credit route below.
* `packages/shared/src/billing.ts`: `createCheckoutRequestSchema` with `target` default personal; `POOL_FUND_PRESETS_CENTS = [1000, 2000, 5000]`.
* `packages/shared/src/admin.ts`: the admin credit schema.

**Routes**

* `POST /api/billing/checkout`: `{ amountCents; target? }` → `{ url }`. Pool below the pool minimum → 400.
* `POST /api/admin/credit` (adminOnly, sameOriginOnly):

  ```ts
  z.object({
    target: z.enum(['personal','pool']),
    userId: z.string().min(1).nullable(),       // required for personal
    amountCents: z.number().int().min(-50_000).max(50_000).refine(n => n !== 0),
    mode: z.enum(['adjustment','simulated_purchase']),
    idempotencyKey: z.string().min(8).max(64),
    note: z.string().max(200).optional(),
  })
  ```

  → `{ credited: boolean; amountMicros: number; balanceMicros: number }`. `adjustment` → `kind='adjustment'`, `stripe_ref='admin:<key>'`; negative on the pool goes through `PoolBank.debit`. `simulated_purchase` → `fulfilPurchase` with `ref='dev:<key>'`, only when `DEV_PURCHASES_ENABLED` (else 404). With `PERSONAL_CREDIT_ENABLED`, admin-granted personal credit is spendable before Stripe is live.

**Tests** (`pool-purchase.test.ts`, extending `billing-webhook.test.ts`)

* **Spec test (webhook idempotency):** the same signed pool event twice, plus `async_payment_succeeded` → credited once, `9_259_259 µ$` for $10 at 8%, `user_id` set.
* Old personal sessions without `target` still credit personally.
* Refund of a $10 pool purchase at 8% with funds available → debits 9_259_259.
* Refund with the pool empty → a refund row with `amount_micros = 0` exists (note records requested and shortfall); refill the pool; redeliver the event, and deliver a later partial-refund event listing the same refund → no further debit.
* Dispute `funds_withdrawn` replayed twice → one debit keyed on the dispute id; `funds_reinstated` credits back once; a lost dispute sets `pool_suspended`; personal dispute debits personal credit.
* Pricing: margin − Stripe fee ≥ 0 at every `POOL_FUND_PRESETS_CENTS` value for 2.9% + 30¢ and 4.4% + 30¢; pool checkout of 500 → 400.
* Admin credit: replay once; personal needs `userId`; `simulated_purchase` 404 when off; non-admin 404; negative pool adjustment clamped; personal admin credit spendable with `PERSONAL_CREDIT_ENABLED` and no Stripe.
* Checkout session metadata (Stripe mock).

**Docs:** README (pool pricing; admin credit for local testing instead of raw SQL, README.md:298-301; webhook and dispute events to subscribe). DECISIONS (object-id idempotency; pool margin at purchase, D3; credit-equivalent refunds; automatic disputes; pool minimum $10 so the margin covers Stripe's fee). LEGAL.md §4. DEFERRED: guest pool checkout.

### S6: UI

**Where:** Learn (meter, funding toggle, empty/cap states, first-use dialog); shared `BillingPage` (fund section); Worker-rendered landing meter and `/pool`; nothing in Canvas; admin pool page (S4/S5 routes).

**Backend for UI**

* `GET /api/pool/status` (**public**, before the session middleware, `caches.default` 60 s):

  ```ts
  { enabled: boolean; fundingOpen: boolean /* billingConfigured */; availableMicros: number; sessionsRemaining: number;
    model: { id: string; label: string };
    week: { start: string; exchanges: number; learners: number };
    marginBps: number; minPurchaseCents: number }
  ```

  Week counts: pool `reply` rows since Monday 00:00 UTC with `status='settled' AND charge_micros > 0`; learners = distinct `user_id` on those rows.
* `GET /api/pool/me` (session): `{ available; verified; supporter; caps: { requestsPerDay; spendMicrosPerDay; usedRequests; usedSpendMicros; resetAt }; suspended; personalAvailableMicros }`. **No consent fields in S6**; S8a adds `consentVersion` and `currentNoticeVersion`.

**Shared code (`packages/web-shared/src/pool/`)**

* `ApiClient`: `poolStatus`, `poolMe`, `poolVerify`, `createCheckout(amountCents, target)`. **`poolConsent` is added in S8a and `poolImpact` in S8b**, not here.
* Helpers `isPoolEmpty`, `isPoolCapReached`, `isPoolConsentRequired`, `isPoolUnavailable`.
* `pool-format.ts`: `sessionsLabel`, `poolMarginText(marginBps)`, next to `creditFeeText`.
* `PoolMeter`, `PoolFundSection` with `PoolFundController` (presets from `POOL_FUND_PRESETS_CENTS`; `'pool-funded'` notice; `changeOf` compares `availableMicros`). **When `fundingOpen` is false** the section shows the meter, the transparency link, and a disabled "Funding opens soon" button.
* `PoolBlockNotice` (empty/cap, two actions; with funding closed, both actions link to `/pool`).
* `PoolFirstUseDialog` (Turnstile via `<app-turnstile action="pool">`; S8a adds the notice).
* CSS `/* Pool */` block in `base.css`.

**Learn**

* `PaymentStore`: `'pool'` value; fallback `'credit'` if chosen and available, else `'pool'` if available, else `'own-key'`.
* `AccountStore` `poolLabel`/`poolLow`; header pool pill; `ModelAccessDialog` third option.
* `FundingToggle` (radiogroup) in `.composer-dock`, shown only when both sources are available; on the pool the `ModelToggle` is disabled with "The community pool uses <model>."
* `LessonStore.fail`/`send`: pool codes (all arrive as HTTP errors before a node exists, §1.2) set `poolBlock` (`{kind, limit, resetAt, supporter}`) and keep `unsentDraft`; no toast, no navigation. `pool_unavailable {verify}` (and in S8a `pool_consent_required`) opens `PoolFirstUseDialog`.
* Copy: empty — "The community pool is empty. It refills as people fund it." (**Fund the pool**, **Buy personal credits**); cap — "You've used today's 30 community-pool replies. The limit resets at 00:00 UTC (in 5 h). Supporters get 150 a day." (`cap_ip`/`cap_global` get "The community pool is busy today. It resets at 00:00 UTC.")

**Landing (`http/landing.ts`):** `LandingPageOptions.pool?` read in try/catch (omitted on failure); server-rendered meter, week line, **Fund the pool** link (or "Funding opens soon" text); no JS; existing copy kept plus a pool bullet.

**Transparency page `/pool`** (`http/pool-page.ts`, `page()` + `LEGAL_STYLE`, `public, max-age=300`, in `run_worker_first`, linked from footers and the fund section): how the pool works; funding is a credit purchase with a disclosed margin and a $10 minimum; the model; caps, the global ceiling and why; the supporter tier (12 months); never-negative and empty state; that the last ~1.4¢ of a daily cap can't start a reply; how topics are aggregated (S8b adds the live section).

**Copy rule:** never "donate", "donation" or "tax-deductible" (test below).

**Tests**

* **Spec test (empty/cap UI states):** `lesson-store.spec.ts` with `ApiError(402,'pool_empty')` and `(429,'pool_cap_reached', {pool:{…}})` → `poolBlock()` kind/limit/reset, `unsentDraft` kept, no navigation, no toast. `pool-block-notice.spec.ts` template strings.
* `payment-store.spec.ts`: three-way fallback and `stored()` round trip of `'pool'`.
* `funding-toggle.spec.ts`; `pool-fund-controller.spec.ts` (target, presets ≥ $10, `pool-funded` ending); `pool-fund-section.spec.ts`: **funding closed** → disabled "Funding opens soon", meter and link shown.
* Worker `pool-pages.test.ts`: landing meter and DB failure; `/pool` CSP hash; `/api/pool/status` public, cached, no user ids; week counts exclude settled-at-0 and released rows.
* `copy.test.ts` / `copy.spec.ts`: `/donat|tax[- ]?deductible/i` never matches.
* Demo backend stubs for `/api/pool/status` and `/api/pool/me`.
* Re-run S2–S5 pool tests.

**Docs:** README; DEFERRED (pool spending is Learn-only); LEGAL.md §4 copy rules; `legal.ts` Terms §7; bump `LEGAL_UPDATED`.

### S7: `ANNUAL_FEE_ENABLED`

**Files:** `billing/membership.ts` (`membershipRequired = flags.annualFeeEnabled && billingConfigured(env) && membershipPriceId(env) !== null`); `wrangler.jsonc` `"false"`; `vitest.config.ts` `"false"` (existing membership tests that set `STRIPE_MEMBERSHIP_PRICE_ID` also set `ANNUAL_FEE_ENABLED: 'true'`); `.dev.vars.example`. Nothing is deleted (`assertMember`, waiver, `MembershipGate`, plugin plan, `creditMembershipInvoice` stay). `MembershipInfo.required=false` hides every UI gate.

**Routes:** none new.

**Tests:** flag off with the price id set → pool sends (via `poolReadyUser`) and personal checkout work without membership, `membership.required=false`; flag on → 402 `membership_required` on send, review, `context?resolve`, including pool sends; `invoice.paid` still credits with the flag off.

**Docs:** README "Membership"; DECISIONS; DEFERRED `## Membership`; LEGAL.md §4.

### S8a: consent notice, versioning, taxonomy, request-time tagging

**Files**

* `packages/shared/src/pool.ts`: `POOL_NOTICE_VERSION = 1`, `POOL_NOTICE_TEXT`; `poolConsentRequestSchema`; `PoolConsentResponse`; `PoolMeResponse += consentVersion: number | null; currentNoticeVersion: number`.
* Migration `0012_pool_consent_tags`, `schema.ts`.
* `pool/consent.ts`: `hasCurrentConsent`, `recordConsent`. The required version travels in `PoolParams.noticeVersion` (Worker-resolved; tests override it via `authEnv`).
* `billing/gate.ts`: consent check (gate step 5) → 403 `pool_consent_required {currentVersion}`.
* `pool/taxonomy.ts`: `Topic { id; label; parent; sensitive? }`; curated tree; `sensitiveRoots` (health, mental-health, sexuality, legal, personal-finance, religious-doubt), inherited by children. **Rule: the classifier may output only leaf ids** (`LEAF_TOPIC_IDS`); aggregation is per leaf, with **no roll-up** to parents, so a parent is never named because of its children. `isValidLeafTopicId`, `isSensitive`.
* `pool/tagging.ts`: `classifyPoolExchange(env, account, {branchId, poolExchangeUserMessage, defer})`.
  * The input is **the user message of the pool exchange that just completed** (the `BeginSendResult.userNode` of a run whose usage row has `funding='pool'`), never earlier branch content.
  * Pool-funded registry, `purpose:'tagging'`, `maxOutputTokens = impact.classifierMaxOutputTokens`, input truncated to `impact.classifierInputChars`; the message lives only in the request.
  * `isValidLeafTopicId(output.trim())` or reject (nothing stored, counter logged).
  * Stored `topic_id` = the leaf id, or `'sensitive'` if `isSensitive`. `branch_depth = chain.length − 1`. `INSERT … ON CONFLICT(branch_id) DO NOTHING`.
* `do/tree-session.ts`: in `pump()` (which has the `AccountContext` from S3) after a **complete** pool reply, if the branch has no tag, `ctx.waitUntil(classifyPoolExchange(…, started.userNode.content))`.
* `routes/pool.ts`: the consent route. `packages/web-shared`: `ApiClient.poolConsent`.
* UI: `PoolFirstUseDialog` shows the notice, a checkbox and Turnstile if unverified; on acknowledge, posts consent and retries from `unsentDraft`.
* `auth/delete-account.ts`: deletions per §2.
* Update `poolReadyUser` (inserts a consent row).

**Routes:** `POST /api/pool/consent` (sameOriginOnly): `{ version }`; a non-current version → 409 `conflict`; → `PoolConsentResponse`.

**Tests** (`pool-impact-tagging.test.ts`)

* **Spec test (consent):** before consent → 403; after v1 → succeeds; with `noticeVersion` 2 via `authEnv` → blocked until v2; row stores user, time, version.
* **Spec test (non-pool never tagged):** personal and own-key sends → no tag rows, no tagging usage rows.
* **Mixed branch:** a personal message containing marker A, then a pool message on the same branch → the recorded classifier request never contains A; the tag reflects the pool message.
* **Spec test (no query text stored):** exact column set; marker scan of every text column in `pool_topic_tags`, `pool_consents`, `usage_events`; console capture.
* Sensitive classification stored as `'sensitive'`, never the specific id.
* **Spec test (invalid classifier output rejected):** `"Roman history"`, `"history.ancient-rome extra"`, an unknown id, and a non-leaf parent id → no row.
* Valid leaf stored with the correct depth; tagging cost is a pool row excluded from caps and rate; empty pool → skipped without error.
* `isSensitive` inheritance; leaf-only validation.
* Re-run S2–S7 pool tests with the updated helper.

**Docs:** DECISIONS (tagging charged to the pool; classifier sees only the pool exchange; leaf-only, no roll-up; sensitive sentinel; no text). LEGAL.md §1/§7 and `legal.ts` privacy table: consent records (kept until account deletion) and topic tags (no user id; deleted 14 days after the branch's last pool use or on account deletion); bump `LEGAL_UPDATED`. PLAN.md §15.

### S8b: weekly aggregation, thresholds, snapshots, review queue, blocklist, public feed, featured flag

**Files**

* Migration `0013_pool_impact`, `schema.ts`.
* `wrangler.jsonc`: `triggers.crons: ["*/10 * * * *", "17 4 * * 1"]`.
* `index.ts`: `scheduled` dispatches on `controller.cron` (`*/10` → reconcile + pool expiry + checkpoint; weekly → `aggregatePoolImpact`; unknown → logged).
* `pool/impact.ts`: `aggregatePoolImpact(env, now, poolId)` for the ISO week just ended, idempotent (skips if a snapshot exists). Base set: `usage_events u WHERE u.account_id = :poolId AND u.funding = 'pool' AND u.purpose = 'reply' AND u.status = 'settled' AND u.charge_micros > 0` in the week.
  * `exchanges`, `learners` (distinct `u.user_id`) from the base set.
  * Per topic: base set `JOIN pool_topic_tags t ON t.branch_id = u.branch_id` (no `nodes` join, so deleted trees still count), grouped by `t.topic_id` → learners, exchanges, `avg_depth_milli`, `max_depth`.
  * `topics` = distinct topic ids touched (the `'sensitive'` sentinel counts as one).
  * `deepest_topic_id` = the published topic with the greatest average depth.
  * Named iff `learners ≥ minDistinctUsers` (floor 3), not sensitive (the sentinel never is named), not blocklisted, review `approved`. A qualifying topic with no review row → insert `pending`. Rejected → never published.
  * One `env.DB.batch`, chunked under the bound-parameter limit. Then the tag retention delete (§2).
* `routes/admin.ts` review routes; admin `pool-page.ts` (balance and top-up, outliers and IP-key report, breaker state, review queue) and a `poolSuspended` column in `users-page.ts`.
* `routes/pool.ts`: public impact routes before the session middleware. `ApiClient.poolImpact`, `poolImpactWeeks`.
* UI: `ImpactFeed` in `PoolFundSection`; server-rendered impact block on landing and `/pool`. **`/pool` has a week selector**: a server-rendered list of past weeks (from the weeks route data, newest first, max 52) linking to `/pool?week=YYYY-MM-DD`; an unknown week renders "No snapshot for that week".
* **Featured conversations: stub.** `featuredEnabled(env) = flags.featuredConversationsEnabled && sharingEnabled(env)`; `routes/featured.ts` at `/api/featured` answers 404 `not_found` to everything, flag on or off; `MeResponse.featuredConversations` always false; no tables, columns or UI. Rationale: user-published content is blocked on DMCA registration, and share links already provide explicit, revocable opt-in; a future wall would flag `shares` rows. DEFERRED entry with the sketch.

**Routes**

* `GET /api/pool/impact?week=YYYY-MM-DD` (public; latest when omitted) → `{ weekStart; exchanges; learners; topics; avgDepth; maxDepth; deepest: {id,label,avgDepth}|null; named: {id,label,learners,exchanges,avgDepth}[] }`; 404 if none.
* `GET /api/pool/impact/weeks` (public) → `{ weeks: string[] }`.
* `GET /api/admin/pool/topics?status=…`, `POST /api/admin/pool/topics/:topicId` `{ decision }`.
* `/api/featured/*`: always 404.

**Tests** (`pool-impact-aggregate.test.ts`, `pool-featured.test.ts`, admin and web-shared specs)

* **Spec test (threshold):** 4 distinct users (one user many times doesn't count) → not named, counted in totals; 5 after approval → named. A parent whose children each have < threshold users is not named (no roll-up).
* **Spec test (sensitive):** 50 users on sensitive leaves → never named, queued or `deepest`; counted in totals.
* **Spec test (review queue):** pending → not published; approved → published next week; rejected never; blocklist never queued.
* Only pool replies count: a mixed branch's personal exchanges are excluded from per-topic exchanges; settled-at-0 and released replies are excluded everywhere.
* A tree deleted mid-week still counts in its topic.
* Tag retention: tags with no pool use in 14 days are deleted after the run.
* Re-run is a no-op; past weeks browsable via `?week=`; `/pool` week selector renders links and the unknown-week message; responses carry no user or tree ids.
* Cron dispatch separation.
* **Spec test (featured off):** all methods on `/api/featured`, `/api/featured/x`, `/api/featured/conversations/x/publish` → 404 with the flag false and true; `featuredConversations === false`; template specs show no entry point; no `%featured%` table.
* Landing and `/pool` render the impact block and omit it without a snapshot.

**Docs:** DECISIONS (aggregation rules, leaf-only, reply-only base set, review queue, blocklist, featured stub). DEFERRED (featured wall + DMCA, PoolBank sharding, margin unification, guest checkout). LEGAL.md §8 and §1. README (weekly cron, review queue). PLAN.md §15 completed.

---

## 7. Spec Testing section → stage and test file

| Spec test | Stage | File |
|---|---|---|
| Concurrency: never negative; all reservations settled or released | S2 | `apps/worker/test/pool-bank.test.ts` |
| Webhook idempotency (replay the same event) | S5 | `apps/worker/test/pool-purchase.test.ts` (plus `billing-webhook.test.ts`) |
| Reservation expiry releases funds | S2 | `pool-bank.test.ts` (`PoolBank.expire(now)`, alarm re-arm, cron backstop) |
| Pool ignores client model / system-prompt overrides | S3 | `pool-routing.test.ts`, `packages/core/test/services/pinned-model.test.ts` |
| Caps, rate limits, supporter escalation | S4 (unit half in S2) | `pool-abuse.test.ts`, `pool-bank.test.ts`, `supporter.test.ts` |
| Empty-pool and cap-reached UI states | S6 | `apps/simple/src/app/state/lesson-store.spec.ts`, `packages/web-shared/src/pool/pool-block-notice.spec.ts` |
| Topics below threshold never named | S8b | `pool-impact-aggregate.test.ts` |
| Sensitive topics never named | S8b | `pool-impact-aggregate.test.ts` |
| Non-pool conversations never tagged | S8a | `pool-impact-tagging.test.ts` |
| No query text stored by tagging | S8a | `pool-impact-tagging.test.ts` |
| Invalid classifier output rejected | S8a | `pool-impact-tagging.test.ts` |
| New topics stay in review until approved | S8b | `pool-impact-aggregate.test.ts` |
| Pool request blocked until current notice acknowledged | S8a | `pool-impact-tagging.test.ts` |
| `FEATURED_CONVERSATIONS_ENABLED=false` → 404 and no UI | S8b | `pool-featured.test.ts` plus template specs |

Every stage runs `pnpm -r typecheck` and `cd apps/worker && pnpm test`, plus the package's own vitest for frontend stages. After any migration, `pnpm db:generate` must report "No schema changes".

## 8. Copy rules

* Say "fund the pool", "add credits to the community pool", or "credit purchase".
* Never "donate", "donation", "donor", "contribution is tax-deductible" or "charity" (test, S6).
* The margin disclosure is `poolMarginText(marginBps)`: "8% covers card processing, hosting and keeps Tangent running." Processing is named because the margin pays Stripe's fee.
* Prices are pre-tax and say "plus tax".

## 9. Open questions, assumptions and spec deviations

**Spec deviations that need owner sign-off** (each implemented as described unless the owner objects; each is reversible):

* **D1 (spec 1):** `settlement` and `refund_of_reservation` are a row transition with `settle_reason`, not separate append-only rows. Same model as the personal ledger.
* **D2 (spec 2.4):** after dispatch, a failed or timed-out call is charged (reported cost, tokens × price, else the full hold), and the 1 h give-up charges the hold. The spec's "release in full" would make the operator pay for upstream work. The spec-literal alternative is a one-line policy change in `settle-policy.ts` with the absorbed cost logged.
* **D3 (spec 3):** margin at purchase applies to the pool only; personal credit keeps `MARKUP_BPS` at usage time (Terms §7, existing balances). DEFERRED entry: "Unify personal pricing to margin-at-purchase: reprice rule for existing balances, Terms §7 update, migrate `MARKUP_BPS` to 0 behind a flag."
* **D4 (spec 5):** Turnstile at first pool use (plus one pool identity per normalised mailbox) instead of at signup and first login. Rationale: it gates exactly the commons and covers OAuth accounts without adding friction to non-pool users. Spec-literal alternative, ready to build if the owner prefers: a post-OAuth interstitial on first login that runs Turnstile and sets `pool_verified_at`, shared with the pool gate.
* **D5:** supporter caps apply for 12 months after the last purchase (spec: "lifetime purchase above $0"), so one $5 purchase cannot buy a lifetime of 5× free caps.

**Owner/orchestrator resolution of D1–D5 (binding for implementation):**

* D1: accepted (matches the existing personal ledger; documented in DECISIONS).
* D2: accepted (spec property 1 — the owner's worst case stays fixed — outranks spec 2.4; a call never dispatched upstream is still released in full).
* D3: accepted.
* D4: **overridden — do both.** Turnstile runs on signup and on first login (including the post-OAuth first login, via the interstitial described above, setting `pool_verified_at`), as the spec requires. Keep the first-pool-use check as a fallback for accounts that predate this change and the one-identity-per-mailbox rule.
* D5: **overridden.** Supporter = lifetime net purchases > 0, per the spec. Keep the window as a config value `SUPPORTER_WINDOW_MONTHS`, default `null` (= lifetime). Assumption 5 is amended accordingly.

**Assumptions**

1. Pool model prices in §4 are placeholders, confirmed by the operator before enabling. `provider.max_price` keeps OpenRouter from routing above them.
2. Pool model = `simpleFastModel(env, simpleProviderConfig(env))` unless `POOL_MODEL` is set. With Workers AI, settlement falls back to tokens × price and `feeBps` comes from the price entry.
3. Margin 8%; pool purchase minimum $10, where the margin covers Stripe's fee at 2.9% + 30¢ and 4.4% + 30¢. Stripe keeps its fee and charges $15 per dispute; these are per-purchase costs, not AI spend, and are logged.
4. Caps: free 30 replies / $0.10 per UTC day; supporter 150 / $0.50; per-IP 60 requests / $0.30 per day and 20 per minute; per-user 6 per minute; global free-tier ceiling min($5, 20% of the 00:00 UTC balance) per day.
5. Supporter = Σ gross purchases − Σ gross refunds and disputes > 0, last purchase within 12 months. Simulated dev purchases count; admin adjustments don't.
6. Pool sends require a real signed-in user.
7. Personal → pool auto-fallback only for sends and `context?resolve`, when personal available < one hold; still subject to verification and consent.
8. Reviews are not available on the pool. Summaries and titles are, reserved separately; a refused summary truncates, a refused title is skipped.
9. Guest pool checkout is not offered.
10. TTL 10 min, give-up 1 h, call timeout 120 s, enforced by config clamps.
11. Weekly window is the ISO week; job Monday 04:17 UTC; snapshots immutable.
12. "Learning sessions remaining" = available ÷ $0.02, labelled "about".
13. One global `PoolBank`; sharding deferred.
14. Account deletion deletes consents and the user's topic tags; ledger rows are kept for accounting (with `ip_key`, which rotates daily); published aggregates are kept.
15. A prompt larger than the model's context window is rejected upstream without charge (basis of `ceilingHold`).

## 10. Risks

* **Global serialisation.** Every reply reserve passes through one `PoolBank` with about two D1 round trips. The checkpoint keeps it O(recent rows). Sharding is the DEFERRED escape hatch.
* **Shared test D1.** Pool tests isolate by unique `POOL_ACCOUNT_ID` per test (Worker-resolved, §3); a test that forgets this gets order-dependent balances. `poolReadyUser` always generates one.
* **Price drift.** Mitigated by `max_price` routing and the overage breaker; the cost is a breaker trip (pool refuses), not unbounded loss.
* **Ceiling hold** blocks the last ~1.4¢ of a user's daily spend cap, and with a much larger context window could block more; documented. `contextTokens` in the price entry is the most a pool request may send: a request whose byte bound exceeds it is refused, not clamped, so lowering it lowers the ceiling hold without under-holding any call (keep it above 3.5 × `POOL_MAX_INPUT_TOKENS` plus framing, about 57 000 at the defaults, or the longest replies are refused).

## 11. Critique responses

Points adopted with a change from the proposed fix, or not adopted:

* **Stream-level pool error codes (`StreamEvent.code`).** Not needed: the reply is reserved before `beginSend` (the critics' option (a)), so every reply refusal is an HTTP 402/429 before any node exists. Summary, title and tagging refusals have defined fallbacks and never fail the send. The "empty between precheck and reserve" test is kept, as "reserve refused after the gate" in S3. The route-side precheck is dropped as redundant.
* **Minimum account age before first pool use.** Implemented as config (`POOL_MIN_ACCOUNT_AGE_MS`) but **default 0**. Farms pre-age accounts, so it adds friction for real learners without bounding drain; the global free ceiling, per-IP daily caps and one identity per mailbox are the actual bounds.
* **Supporter: "cap extra spend at k × lifetime purchases" vs "12 months".** Chose 12 months (simpler, explainable on `/pool`); flagged as D5.
* **Stripe fee: deduct the fee vs a $10 minimum.** Chose the $10 minimum to keep the spec's `gross/(1+margin)` formula exact; the disclosure still names card processing.
* **Pool-only clamp of tag rows on retention (null `user_id` after snapshot).** Went further: tag rows never store `user_id` or `tree_id` at all, since per-topic learners come from `usage_events`; sensitive topics are stored as a sentinel; rows expire 14 days after last pool use.
* **Per-IP and per-user rate limits.** Moved into `PoolBank` storage rather than a new binding, which also fixes the shared `CHAT_RATE_LIMITER` bucket, the per-test config problem and the config-module rule in one change.
* **Reference corrections.** `sendLock` is `tree-session.ts:88,136-137`; bounded overdraft is DECISIONS.md:155 and :222; cost-from-`usage.cost` is :148; grants idempotency is :162; refunds and disputes are :163.
