# Deferred work

Known gaps and follow-ups that were consciously left out of a change. Each entry says where the gap is, why it matters, and roughly what fixing it takes. Remove entries as they are done.

## Membership

Left out of the server side of the membership (`apps/worker/src/billing/membership.ts`). None blocks charging for it.

- **Turning the annual fee off doesn't touch existing subscriptions.** With `ANNUAL_FEE_ENABLED` off nothing requires the membership and the billing page hides it, but Polar keeps renewing subscriptions bought while it was on (each renewal still grants its included credit), and their holders can only cancel through Polar's billing portal (Polar's own emails link to it). Cancelling them in bulk, or keeping a "Manage billing" link for subscribers while the fee is off, is not done.

- **No email when a membership lapses or a renewal fails.** Polar's own customer emails (receipts, failed payments, renewals) cover it; the app only shows the status on the billing page. Sending our own needs a reaction to `membership.changed` in `billing/payments/apply.ts` and a template in `src/email/`.
- **No admin UI for waivers.** Setting, clearing and listing `auth_users.membership_waived` is the SQL in the README ("Waiving the membership"). The admin page (`/admin/`, ADMIN_USER_IDS) manages only the share allowlist and takedowns so far; waivers could join it.
- **One waiver code, not per-person codes.** A leaked code is changed for everyone; whoever redeemed it keeps the flag until it is cleared by hand. Per-person or single-use codes need a codes table.
- **The included credit isn't prorated or clawed back on cancellation.** It is granted per paid membership order and taken back only when that order is refunded.

## Community credit pool

Left out of the pool (`docs/pool/PLAN.md`). None blocks launching it.

- **Disputes of membership invoices are handled by hand.** Only personal credit purchases and legacy pool purchases are debited automatically.
- **Spending from the pool is Learn-only.** The power app and Canvas never use it (power mode ignores the `pool` payment header); the power app only shows the pool meter on its billing page. Offering it there would need the pool's model pin and locked prompt to coexist with power mode's per-tree prompts and model pickers.
- **The first-use human check leaves the app.** The apps' CSP doesn't load Turnstile, so `PoolFirstUseDialog` sends the learner to the Worker's `/verify` page and back; the unsent message isn't kept across that page load. Allowing `challenges.cloudflare.com` in the Learn app's CSP would let `<app-turnstile>` and `POST /api/pool/verify` run in place.
- **No admin UI for personal credit.** The admin page's pool panel tops up and corrects the pool; crediting a user's personal ledger (`POST /api/admin/credit` with target `personal`) still needs the API.
- **Featured conversations are a stub.** `FEATURED_CONVERSATIONS_ENABLED` (off) exists, `featuredEnabled(env)` also needs `DMCA_AGENT_REGISTERED`, and `/api/featured/*` answers 404 whatever the flags say; `MeResponse.featuredConversations` is always `false`; there are no tables, columns or UI. User-published content waits for the DMCA designated agent (docs/LEGAL.md §8), and share links already give explicit, revocable, per-conversation opt-in. A wall would: add `shares.featured_at` (set only by an explicit "Feature this conversation" action on an existing share, never by default, cleared by un-featuring or revoking the share), a moderated queue like the topic review queue, `GET /api/featured` listing approved, unrevoked shares of users who may share, and the routes and UI only while `featuredEnabled` is true.
- **One global `PoolBank`.** Every pool reservation passes through one Durable Object (about two D1 round trips each). If it becomes a bottleneck, shard by user-id hash into N banks, each holding a slice of the balance that a coordinator rebalances, keeping never-negative per shard.
- **The impact feed's review queue has no notification.** A topic waiting for review shows only on the admin page; an email or a count in the admin header would make it harder to miss. Snapshots are written once and never rewritten, so a topic approved late appears from the next week on.

## Grounding (web search)

Left out of the first cut of grounding (DECISIONS "Grounding").

- **Not checked against a live OpenRouter key.** The request and stream shapes and the cost reporting come from OpenRouter's docs, not a real call (RESEARCH "Web search", "Not yet verified"). Before setting `GROUNDING=auto` in production, run one grounded and one aborted reply on a key with a low credit limit and compare `usage_events` with OpenRouter's activity page.
- **Native search on direct providers.** Anthropic's `web_search` tool (about $10 per 1,000 searches) and OpenAI's Responses API search are not wired up; those providers report `supportsWebSearch: false`.
- **No confidence trailer.** The model could flag low confidence at the end of an unsearched reply, to trigger a grounded follow-up only then. Not built, because it pays for the reply twice. Check sources covers the after-the-fact case at the learner's choice. Revisit with data on how often the gate's offer is used.
- **Reviews don't search.** A review with sources would need the tool on the reviewer call and somewhere to show its citations.
- **Canvas shows no sources and has no Check sources button.** The cards render the reply text, so inline citation links do show.
- **The branch dialog (new branch) has no grounding select.** New branches inherit the parent's setting; branch settings change it afterwards.
- **No `openrouter:web_fetch` for URLs the learner pastes.** It would let the tutor read one page for about $0.001 a fetch.
- **No web search on the community pool.** Its holds are priced from tokens alone (`worstCaseHoldMicros`), so a search fee would be overage. Allowing it means adding the per-search fee to the worst case when the request carries `webSearch`, and to the reply's ceiling reservation in `TreeSession.send`.
- **The daily cap counts settled rows only.** Replies still in flight are not counted, so a burst of parallel sends can pass the cap by up to `USAGE_MAX_PENDING`.

## Power app and Canvas: membership and credit UI

Left out of the front end of the unified billing (`apps/web`, `apps/canvas`). None blocks charging.

- **Canvas has no membership gate.** A blocked user (from `me` or a 402 `membership_required`) gets a banner linking to the power app's `/billing`, not the shared `MembershipGate` panel; Canvas has no billing page of its own. Rendering the gate there needs `/canvas/billing` (or a return path into `/billing` that comes back to Canvas).
- **A malformed model id is not blocked before sending.** For `openModels` providers the model picker shows an inline hint, but the dialogs still submit; the server answers 400 and the error is a toast. Disabling Save needs the picker to expose its validity to each of the five dialogs that embed it.
- **The balance in Keys & credit is a snapshot.** It is read when the dialog opens, after a 402 `payment_required` and from the billing page; it does not tick down while replies on Tangent credit stream.
- **The billing page is not in the lazy chunk.** `/billing` is a lazy route, but `BillingPage` comes through the `@tangent/web-shared` barrel that the shell already imports (for `MembershipGate`), and decorated classes aren't tree-shaken out of it. A secondary entry point (`@tangent/web-shared/billing`) would move it out of the initial bundle.
- **The sidebar's Billing entry has no icon.** `@tangent/web-shared`'s icon set has nothing for billing; add one (a card or coin) there and use it in `apps/web/src/app/sidebar/sidebar.ts`.

## Canvas (`apps/canvas`)

Found in an independent review of the first cut of the experimental Canvas app. None of these block using it; together they are a day or two of iteration.

### Done since (second pass)

An Opus triage of the list below ranked the items and found two problems it had missed that were worse than any of them. Fixed, with a spec and Playwright checks:

- **Lineage request storm.** `busyBranches` returned a new Set per streamed delta, which re-ran the lineage effect, and `loadLineage` neither skipped an in-flight request nor kept earlier responses: one `GET /context` per frame while any lane streamed, none of them kept (37 requests in one second against a delayed demo backend; now 1). Fixed in `CanvasStore` (content-compared `busyBranches`, in-flight and failed keys) and in `Lane` (the measure effect no longer re-runs on every layout pass).
- **Pointer selection moved the camera.** A pointer down on an unselected lane selected it and the follow effect then zoomed to it mid-drag, and text selections scrolled away. `LayoutStore.consumePointerSelect` tells the follow effect to stay put for pointer selections; keyboard, chips, minimap and the URL still centre.
- **Touch panning and pinch** over card text (a touch is pending until it moves past 8px; a long press is left to text selection; a second finger starts a pinch), and the wheel now releases the dragging state after 150ms.
- **`prefers-reduced-motion`** disables the camera and lane transitions and the pulsing and blinking.

### Not done yet

Ranked by the same triage. None of these block using the app.

- **Fan-out creates branches one after another.** `CanvasStore.fanOut` (`apps/canvas/src/app/state/canvas-store.ts`) awaits each `createBranch` in a `for` loop, so the first reply waits for N−1 round trips. A plain `Promise.all` would scramble the lane order, which the outline sorts by `createdAt`; keep creating in order but start each variant's `send` as soon as that variant exists.
- **Markdown re-rendered on every delta.** `Card` (`apps/canvas/src/app/canvas/card.ts`) runs the whole reply through markdown-it and highlight.js per delta. Change detection is zoneless and `html` is computed lazily, so it is already at most one render per streaming card per frame (the power app does the same); it only hurts with long, code-heavy replies in several lanes. Profile a four-way fan-out before changing it (render only the tail while streaming, or throttle).
- **New lanes jump once measured.** A lane is placed at `defaultLaneHeight` (240) until its first `ResizeObserver` report, so lanes below it slide once (0.38s). Cosmetic. Estimating the height from the message lengths would change the "uses the default height" layout spec.
- **No culling of off-screen lanes.** `LayoutStore.isVisible()` exists but nothing calls it: every `<app-lane>` renders always, so a large tree keeps the full markdown DOM of every card alive. Big and risky: find-in-page and text selection break for placeholders, and `forget()` on destroy would collapse measured heights back to the default. Try `content-visibility: auto` with `contain-intrinsic-size` first. A cheaper win: reuse unchanged `LanePlacement` objects in `LayoutStore.layout`, since every height change currently rebuilds all of them and refreshes every lane.
- **Safari pinch is untested.** Desktop Safari sends `gesturechange` events rather than ctrl-modified wheel; Playwright's WebKit cannot fake a trackpad pinch. Needs a Mac and an iPad. Touch and pinch were checked only with Chromium's CDP touch events; long-press-to-select was not exercised in a browser.
- **Lanes stay long.** Unselected lanes off the ancestry clip each card at 150px (`.lane-cards.is-compact`), but a lane with many turns is still tall. A design question: clamp the number of cards in compact lanes with a "N more" stub.
- **A text drag that starts in an unselected lane can lose its selection.** Selecting the lane adds the budget bar to its head and removes the "not sent" badges, so the cards shift under the pointer and the selection collapses. The camera no longer moves; the shift is the remaining cause. Keep the lane head's height stable across selection (reserve the budget bar's space) and the badge row's height across lineage states.
- **Dropped: fling inertia.** Trackpad panning arrives as wheel events that already carry the OS momentum. Reconsider only with a phone-first design.

