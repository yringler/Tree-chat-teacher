# Deferred work

Known gaps and follow-ups that were consciously left out of a change. Each entry says where the gap is, why it matters, and roughly what fixing it takes. Remove entries as they are done.

## Membership

Left out of the server side of the membership (`apps/worker/src/billing/membership.ts`). None blocks charging for it.

- **No email when a membership lapses or a renewal fails.** Stripe's own customer emails (failed payments, upcoming renewals) cover it if they are turned on in the Dashboard (_Settings → Billing → Subscriptions and emails_); the app only shows the status on the billing page. Sending our own needs `customer.subscription.updated`/`deleted` handling in `billing/webhook.ts` and a template in `src/email/`.
- **No admin UI for waivers.** Setting, clearing and listing `auth_users.membership_waived` is the SQL in the README ("Waiving the membership"). An admin page needs an operator role first.
- **One waiver code, not per-person codes.** A leaked code is changed for everyone; whoever redeemed it keeps the flag until it is cleared by hand. Per-person or single-use codes need a codes table.
- **Monthly-plan subscriptions from before the membership are not migrated.** They no longer grant credit or count as a membership; an operator who sold them cancels them in Stripe (the Customer Portal can't switch them to the membership, which has its own price and interval).
- **The included credit isn't prorated or clawed back on cancellation.** It is granted per paid invoice and taken back only when that invoice is refunded.

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
