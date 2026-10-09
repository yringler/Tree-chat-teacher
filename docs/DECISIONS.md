# Decisions

The rules the code follows today, and why. One section per area. When a rule changes, edit it here in place: this page describes the present, and git keeps the past. The log this page replaced, with every superseded decision, is [archive/DECISIONS-2026-10.md](archive/DECISIONS-2026-10.md).

## Product and scope

- **Tangent is a branching chat for learning.** Any message can grow any number of branches, and each branch decides what the model sees (its context mode). Two apps share one Worker and one sign-in: the power app (`/`, `apps/web`) with every control, and Learn (`/learn/`, `apps/simple`), a tutor with nothing to configure. Canvas (`/canvas/`, `apps/canvas`) is a third, experimental view of the power conversations, as lanes on a surface.
- **Self-hostable open source, run as one hosted deployment.** What a self-hoster needs stays configurable (URLs, legal names, providers, prices, payment provider); internal mechanics are constants ([Configuration](#configuration)). The name and logo are not licensed.
- **Pre-launch: no backward compatibility.** Production holds only the owner's data, so renames and removals ship without shims, fallbacks to old names, data migrations of old shapes, or upgrade tests. This ends at launch.
- **The money scope is fixed:** Tangent credit, the yearly membership, and the open pool. Nothing else is sold, and nothing is added to it without the owner. The impact feed, the pool's revenue share, credit included with the membership, pool purchases and the featured-conversations stub were removed in October 2026.

## Accounts and sign-in

- **Every user has two accounts: `p_<userId>` for power (Canvas included) and `u_<userId>` for Learn.** The apps say which with the `x-tangent-mode` header (absent means power). The two keep separate conversations: a Learn lesson runs on Learn's provider and tutor prompt, which power doesn't have. Moving a conversation across is a JSON backup, or **Create a copy in Learn**. `resolveAccount` (`apps/worker/src/auth/account.ts`) is the one place that decides the acting account; `AccountContext` is a union of the accounts that exist.
- **Credit is per user, not per account:** one ledger, `u_<userId>`, shared by both apps.
- **Ownership is checked in one place and answers 404.** Another account's tree, branch, node or share looks exactly like a missing one (`packages/core/src/services/ownership.ts`). The Worker resolves every id through it before it talks to a Durable Object, which trusts the account the Worker passes. A test generates the cross-user matrix from the route table, so a new id-taking route can't skip it.
- **Better Auth in the Worker, no passwords.** Google, GitHub, magic links and passkeys. Anyone with a verified email may sign up: Turnstile on the magic-link form (the one endpoint that sends email) and its rate limits bound abuse. An OAuth identity links to an existing user only when the provider reports the email verified; trusting a provider wholesale would let an unverified address take over an account.
- **The Worker fails closed.** Without `BETTER_AUTH_SECRET` every `/api/*` request is a 500. The dev bypass (`DEV_ALLOW_NO_AUTH=true`, exactly) works only while that secret is unset, and belongs in `.dev.vars`.
- **Every API write must be same-origin**, checked in one place for all routes, so a body-less destructive route doesn't rely on SameSite alone.
- **Admins are user ids in the `ADMIN_USER_IDS` secret.** To anyone else `/admin*` and `/api/admin/*` are 404. An id is not a credential: being an admin still takes signing in as that user.

## Context modes

- **Four modes, per branch:**
  - `path`: everything the parent saw at the branch point, plus the branch's messages. It is compositional, so a `path` branch under a summary branch doesn't re-expand what the summary dropped.
  - `summary`: a cached summary of the parent's context, focused by the quote.
  - `message`: only the message the branch forks from, as the parent saw it. The quote alone often lacks the answer around it; the whole path is more than the branch needs.
  - `independent`: only the quote or topic.
- **The tree's system prompt goes in every mode,** including `independent`: it is configuration, not conversation. **The anchor quote goes in every mode too,** as an `<excerpt>` in the user turn where it occurs (not in the system prompt), so sibling branches share the cached prompt prefix up to their branch point.
- **`assembleContext` is pure and deterministic** (`packages/core/src/context/assemble.ts`). It plans the context; summaries are generated outside it and fed back, as many rounds as the nesting needs. Summaries are cached in D1 by anchor node and a hash of their transcript and focus, so a changed transcript means a new key and invalidation is implicit.
- **Over budget, compact before truncating.** The oldest part of the context becomes one cached summary, in whole steps of half the budget, so later turns find the same summary and send the same prefix (the prompt cache keeps working). Truncation is the last resort: when a summary can't be made or fails, the plan truncates instead and records it, and the send says so. Power users can choose to drop instead of summarize, per send.
- **Summaries run on the summary provider if the user can use it, else on the branch's own route** (`SUMMARY_PROVIDER_ID` without the user's key would otherwise silently lose summaries, titles and compaction). On Tangent credit they are billed like the reply.
- **Tokens are estimated at 3.5 characters a token** plus the provider's reported usage. There is no tokenizer to ship. The open pool counts UTF-8 bytes instead, because its input limit must be a hard bound.

## Providers and models

- **Raw `fetch` and our own SSE parser, no vendor SDKs** (`packages/providers`). It runs on any Web runtime, aborts uniformly and handles OpenRouter's quirks explicitly. One HTTP layer serves the Anthropic and OpenAI-compatible providers, and `decorateProvider` is the one way to wrap a provider, so a new optional member can't be dropped by a wrapper that forgot it.
- **A provider id names an endpoint, never who pays.** The built-in provider is the endpoint `openrouter` on the operator's key (`OPENROUTER_PROVIDER_ID`); a user's own OpenRouter has the same id. Who pays is a separate fact ([Money](#money-credit-membership-and-the-open-pool)).
- **Power's providers come from `PROVIDERS`** (default: Anthropic, OpenAI, OpenRouter), on the user's own keys only. The server keys those configs name serve only the local dev bypass. `openModels: true` makes a provider's models suggestions: any well-formed id is accepted, as OpenRouter adds models weekly.
- **What a provider can do is a capability flag, not its kind.** The test provider (`fake`) is for tests and offline development, never a default.
- **OpenRouter-specific request knobs live in the provider config** (pinned providers, reasoning effort, search engine), not in the shared request. Anthropic ignores them.
- **Reasoning effort is `none | low | high`; there is no `max`.** At its top effort a model is far more verbose and almost never admits it doesn't know. Thinking is never shown, stored or sent back, so the cached prefix stays byte-identical.
- **A reply cut off at its output cap is not shown as an answer.** It ends as an error node that keeps its text, with an `errorKind` (`cut_off`, `thinking_only`, `empty`, `cancelled`, …) stored in its own column. Apps decide by the kind, never by the English message; for nodes without a kind the message is mapped once (`errorKindOf`). Learn and power offer **Continue**; there is no automatic retry, which would pay for the thinking twice.
- **The hosted models come from an eval (2026-10-08):** Learn's Normal is `deepseek/deepseek-v4.1-flash` at `high` effort, Max is `anthropic/claude-sonnet-5.5`, and summaries, titles and the open pool run V4.1 Flash at `low`. V4.1 Flash is pinned to StreamLake then DeepInfra (fp8, both cache). Not to DeepSeek's own endpoint: OpenRouter drops it for an account that denies paid-data training, and the fallbacks then scatter and lose the cache. An empty tier var means these evaluated settings only while the tier runs its default model.
- **Tiers are data:** `ModelInfo.tier` (`normal` | `max`), with every user-facing word for them in `@tangent/shared` `tiers.ts`. Branches store model ids, never labels.
- **OpenRouter models are budgeted on their real windows,** synced daily from OpenRouter's model list into `model_windows`. A window the config names is only ever lowered to the real one, so credit's and the pool's bounds hold.
- **No provider names in the apps or the shared packages.** `scripts/check-provider-neutral.mjs` (in `pnpm lint`) keeps them out; ESLint keeps the Polar SDK inside its adapter.

## Web search (grounding)

- **OpenRouter's `openrouter:web_search` server tool, offered by a free gate, used at the model's discretion.** `decideGrounding` (`packages/core/src/grounding/policy.ts`) is a pure score: depth in the tree, a specific fact, recency, sources asked for. Searching every turn would multiply a lesson's cost about 15×; a classifier call adds latency and judges no better. At most one search per reply, on Exa, so the price is predictable. OpenRouter folds the fee into the reported cost, so billing needs nothing new. Anthropic's own `web_search` tool serves own-key Anthropic configs only, since Anthropic reports no cost to meter.
- **Check sources forces a search and adds the check to the conversation** (in place on the last reply, else as a `path` branch), so later turns inherit the correction.
- **Citations are Markdown links in the reply.** Follow-ups rely on them instead of searching again; summaries are told to keep them. `nodes.sources` is null when the reply didn't search and `[]` when it searched and cited nothing.
- **The instructions travel after the history,** on the reply's user turn, so the system prompt and the history are the same on every turn. The tool itself still comes and goes with the gate, which costs a cache miss past the tool block (`always-offer` avoids that at the cost of more searches).
- **`GROUNDING` is the operator's ceiling over both apps,** and the `GROUNDING_*` vars win over a provider's own options. Power also has a per-branch setting; Learn ignores it. Automatic searches on credit stop for the day at `GROUNDING_AUTO_DAILY_CAP` per user.
- **Never on the open pool.** A pool hold is priced from tokens alone, so a search fee would be overage the operator pays.

## Money: credit, membership and the open pool

### Who pays

- **One `Payer` type: `own-key`, `credit` or `pool`.** Power stores it per branch (`branches.funding`: `own-key` or `credit`), so one tree can mix both. Learn decides it per request (the `x-tangent-payment` header plus the server's rules), so a Learn branch always stores `own-key`. Naming a provider never spends credit implicitly: a missing funding is `own-key`. `usage_events.funding` stores credit as `personal` (rows already written say so).
- **Learn's payer rule is one function, `learnPayer` in `@tangent/shared`,** used by the client and by the Worker's gate, and the reply's `start` event reports the payer the server actually used. In order: the own key if chosen; the pool if chosen and on; credit if sold; a saved own key; the pool if on; else the own key. A Learn send or context resolve on credit that can't cover its hold moves to the pool while the pool is on; reviews and Compare never do.
- **The default route of a new power tree** is `pickDefaultRoute` (`packages/shared/src/default-route.ts`), used by the Worker and both power apps: an own-key provider the user has a key for; else Tangent credit if it can pay; else OpenRouter on the user's own key. While own keys need a membership the user lacks and credit is sold, credit comes first. Credit is never a default that can't pay.
- **A missing own key is a choice, not a wall.** A 401 `key_required` opens the keys dialog, saying the message wasn't sent and offering **Continue on Tangent credit**. Composers keep their text until the reply starts, so no refusal loses a message.

### Tangent credit

- **Users pay true cost plus one markup.** A call is charged `ceil(cost × (1 + OpenRouter fee) × (1 + markup))`, in exact integer math, rounded up, with `cost` what OpenRouter reports for the call. The fee and markup are fixed when the call starts and stored on its row, so a config change never reprices past calls. Purchases are credited net of Polar's actual fee. With both fees passed through, the markup is real margin.
- **The ledger is integer micro-USD, and the balance is derived:** grants minus settled charges, minus pending holds for "available". Grants are idempotent on the provider's object (`provider_ref` is unique); settles are conditional on `status = 'pending'`. There is no cached balance to get wrong.
- **Each call holds its worst case before it starts,** at its model's price (input bound and output cap, with fee and markup), never below `USAGE_HOLD_MICROS` ($0.02). A reply is held before its prompt exists, at its whole input budget and reply cap: about $0.37 for a Max reply at the defaults. The hold is inserted in the same statement that checks the balance and the in-flight limit (`USAGE_MAX_PENDING`, 6), so parallel sends can't overdraw. A model with no price can't run on credit.
- **A started reply is never cut off.** The reported cost can exceed the hold a little; the balance may go slightly negative and the next purchase absorbs it. The credit limit on `BUILT_IN_API_KEY` at OpenRouter is the backstop.
- **Lost costs are reconciled:** OpenRouter's generation endpoint with retries, then a 10-minute cron. A call that never reached OpenRouter settles at $0; one still unknown after 24 hours is `unresolved` at $0 and logged.
- **Refunds and disputes debit only the buyer's own ledger.** A refund debits its pre-tax amount once it succeeds. Polar has no dispute webhooks, so the cron polls disputes. Dispute markers live in `billing_markers`, so `credit_grants` holds money only. A purchase's refunds and disputes together never take back more than it paid.

### The membership

- **The membership is required for generating on the user's own keys, and for nothing else** ($10 a year plus tax, one per user for both apps). Tangent earns from own keys through the membership and from credit through the markup; a member who also uses credit pays both, each for what it covers. Credit is bought and spent without one; the pool never needs one.
- **It is off unless `ANNUAL_FEE_ENABLED` is on, a membership product is set and user keys can be stored** (`KEY_ENCRYPTION_SECRET`). With nothing to unlock, nothing requires or sells it. No credit comes with it.
- **Without a membership, nothing is locked away.** A power branch on an own key turns read-only: a notice where the composer was, offering renewal, **Create a copy in Learn** and, while credit can pay, **Continue with Tangent credit**. Reading, export, backups, settings, delete and links stay. The server states the rule (`MeResponse.membershipNeededFor`), the clients don't copy it, and the server's gate stays the source of truth.
- **Waivers:** `auth_users.membership_waived`, set from the admin page or by the `MEMBERSHIP_WAIVER_CODE` code. A waived user is a member.

### The open pool

- **Free credit Tangent provides, for Learn users who can't pay,** funded by the operator with admin adjustments. Tangent earns money only from what it sells; nobody buys pool credit, and paying buys no more of it. No page may call it a donation or tax-deductible, or make a buyer the one who funds it (`FORBIDDEN_POOL_COPY`, checked by tests). Polar prohibits selling donations or community access.
- **Learn only, one model, one locked prompt.** Power and Canvas never spend from it. On the pool the server pins the model, the system prompt and the limits, whatever the tree says. No Compare, reviews or web search there.
- **The same daily caps for everyone:** replies and spend per user, per network (a daily-rotating hash of the IPv4 address or IPv6 /64, never the address) and for all users together. Per-minute limits too.
- **`PoolBank`, one Durable Object, serialises everything that can lower the pool's available balance,** with an explicit lock, because Durable Object input gates don't hold across D1 I/O. D1 stays the authority. Charges are clamped to their holds; the excess is operator-paid overage, and a breaker closes the pool when it exceeds $0.20 a day (a price below what calls really cost).
- **A reply reserves its ceiling hold before any node is written,** and that hold must fit under the per-user daily spend cap, or the pool reports itself off and logs `pool_misconfigured`.
- **Access gates, each a 403 with its reason:** signed in, not suspended, a Turnstile pass on record, one pool identity per mailbox (a hash of the normalised email), and an optional minimum account age.
- **Pool limits fail closed.** The other rate limiters fail open so nobody is locked out of their own keys; the pool is the operator's money.

### Payments

- **Polar is the merchant of record,** behind a port (`apps/worker/src/billing/payments/port.ts`). Adapters translate Polar's objects into normalised events and never touch D1 or the ledger; `payments/apply.ts` decides. A new provider is an adapter, not a rewrite.
- **Membership state is ours,** from webhooks, upserted with a version guard so order and duplicates don't matter. No provider call per request.
- **The fee estimate is a fallback, never a retry:** an order without a usable fee is credited with an estimate and logged (`fee_estimated`), because Polar disables a webhook endpoint after 10 consecutive failures.

## Privacy and retention

- **Users' API keys live only in the browser, sealed.** One AES-256-GCM cookie (`__Host-llmkey`, HttpOnly) holds every provider's key, sealed for the signed-in user (`uid`) with an expiry. Another user's cookie opens as no key, and sign-out clears it, so a shared browser never runs on the previous user's keys. The server stores nothing; the Durable Object opens the sealed value itself, in memory, per generation. Rotating `KEY_ENCRYPTION_SECRET` revokes every key.
- **Nothing logs request headers or bodies.** They carry users' keys. Logs are structured events through one `logEvent` helper.
- **Providers get only the secrets their configs name,** never the app's other secrets.
- **Deleting is immediate and goes through the tree's Durable Object.** It aborts the tree's running generations (so nothing keeps billing for discarded text), deletes held Compare answers, then deletes the rows.
- **Account deletion keeps only what the open pool needs to stay fair, and nothing that leads to the person.** Usage rows lose their user id (amounts stay, so the pool's sums don't move); the network key goes once the day is over; the pool identity hash keeps its suspension and the day's usage for 90 days (`POOL_IDENTITY_RETENTION_DAYS`), so deleting and signing up again can't reset either. A daily sweep catches what a deploy missed. No reservation is written for a user who no longer exists.
- **Imports are bounded:** size and count limits in `treeBackupSchema`, and a rate limit per account.
- **The privacy policy follows the code.** It is rendered from the config (`apps/worker/src/http/legal.tsx`, `hosted-ai.ts`): which models Tangent pays for, their makers and pinned hosts. A change to what is collected or kept updates the policy and [LEGAL.md](LEGAL.md) in the same change.

## Sharing, export and links

- **The public viewer is a self-contained, server-rendered page, the same function as the HTML export.** It needs no session, has a strict hash-based CSP and lives on `/s/*` of the same hostname. Revocation is checked against D1 on every view, and cache keys include the version, so revoke and republish take effect at once.
- **Private branches never enter a share or export payload** (the pure projection drops them and everything below them). JSON backups include everything.
- **Share links are off for everyone but admins and allowed users until a DMCA designated agent is registered** (`DMCA_AGENT_REGISTERED`). A share's expiry changes only when the user picks one.
- **One backup format for both apps.** An import into Learn is adapted server-side (`adaptBackupForLearn`): Learn's provider and models, every branch `path`, Learn's prompt, every branch `own-key`. Nothing is charged by an import or a copy.
- **Links join two messages of one tree,** stored directed and shown on both ends, at most once per pair. They are owner data: in backups, not in shares or exports, and never sent to the model. They need no membership.

## Frontends and the shared engine

- **Angular 22, standalone, signals, zoneless, OnPush.** Workspace packages export TypeScript source, so there is no library build.
- **Shared logic lives once, in `packages/web-shared` or the `packages/*` below it, never copied between apps.** Three copies of the state engine drifted into bugs before October 2026. Today:
  - `ConversationStore` (`web-shared/src/conversation/`) is the engine every app's store extends: tree list, open tree, where the user is in it (path, crumbs, outline, focus on the path, opening a branch at its first message), live replies, the stream reducer, sends per branch, branch and link CRUD, resume. Apps supply hooks for their side effects.
  - `PowerConversationStore`, `PowerAccount` and the keys dialog (`web-shared/src/power/`) are shared by power and Canvas.
  - The composer and its `ComposerController`, toasts, the dialog stack (`Overlays`), the shortcut dispatcher and the demo backend are shared by all three; the path keys (`pathKeys`) and the shortcut table by power and Learn.
- **Each app holds its dialogs in one stack,** so Escape closes the top one and shortcuts never fire behind a modal.
- **The HTTP API is one typed route table** (`packages/shared/src/api-routes.ts`): the apps' `ApiClient` calls it, the Worker validates with each entry's schemas, the demo backend must answer or refuse each route, and a test checks the Worker serves exactly those routes. Every JSON body is validated with zod (jitless, for the CSP).
- **The demos run in the browser on the real `ChatService`** with in-memory repositories (`@tangent/core/memory`), the Worker's chat-settings builder and money math, and the same `GenerationHub` as the Durable Object. One repository contract suite runs against the memory and D1 repositories.
- **One Durable Object per tree (`TreeSession`) owns its generations:** streams outlive the tab, a reconnect replays, and sends are serialised per tree (any number of branches may generate at once; only a branch whose last reply is still streaming refuses a send). Deltas live in memory; the final text goes to D1 once.
- **The apps are served by the Worker's static assets,** with a strict CSP (`script-src 'self'`, Trusted Types). The Worker sets the same CSP on the responses it renders itself (`/learn*`, `/`); a test keeps the copies identical. Public pages (landing, pricing, pool, legal, verify) are server-rendered with `hono/jsx` in one layout: no script, escaping by default. They are built from the config, so they describe what this deployment sells, and their tests check facts (prices, limits, forbidden wording), not whole sentences.
- **Canvas is a view of the power account, not a third account.** Its lineage view asks the real context planner (unresolved) rather than re-deriving it.

## Deploy and migrations

- **GitHub Actions deploys, after CI passes** (`.github/workflows/ci.yml`). The Deploy job runs on `master` in the `production` environment: build once with no secrets, check that all four apps are in the assets, then `wrangler d1 migrations apply` and `wrangler deploy` with a config that has no `build` step (`scripts/deploy-config.mjs`), so the API token never meets the build toolchain and the upload is the build that was checked. One deploy at a time, never cancelled midway. Workers Builds is not used: it deployed whatever CI said and ran no migrations.
- **The `production` environment allows only `master`.** Without that rule, a pull request that edits `ci.yml` could run a job there and read the deploy secrets.
- **Migrations are applied before the code, so each must work with the code still running:** expand first (new tables, nullable or defaulted columns), contract in a later release. Re-running an old deploy redeploys old code onto the newest schema.
- **drizzle-kit writes every migration from `schema.ts`.** Never edit an applied migration, and never hand-write one. `pnpm lint` fails when `schema.ts` has a change no migration has (`scripts/check-migrations.mjs`). The history starts at `0000_baseline.sql` (the 27 earlier migrations were squashed before launch; production was converted once by hand, see [runbooks/d1-baseline.md](runbooks/d1-baseline.md)).
- **Durable Object class migrations in `wrangler.jsonc` are append-only too.**
- **Money tables are reached with raw SQL typed from `schema.ts`,** so a column rename is a type error in the ledger and the meter.

## Configuration

- **One module reads env: `apps/worker/src/config.ts`.** Every other module gets typed values from `appConfig(env)` and reads only bindings (a test checks). One parser per type; a malformed value fails every request with an error naming the var, so a typo never silently means the default.
- **A var exists only if a deployment has its own value for it.** Internal timings and limits that never change are constants (the pool's ledger id and reservation timings, the overage breaker, credit's minimum hold and in-flight limit). Money and abuse limits stay vars. `wrangler.jsonc` lists only this deployment's values (a test fails on one that restates its default).
- **One reference: [configuration.md](configuration.md),** kept in step with `CONFIG_VARS` by a test. Test-only vars (honoured only with `TEST_SEAMS`) are never documented.
- **Names say what they configure:** `BUILT_IN_*` for the built-in provider (Learn, power's credit and the pool), `LEARN_NORMAL_*` / `LEARN_MAX_*` for Learn's tiers, `BACKGROUND_*` for summaries and titles, `POOL_*` for the pool.

## Tooling

- **pnpm workspaces, not Nx;** TypeScript ~6.0 (Angular 22 needs `<6.1`); Vitest 4.1 everywhere; Node 24 (`.nvmrc`).
- **Worker tests run in real workerd with real D1 and Durable Objects** (`@cloudflare/vitest-pool-workers`); suites that need neither run in plain Node. Every outbound call is mocked in one place. Coverage is reported, not enforced.
- **End-to-end tests sign in through the real magic link** (links printed to the server log, Turnstile's always-pass test keys) and set billing state through the fake payment provider's signed webhook, so production gains no test-only sign-in route.
- **Lint includes the type-aware promise rules, the provider-neutral check, the migration check and an import-cycle check** (`scripts/check-cycles.mjs`, runtime imports only).