### Inherent to the DOM approach (noted, not planned)

- Layout depends on measured DOM heights, so it is always a two-phase render: place, measure, place again. Streaming text therefore reflows the tree live, which is also the feature.
- The zoomed world is one scaled compositor layer; there is no level of detail short of a second, simpler DOM for low zoom.
- Native text selection, find-in-page, screen readers and copy of rendered markdown come for free, which a canvas-drawn UI (for example Flutter web) would have to rebuild. See the Flutter review summarized in `DECISIONS.md` ("Canvas").

### Features left out of the first cut

- Reviewer, shares, export, backups and the system prompt editor: use Power mode, which shows the same conversations.
- Phone layout is cramped: the lane map is a desktop idea. A phone-first design would be linear with "doors" into branches (see the candidate views below).

### Candidate next views (from the same review)

- **Context Ledger.** One column showing the selected branch exactly as the model reads it, segment by segment from the context plan: system prompt, inherited ancestors, the branch summary with its status, the anchor quote, compaction stubs where messages vanished, then the branch, each with its token count and reason, and a budget rail. Writing a message shows live what it will cost and what it would push out. The API already returns everything (`GET /api/branches/:id/context`).
- **Variant Arena.** Pick a message; sibling branches off it (what fan-out creates) become a grid aligned turn by turn, with a reviewer column (`POST /api/nodes/:id/review`) showing accuracy and recommendation per variant, and "promote this variant" to move its model to the parent.
- **Trail Deck (phone).** A single thread where messages with branches or tangents show doors you swipe into, the breadcrumb chain stays pinned, and swiping back returns to the fork. The one concept where native gesture physics (a Flutter app) would earn their keep; it also needs a token-based auth path on the server first.

