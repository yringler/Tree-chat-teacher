# Deferred work

Known gaps, left out on purpose. Each says where the gap is, why it matters, and roughly what fixing it takes. Remove an entry when it is done; add one when you leave something out of a change.

## Membership and payments

- **Turning the annual fee off doesn't touch existing subscriptions.** With `ANNUAL_FEE_ENABLED` off nothing requires the membership and the billing page hides it, but Polar keeps renewing subscriptions bought while it was on, and their holders can only cancel through Polar's portal (linked from Polar's own emails). Cancelling them in bulk, or keeping a "Manage billing" link for subscribers while the fee is off, is not done.
- **No email when a membership lapses or a renewal fails.** Polar's customer emails cover it; the app only shows the status. Our own would need a reaction to `membership.changed` in `apps/worker/src/billing/payments/apply.ts` and a template in `apps/worker/src/email/`.
- **Waivers can't be filtered on the admin page.** Listing everyone who has one is SQL ([operating.md](operating.md#manual-credit-and-waivers)). A filter needs a query parameter on `GET /api/admin/users` (`adminUsersQuerySchema` takes only `q` and `cursor`).
- **One waiver code, not per-person codes.** A leaked code is changed for everyone; whoever redeemed it keeps the flag until it is cleared by hand. Per-person or single-use codes need a table.
- **Disputes of membership payments are handled by hand** in Polar. Only top-ups are debited automatically.
- **No drift check of membership state.** `billing_subscriptions` is kept by webhooks only (retried by Polar, redeliverable from its dashboard). A weekly comparison against Polar's subscription list would catch a lost delivery.
- **No legacy webhook slot.** After launch, switching payment providers would need `webhookProvider` (`billing/payments/index.ts`) to keep accepting the old provider's webhooks and dispute polls, never checkouts, for its refund and chargeback window.
- **No email-change sync.** Polar customer emails are unique per organization, and the app has no email-change flow. If one is added, push the change to Polar's customer.
- **Polar API version.** The adapter imports `@polar-sh/sdk/2026-10`; plan the move to the next version before `2026-10` is deprecated (about April 2027).

## The open pool

- **The first-use human check leaves the app.** The apps' CSP doesn't load Turnstile, so `PoolFirstUseDialog` sends the learner to the Worker's `/verify` page and back (Learn keeps the unsent message across it). Allowing `challenges.cloudflare.com` in Learn's CSP would let `<app-turnstile>` and `POST /api/pool/verify` run in place.
- **One global `PoolBank`.** Every pool reservation passes through one Durable Object (about two D1 round trips each). If it becomes a bottleneck, shard by user-id hash into banks that each hold a slice of the balance, rebalanced by a coordinator.
- **No web search on the pool.** Its holds are priced from tokens alone (`worstCaseHoldMicros`), so a search fee would be overage. Allowing it means adding the per-search fee to the worst case when a request carries `webSearch`, and to the reply's ceiling reservation in `TreeSession.send`.
- **`pool_identity_holders` is only ever deleted from.** Nothing reads or writes it otherwise; dropping it (schema, the two deletes in `auth/delete-account.ts`, then the migration) is a contract step for a later release.

## Web search

- **No native search on OpenAI.** The Responses API search isn't wired up, so the default `openai` config doesn't set `options.webSearch`. (Anthropic's own `web_search` tool is wired up for own-key configs.)
- **Reviews don't search.** A review with sources would need the tool on the reviewer call and somewhere to show its citations.
- **Canvas shows no source list and has no Check sources button.** Cards render the reply text, so inline citation links do show.
- **The new-branch dialog has no grounding choice.** New branches inherit the parent's setting; Branch settings change it afterwards.
- **No `openrouter:web_fetch` for URLs the learner pastes.** It would let the tutor read one page for about $0.001.
- **No confidence trailer.** The model could flag low confidence at the end of an unsearched reply, to trigger a grounded follow-up only then. Not built: it pays for the reply twice, and Check sources covers the case at the learner's choice.
- **The daily search cap counts settled rows only.** Replies still in flight aren't counted, so a burst of parallel sends can pass the cap by up to `USAGE_MAX_PENDING`.

## Power app and Canvas

- **Canvas has no billing page or membership panel.** A blocked user gets a banner linking to the power app's `/billing`, and locked lanes show the shared read-only notice. Rendering more there needs `/canvas/billing`, or a return path from `/billing` back to Canvas.
- **A malformed model id is not blocked before sending.** For `openModels` providers the model picker shows an inline hint, but the dialogs still submit; the server answers 400 and the error is a toast. Disabling Save needs the picker to expose its validity to the dialogs that embed it.
- **The balance in Keys & credit is a snapshot,** read when the dialog opens, after a 402 and from the billing page; it doesn't tick down while replies on credit stream.
- **The billing page isn't in its lazy chunk.** `/billing` is a lazy route, but `BillingPage` comes through the `@tangent/web-shared` barrel the shell already imports. A secondary entry point (`@tangent/web-shared/billing`) would move it out of the initial bundle.
- **The sidebar's Billing entry has no icon.** The shared icon set has nothing for billing.

## Canvas (`apps/canvas`)

- **Fan-out creates branches one after another.** `CanvasStore.fanOut` awaits each `addBranch` in a loop and sends once all exist, so the first reply waits for N−1 round trips. Keep creating in order (the outline sorts by `createdAt`) but start each variant's send as soon as it exists.
- **Markdown is re-rendered on every delta.** `Card` runs the whole reply through markdown-it and highlight.js, at most once per streaming card per frame. It only hurts with long, code-heavy replies in several lanes; profile a four-way fan-out before changing it.
- **New lanes jump once measured.** A lane is placed at `defaultLaneHeight` (240) until its first `ResizeObserver` report, so lanes below it slide once.
- **No culling of off-screen lanes.** `LayoutStore.isVisible()` exists but nothing calls it, so a large tree keeps every card's DOM alive. Try `content-visibility: auto` first; placeholders would break find-in-page and text selection.
- **Safari pinch is untested.** Desktop Safari sends `gesturechange`, which Playwright's WebKit can't fake; needs a Mac and an iPad.
- **Lanes stay long.** Unselected lanes clip each card at 150px, but a lane with many turns is still tall. A design question: clamp compact lanes with a "N more" stub.
- **A text drag that starts in an unselected lane can lose its selection.** Selecting the lane changes its head's height, so the cards shift under the pointer. Keep the head's height stable across selection.
- **No reviewer, shares, export, backups or prompt editor;** use the power app. The phone layout is cramped: the lane map is a desktop idea.

## The Flutter app (`apps/flutter`)

- **Emoji and non-Latin scripts (Chinese, Hebrew, Arabic, …) show as empty boxes.** The app bundles Roboto and subsets of Noto Sans Math, Symbols 2 and Mono, so arrows, maths and code render; for a glyph none of them has, Flutter's web engine fetches a Noto font from `fonts.gstatic.com`; `FLUTTER_APP_CSP` refuses it (`connect-src 'self'`), which also keeps learners' addresses from Google, and the console logs each refusal. Fixing it means serving the fallback fonts from `/app/` and pointing the engine's `fontFallbackBaseUrl` there (a custom `web/flutter_bootstrap.js`); Google serves them as hundreds of subset files, so only the scripts and emoji learners need.

## Links between messages

- **Links across trees.** Only two messages of one tree can be linked. Across trees needs rules for ownership, deleting either tree, and backups that hold one end.
- **Links in shares and exports.** They leave links out. Including them means projecting only links with both ends in the shared scope (and not private), deciding whether notes are published, and rendering them.
- **No realtime.** Another tab sees a new link on its next load of the tree, as with branches.
- **Links don't reach the model.** A linked message isn't sent; injecting linked messages (or their summaries) into the context plan, and model-suggested links (`origin: 'ai'`), are the next steps.
- **A second note on an existing pair is ignored.** `POST /api/links` returns the existing link unchanged; the apps could offer to edit its note instead.

## Sharing

- **`shares.mode` is still in the schema.** Every share is a snapshot and the code writes `snapshot`; migrations are expand-only, so the column is dropped in a release after the one that stopped reading it.
- **Alerts are email only.** A chat webhook (Zulip) for the high-severity alerts would reach the operator faster; it needs a secret for the webhook URL and a second sender behind `sendAlert`.
- **Screening thresholds are a first guess.** They are constants in `packages/core/src/moderation/moderation.ts`; tune them from the scores `share_screened` rows record once there are a few weeks of them.
- **Republishing screens the whole conversation again.** A cache of screened texts (by hash) would send only what changed; screening is free and a publish is rare, so it isn't worth it yet.
- **No DMCA layer.** Copyright goes through the general report form and the terms' email procedure, with no registered agent, so there is no §512 safe harbor. Adding it: register the agent ([LEGAL.md](LEGAL.md#8-user-content-and-share-links)); a `/dmca` page with the agent's details exactly as filed, how to send a notice and a counter-notice, and the repeat-infringer rule; the §512(c)(3) notice fields (the work, the link, the complainant's name, address, phone and email, the good-faith and accuracy-under-penalty-of-perjury statements, a typed signature) as nullable columns on `share_reports` for copyright reports; and the §512(g) counter-notice flow: tell the owner with a copy of the notice and a counter-notice form, forward a counter-notice to the complainant, and restore the share 10 to 14 business days later from the daily cron unless the complainant says they have sued.
- **No account suspension or termination.** Only sharing can be suspended (`auth_users.sharing_suspended`). Terminating an account today is by hand: an admin places a legal hold on its shares, then deletes the account. Nothing stops the same person signing up again with the same email; blocking it needs a kept hash of the address, like `pool_identities`.
- **Links removed with their conversation aren't audited one by one.** Deleting a conversation, a branch or an account removes its share links through the database (cascades and `deleteUser`) with no `share_deleted` row each; their reports and holds stay. Recording them needs the tree's Durable Object and `deleteUser` to list the links they remove.
- **Hold copies live in D1.** `legal_hold_items` stores each copy as JSON in chunks; many or large holds would be better as R2 objects with only their keys in D1.
- **No reminder when a hold can be released.** A hold with a recorded NCMEC or law-enforcement report can be released after a year, and one without whenever it is no longer needed; nothing tells the operator either, so holds stay until someone looks at `/admin/`. The daily cron could email the legal contact about holds past their year.
- **No revoke button on the public page.** The page has no session and its CSP forbids forms, so owners revoke links in the app.
- **The admin page shows no audit trail and can't hold an unreported share.** `GET /api/admin/users/:userId/events` and `POST /api/admin/shares/:shareId/hold` exist, but the admin app only holds shares from the reports queue and doesn't list a user's events; until it does, a law-enforcement request about a share nobody reported is held through the API.
