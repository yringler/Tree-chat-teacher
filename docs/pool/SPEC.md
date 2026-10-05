# Feature: Community Credit Pool for Tangent

> **Current framing (2026-10-05): the pool is revenue-funded.** Nobody can buy credit for the pool. It is free credit Tangent provides, an operator expense like a free tier: Tangent puts `POOL_REVENUE_SHARE_BPS` (default 20%) of what it earns into it, 20% of each membership payment after payment fees and 20% of the markup on personal credit as it is used, and the operator may add more. Pool replies are charged at their true cost, with no markup. The spec below is the original design and is kept as history: wherever it describes funding or buying credit for the pool, a pool purchase target, a margin or markup on pool use, or "visibility drives funding", read the decision in docs/DECISIONS.md ("Revenue-funded community pool") and docs/polar-migration/05-pool-framing.md instead. The ledger, bank, caps, abuse defences, meter and impact feed still hold.

## Context

Tangent (tangentailearning.com) is a branching LLM learning chat on Cloudflare Workers. Auth is magic link, passkeys, and social login. Billing is planned with Stripe, but the Stripe account is not live yet.

The current planned model:
- **Pro tier:** bring-your-own-key, more configuration.
- **Simple tier:** $10/year access fee, plus personal credits for hosted AI calls.

This feature adds a **public, community-funded credit pool**. Anyone can put money into it, and any signed-in user can learn from it on the economical default model. The goal is to position Tangent as an open learning resource rather than just a paywalled app.

**Before writing code:** read the existing auth, billing, credits, and model-routing code. Then propose an implementation plan that fits what already exists. Do not duplicate existing abstractions.

## Reasoning behind the design (keep these properties)