## Payments (Polar)

Left out of the move to Polar (docs/polar-migration/). None blocks charging.

- **No drift check of membership state.** `billing_subscriptions` is kept by webhooks only (retried by Polar, redeliverable from its dashboard). A weekly comparison against `subscriptions.list` would catch a lost delivery.
- **No legacy webhook slot.** A future provider switch after launch needs `webhookProvider` to accept the old provider's webhooks and dispute polls (never checkouts) for its refund and chargeback window (`PAYMENT_PROVIDER_LEGACY`, 03-architecture.md §2.5).
- **No email-change sync.** Polar customer emails are unique per organization; the app has no email-change flow today. If one is added, push it with `customers.updateExternal`.
- **Polar API version bump.** The SDK pins API version `2026-10` in its import path; plan the move to `2027-01` before `2026-10` is deprecated (about April 2027).

## Links between messages

Left out of the first cut of links (DECISIONS "Links between messages").

- **Links across trees.** Only two messages of one tree can be linked. Linking across trees needs rules for ownership (power and Learn are separate accounts), for deleting either tree and for backups that hold one end only.
- **Links in shares and exports.** Shares and Markdown/HTML exports leave links out. Including them means projecting only links whose two ends are in the shared scope (and not private), deciding whether notes are published, and rendering them in the viewer page and in Markdown.
- **No realtime.** Another open tab sees a new or removed link on its next load of the tree, as with branches. Pushing tree-structure changes would need a per-tree channel (the tree's Durable Object could broadcast them).
- **Links don't reach the model.** A reply's context is still its path; a linked message is not sent. Injecting linked messages (or their summaries) into the context plan, and model-suggested links (`origin: 'ai'`), are the planned next steps.
- **The second note on an existing pair is ignored.** `POST /api/links` for a pair already linked returns the existing link unchanged; the apps could offer to edit its note instead.