1. **The pool can never go negative.** Pool spend is strictly limited by pool funds, so the owner's worst case is fixed infrastructure cost (~$5/month Workers plan). Every design decision must preserve this.
2. **The pool is a commons, and commons fail from a few heavy users or scripts draining them.** The main threat is someone using the Tangent endpoint as a free general-purpose LLM proxy. The defense is to make pool usage good for learning but poor for general use: caps, default model only, a locked system prompt, and limited output and context.
3. **This is not a nonprofit or a donation.** The business is an LLC, and pool funding is a *credit purchase* where the buyer chooses the destination (personal or pool). A disclosed markup applies (originally a margin at purchase; see §3). UI copy must say "fund the pool" or "add credits to the community pool," never "donate" or "tax-deductible." (Superseded 2026-10-05: nobody buys pool credit; the pool is funded from Tangent's revenue. See docs/polar-migration D1 and 05.)
4. **An empty pool is the normal state, not an error.** Design the empty state as a first-class UX with a clear call to action.
5. **Visibility drives funding.** A public pool meter and impact stats are the main reasons people contribute.

## Requirements

### 1. Credit ledger
- Use an **append-only ledger** as the source of truth for both personal balances and the pool. Treat the pool as a special account (for example, `account_id = "pool"`).
- Entry types: `purchase`, `reservation`, `settlement`, `refund_of_reservation`, `admin_adjustment`.
- Store amounts as integer micro-units (for example, millicents). No floats.
- Balances are derived from the ledger, or cached with the ledger as authority.

### 2. Atomic spend: reserve, call, settle
- Serialize pool debits through a **Durable Object** (for example, `PoolBank`) so concurrent requests cannot overdraw the pool. If the existing code already handles atomic personal-balance debits, reuse that pattern.
- Flow:
  1. Before the model call, **reserve** the worst-case cost (prompt token estimate plus `max_output_tokens` at the model's price).
  2. If the reservation fails, reject the request with a pool-empty or cap-reached response. Do not call the model.
  3. After the call, **settle** using actual usage from the provider response and release the unused reservation.
  4. If the call fails or times out, release the full reservation.
- Expire stale reservations after a timeout so a crashed request cannot lock funds forever.

### 3. Pricing config
- A per-model price table (input and output price per million tokens) in config, not hardcoded in handlers.
- ~~A configurable `MARGIN_PERCENT` (start around 8%), applied at purchase time ($10 yields $10 / (1 + margin)), with usage charged at raw cost.~~ **Changed (owner decision, 2026-10):** a pool purchase adds what was paid minus the card processing fee, like a personal top-up, and each pool reply costs the AI provider's price plus a per-call markup (`POOL_MARKUP_BPS`, default 5%). See docs/DECISIONS.md, "Pool pricing aligned with personal credit".
- The provider is still undecided (OpenRouter vs. Cloudflare Workers AI). Keep the model and price table provider-agnostic.

### 4. Funding source selection
- Per request, the funding source is:
  - **Personal credits** if the user has a balance and hasn't toggled to the pool.
  - Otherwise, **the pool**.
- Pool-funded requests:
  - Are **forced to the default economical model**. Ignore any client-supplied model.
  - Use the **locked learning-oriented system prompt**. No user-editable system prompt.
  - Enforce a hard `max_output_tokens` and a max context length. Truncate or summarize older branch context if needed, reusing existing context-management code.
- Personal-credit requests keep the existing model choice and config.

### 5. Abuse controls (pool only)
- Per-user daily pool caps on requests and spend. Values go in config.
- Per-IP rate limiting with Cloudflare rate limiting or a Durable Object counter.
- **Member tier:** a user with a paid or waived membership gets higher pool caps; everyone else is on the free tier (docs/DECISIONS.md, "Two tiers: free and member"). This brings back the anti-farming effect of a paid gate without a paywall.
- Cloudflare **Turnstile** on signup and first login.
- Pool usage requires an authenticated session. No anonymous pool access.
- Do not expose an OpenAI-compatible endpoint shape. Pool calls must only work through the app's own request format.
- Log per-user pool consumption so outliers are easy to spot. Add a simple admin flag to suspend pool access for a user.

### 6. Purchases (Stripe, built ahead of go-live)
- Use Stripe Checkout with metadata `target: "personal" | "pool"` and `user_id` (nullable for pool purchases if guest checkout is allowed).
- Webhook handler: verify the signature, then make crediting **idempotent on the Stripe event ID**.
- Since Stripe isn't live yet:
  - Put purchases behind an interface.
  - Provide a dev/admin-only manual top-up endpoint for both personal accounts and the pool, so the full flow can be tested end to end.

### 7. Annual fee
- Put the $10/year simple-tier fee behind a feature flag `ANNUAL_FEE_ENABLED`, **defaulting to false**.
- With the flag off:
  - Any signed-in user can use the pool (with caps).
  - Any signed-in user can buy personal credits.
- Do not delete the existing annual-fee code paths. Gate them.

### 8. UI
- **Public pool meter**, on the landing page and in-app:
  - Current balance, shown as approximate "learning sessions remaining" rather than raw dollars, plus the dollar figure.
  - "Learners helped this week" and "exchanges funded this week." These are aggregate counts only, with no user data.
- **Fund the pool:** a flow with preset amounts and a one-line fee disclosure, for example: "8% covers hosting and keeps Tangent running."
- **Empty-pool state:** "The community pool is empty. It refills as people fund it." Include two actions: **Fund the pool** and **Buy personal credits**. Show this state inline in the chat, not as a generic error.
- **Cap-reached state:** state the cap and when it resets, and mention that members get higher limits.
- **Funding toggle:** in the chat composer, let users choose personal credits or the pool when both are available.
- **Transparency page:** explain how the pool works, what the margin covers, which model pool users get, why caps exist, and how pool topics are aggregated for the impact feed (section 9).

### 9. "What the pool is funding": public learning impact feed

**Why:** Contributors give more readily when they can see what their money funds. The feed shows *what people are learning* with pool credits, but strictly at the **topic level**.

**Why topic-level only:** Learning queries are often personal (health, legal situations, religious questions, sexuality, finances). Removing names does not make free text anonymous, because specific details alone can identify a person. Showing raw queries publicly would also discourage people from asking sensitive questions. So:

- **Never store or display query text** for this feature. Store only derived topic tags.
- **Never** apply this feature to personal-credit or BYOK conversations. Pool conversations only.

**Consent:**
- When a user first switches to pool funding, show a clear, plain-language notice: "Pool conversations contribute anonymously to aggregate topic stats shown publicly (e.g., 'Roman history: 40 learners this week'). Your questions are never shown." The user must acknowledge it before their first pool request.
- Record the acknowledgment (user ID, timestamp, notice version). If the notice text changes, bump the version and require a new acknowledgment.

**Tagging (at request time, not in the batch):**
- When a pool conversation (or branch) is created or reaches its first exchange, call the cheap default model to classify it into a **fixed topic taxonomy**. Store `{conversation_id, user_id, topic_id, branch_depth, created_at}`.
- Classification output must be a topic ID from the taxonomy. Reject free-text output.
- Tagging at request time means the weekly job never needs raw conversation text.
- Charge tagging cost to the pool and include it in the reserve/settle flow, or absorb it from the margin. Make this choice explicit in the plan.

**Taxonomy:**
- A curated, hierarchical list of learning topics (for example, `history > ancient rome`, `science > organic chemistry`, `jewish learning > talmud`) in config. Easy to extend.
- Some categories are flagged **sensitive** and are counted in totals but **never named publicly**: health, mental health, sexuality, legal issues, personal finances, religious doubt or crisis.

**Weekly aggregation (Cron Trigger):**
- A Workers Cron Trigger runs weekly and aggregates the past week's tags into a public snapshot:
  - total pool exchanges funded
  - distinct learners
  - distinct topics
  - topic list with learner counts
  - average and max branch depth
  - "deepest rabbit hole" (the non-sensitive topic with the greatest average branch depth)
- **Minimum crowd size:** only name a topic publicly if at least `IMPACT_MIN_DISTINCT_USERS` distinct users (default 5) touched it that week. Below that threshold it only counts toward totals.
- Store snapshots so past weeks can be browsed.

**Moderation:**
- The first time any topic would appear publicly, put it in an **admin review queue** instead of publishing it. Once approved, it publishes automatically in future weeks.
- Keep a topic blocklist in config. Together with the review queue, this stops a coordinated group of accounts from forcing a crude or spam topic onto the public page.

**UI:**
- Show the impact feed on the fund-the-pool page and the landing page, next to the pool meter. For example: "This week the pool funded 1,240 exchanges across 87 topics," followed by a topic list or cloud and the branch-depth stats. Branch depth is Tangent's distinctive angle, so feature it.

**Verbatim showcase: build behind a flag, OFF.**
- A "featured learning" wall where users may **opt in per conversation** to publish a specific conversation is a possible future feature.
- It must sit behind `FEATURED_CONVERSATIONS_ENABLED`, **default false**, because user-published content is held back until DMCA safe-harbor setup (designated agent registration, takedown process) is in place.
- With the flag off:
  - no UI entry points render
  - no publish endpoints are reachable (return 404)
  - no data is collected for it
- If implemented now, keep it minimal. Opt-in must be per conversation, explicit, and revocable, and must never be the default.

## Testing
- Concurrency: fire many simultaneous pool requests against a small balance and assert the pool never goes negative and every reservation is settled or released.
- Webhook idempotency: replaying the same Stripe event credits only once.
- Reservation expiry releases funds.
- Pool requests ignore client-supplied model and system-prompt overrides.
- Caps, rate limits, and member-tier cap escalation.
- Empty-pool and cap-reached responses render the correct UI states.
- Impact feed:
  - Topics below the distinct-user threshold are never named.
  - Sensitive topics are never named.
  - Non-pool conversations are never tagged.
  - No query text is stored by the tagging path.
  - Classifier output that isn't a valid topic ID is rejected.
  - New topics stay in the review queue until approved.
  - A pool request is blocked until the current notice version is acknowledged.
  - With `FEATURED_CONVERSATIONS_ENABLED=false`, all featured endpoints return 404 and no UI renders.

## Deliverable order
1. Plan (after reading the existing code), including any schema migrations.
2. Ledger, PoolBank Durable Object, and reserve/settle flow, with tests.
3. Funding-source routing and pool restrictions.
4. Abuse controls.
5. Purchase interface, dev top-up, and Stripe webhook.
6. UI: meter, fund flow, empty and cap states, toggle, transparency page.
7. Feature flag for the annual fee.
8. Impact feed:
   - pool consent notice and acknowledgment
   - topic taxonomy and request-time tagging
   - weekly cron aggregation with thresholds
   - review queue
   - public feed UI
   - `FEATURED_CONVERSATIONS_ENABLED` flag, off by default

Keep all caps, prices, margin, and limits in one config module so they can be tuned without code changes.
