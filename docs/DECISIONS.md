# Decisions

Each entry is one line. Newer decisions go at the bottom. See [PLAN.md](./PLAN.md) for context.

## Tooling

- **pnpm workspaces, not Nx.** There are six packages with a simple dependency graph, and the Angular CLI already builds the web app; Nx would add config and a daemon without paying for itself.
- **Workspace packages export TS source** (`exports: ./src/index.ts`). Wrangler (esbuild), Vite/Vitest and the Angular builder all compile TS, so there is no build or watch step for libraries.
- **TypeScript ~6.0.3, not 7.x.** Angular 22 and typescript-eslint both require `<6.1`.
- **Vitest 4.1.x everywhere.** `@cloudflare/vitest-pool-workers@0.22` requires `^4.1`, and one version avoids duplicate installs.
- **Node ≥ 22.22.3 (24 recommended).** Angular 22's CLI refuses older versions (`.nvmrc` = 24).
- **ESLint 10 flat config with `typescript-eslint` strict (non-type-checked).** It is fast and catches `any`. Angular templates are type-checked by `strictTemplates` rather than linted.
- **Worker `compatibility_date` 2026-08-15.** This is the newest date supported by the workerd bundled with vitest-pool-workers 0.22. Bump it when the pool updates.

## Backend

- **Hono.** It is small, Web-standard, has first-class Workers support and also runs on Node, which keeps a port cheap.
- **Drizzle over Kysely for D1.** It has an official D1 driver with `batch`, drizzle-kit generates the Wrangler migrations, and `kysely-d1` has had no release since April 2025. Recursive CTEs use Drizzle's `sql`.
- **Recursive CTE for ancestor lookups.** It is O(depth) primary-key hops and needs no write-time bookkeeping. Subtree queries only occur in share/export, which load the whole tree anyway.
- **Branches are first-class rows, and each branch is a linear chain.** The outline is a tree of branches with a title, mode and count. Mode, anchor, privacy and model all attach to the branch.
- **`UNIQUE(branch_id, seq)`** lets the database reject racing appends to the same branch, even outside the DO.
- **One Durable Object per tree (`TreeSession`) owns generations.** `waitUntil`'s 30 s cap can't finish long streams after a disconnect. The DO also enables reconnect-with-replay and serializes sends per tree.
- **The DO keeps event buffers in memory only.** Final content goes to D1 once, and a restarted DO marks orphaned `streaming` nodes as interrupted. That is simpler and cheaper than persisting every delta.
- **SSE over `fetch()` streaming in the client**, because send is a POST (EventSource only supports GET). Reconnect uses `GET /api/nodes/:id/stream`.
- **Summaries are cached in D1**, keyed by `(anchorNodeId, sha256(transcript+focus), model)`. A changed transcript means a changed hash, so invalidation is implicit and lazy.
- **Summary provider/model are configured by `SUMMARY_PROVIDER_ID`/`SUMMARY_MODEL`**, defaulting to the branch's own provider/model. A cheaper model (e.g. `claude-haiku-4-5`) is recommended in the README.
- **`chars/3.5` token estimate plus the provider's reported usage.** There is no tokenizer to ship. The inspector uses Anthropic `count_tokens` when the provider supports it.
- **Share snapshots are stored in D1 as 256K-char chunks, not R2.** This keeps one storage system and makes republish atomic in a single batch. Chunking stays under the 2 MB row and 100 KB statement limits because values are bound, not inlined.

## Providers

- **Raw `fetch` + our own SSE parser instead of vendor SDKs.** This means zero dependencies, it works on any Web runtime, gives uniform abort handling, and handles the OpenRouter quirks explicitly.
- **AI Gateway is optional, via `baseUrl` + `extraHeaderSecrets`.** It adds logging and retries, but its cache does not apply to streams, so it isn't required.
- **Provider instances come from the `PROVIDERS` JSON var**, falling back to built-in defaults (anthropic, openai, openrouter, fake). API keys come from Worker secrets named in each config.
- **The default model is `claude-opus-5-5`.** No `temperature` and no assistant prefill are ever sent, because Opus/Sonnet 5.5 reject them.

## Context

- **`path` mode is compositional:** it inherits the parent's effective context at the branch point. A path branch under a summary or independent branch therefore doesn't re-expand what that ancestor dropped.
- **The anchor quote is included in every mode**, placed before the branch's own messages. It also focuses the summary in `summary` mode.
- **The tree system prompt is sent in every mode, including `independent`.** It is configuration, not conversation.
- **Summaries and anchors are rendered into the system prompt**, not as fake messages, so user/assistant alternation is never broken.
- **Compaction replaces the oldest prefix of the context with one cached summary.** Truncation is only a last resort, and both are recorded in the plan.

## Sharing & access

- **The public viewer is a self-contained, server-rendered page, not the Angular app.** It needs no session, works on phones, uses a strict hash-based CSP, and is the _same function_ as the HTML export.
- **Shares live on `/s/*` of the app's own hostname rather than a separate one.** There is one domain to manage. The page is self-contained under a strict CSP, `/s/*` never reads the session, and session cookies are HttpOnly.
- **Revocation is checked on every request against D1, and cache keys include `version`.** Revoke and republish take effect instantly and globally without a global purge (the Cache API is per-colo).
- **Private exclusion happens in the pure projection.** Private branches never enter the payload, and creating a share of a private target is rejected.
- **Share keys (`b0`, `m3`) are per payload.** No internal ids leak to viewers.
- **Exports exclude private branches by default.** The owner can opt in with `includePrivate=true`. JSON backups always include everything.
- **The Worker fails closed if sign-in isn't configured.** `DEV_ALLOW_NO_AUTH=true` is honoured only while `BETTER_AUTH_SECRET` is unset, and belongs in `.dev.vars` only.
- **Markdown uses markdown-it (`html:false`) + highlight.js, shared by Angular and the Worker.** It needs no DOM, so there is one renderer and the output can't diverge. Angular's sanitizer is a second layer.

## Integration (post-merge)

- **Stale `streaming` nodes are recovered lazily**, when a fresh DO instance first serves a tree and when a client reconnects. No alarm is needed, because a restart always precedes the next access.
- **The Fake provider never auto-titles**: the title would just echo the prompt. Branches keep the readable default title, which is the anchor quote or the first words of the message.
- **Angular bundle budget warning set at 1.5 MB (≈235 kB gzipped).** zod, markdown-it and highlight.js ship with the shared packages; that is acceptable for a single-user app.
- **The Hono app lives in `apps/worker/src/app.ts` (`createApp`)**, so tests can inject a local JWKS. `index.ts` only exports the handler and the Durable Object.
- **Viewer tables use `ta-left/center/right` classes instead of inline `style`**, because the share page's strict hash-based CSP blocks inline styles.
- **A share whose fork node is filtered out** (a system, streaming or error node, or a node before a subtree target) drops that child branch and everything below it.

## Accounts (multi-user)

- **Trees and shares carry `account_id`.** It references an `accounts` table seeded with a single `default` account in migration 0001. Existing rows backfill via the column default, so there is no data rewrite.
- **Branches, nodes and summaries inherit ownership through `tree_id`.** They have no column of their own, so per-user data is a matter of filtering by tree.
- **One place decides the acting account:** `resolveAccount(env, identity)` in `apps/worker/src/auth/account.ts`.
  - The dev bypass, or an email on `ALLOWED_EMAILS` → the shared `default` account in `power` mode. The owner keeps their data and the allowlist keeps its meaning.
  - Any other signed-in user with a verified email, while `OPEN_SIGNUP=true` → a personal account `u_<userId>` in `simple` mode. The id is derived from the Better Auth user id (stable, unlike email), so resolving it needs no lookup and can't race.
  - Anyone else → 403.
- **Account rows are created on first use** (`INSERT OR IGNORE`, memoized per isolate) by `accountMiddleware`. Migration 0003 adds `accounts.user_id` (unique) and `accounts.mode`; the `default` row stays `power` with no user id.
- **`AppVariables.account` (`{ id, mode, userId }`) replaces the bare account id.** `accountId` stays as an alias. Routes need the mode for gating (BYOK, billing, rate limits, the default system prompt).
- **Open sign-up is off by default.** `user.create.before` and the magic-link sender accept an email when it is allowlisted or `OPEN_SIGNUP=true`; `/api/login-options` reports `openSignup`. The session middleware re-checks on every request, and for open sign-ups also requires a verified email, because the email is what makes the personal account theirs.
- **Tree ownership is enforced in `ChatService`.** `getOwnedBranch`/`getOwnedNode` report another account's branch or node as 404, like a missing one. `createBranch`, `updateBranch`, context planning, `beginSend`, `prepareReview` and `deleteBranch` use them, and the Worker resolves every branch or node id through them before it talks to the Durable Object. One enforcement point, consistent with the tree-level checks.
- **The Durable Object trusts the account the Worker passes** (in the `/send` body, or as query parameters on its other internal routes). Those routes are internal; the Worker has already checked ownership.
- **Services take the account id.**
  - `listTrees`/`listShares` filter by it.
  - Tree-level operations (detail, update, delete, backup) and share management treat another account's rows as not found.
  - Imports are assigned to the importing account.
- **Allowlisted users always get power mode.** Each app redirects the other kind of account (`/` ↔ `/learn/`). It is the simplest rule; the owner tries simple mode with a non-allowlisted address.
- **`account_id` has no FK constraint.** SQLite cannot `ALTER TABLE … ADD COLUMN` with `REFERENCES` and a non-null default.

## Bring-your-own-key

- **User keys live only in the browser, as one AES-256-GCM-sealed HttpOnly cookie (`__Host-llmkey`).** Only the Worker has the secret (`KEY_ENCRYPTION_SECRET`). We rejected localStorage/IndexedDB, where XSS or a compromised dependency can read the key, and client-side passphrase or WebCrypto schemes, where XSS can simply call `decrypt()`.
- **One cookie holds a map of provider id → key**, not one cookie per provider. Branches pick their provider, and summaries or titles can run on another one, so every provider-calling request needs the whole set. One cookie also means one decrypt, atomic updates, and a single "forget".
- **The sealed format is `v1.` + base64url(iv ‖ ciphertext ‖ tag).** It uses a fresh 12-byte IV per seal and AAD `tangent/llmkey/v1`. The payload carries `exp`, which is enforced server-side as well as by `Max-Age`. Every failure to open it means "no key" (401 `key_required` plus clearing the cookie), never a 500.
- **User keys override server secrets per provider id** through `ProviderEnv.apiKeys`. A provider with no `apiKeySecret` becomes available once the user supplies a key.
- **The Durable Object receives the still-sealed cookie value in the internal request body** and opens it itself. The body is not logged, whereas headers may be. The plaintext key lives only in the ChatService for that generation.
- **Generations still outlive the tab.** This is the existing reconnect design, so closing the tab does not abort. The Stop button (`/cancel`) aborts the upstream request, which stops billing.
- **The proxy is the abuse boundary**, because XSS can still ride the cookie:
  - requests must be same-origin (a `same-site` subdomain is rejected too, which SameSite alone allows);
  - the model must be in the provider config;
  - `max_tokens` is server-set;
  - there are 30 generations/min per cookie, bucketed by the SHA-256 of the sealed value;
  - saving a key (which makes a verification call) is limited per account.
- **Key verification is `GET /v1/models` (Anthropic) or `GET {baseUrl}/models` (OpenAI-compatible).** Only 401/403 rejects a key; if the provider is unreachable, saving is not blocked. OpenRouter's `/models` is public, so there the check proves nothing.
- **The web app gets a strict CSP via Workers Static Assets `_headers`**: `script-src 'self'`, `connect-src 'self'`, `img-src 'self'`, Trusted Types (`angular`, `angular#bundler`). Critical-CSS inlining is off because it needs an inline script. zod runs `jitless`, because its `new Function` probe is reported as a violation.

## Deleting branches

- **Deleting a branch deletes its whole subtree.** Child branches hang off its messages, so they cannot outlive it. The trunk cannot be deleted; deleting the conversation covers that.
- **Summaries anchored on deleted messages and shares targeting them are deleted too** (in the same D1 batch). Whole-tree snapshot shares keep their frozen copy until republished or revoked.
- **Deletion goes through the tree's Durable Object.** It holds the send lock so no message lands in the doomed branches, aborts their running generations and waits for them to persist, then deletes. Without that hook (e.g. a Node port), `ChatService.deleteBranch` refuses with 409 while a reply is generating there.
- **Branch titles are editable inline in the outline** (double-click or the pencil) as well as in Branch settings; either marks the title `user` so auto-titling leaves it alone.

## Reviewer ("Review up to here")

- **A review is advice about the tree, not part of it.** It is streamed and never stored, so it can't leak into later context, shares or exports. It enters the conversation only if the user sends it, through "Add corrections to the message box". The web app keeps reviews in memory for the session.
- **The reviewer sees exactly what the reviewed model saw.** That is the branch's rendered context plan for that reply, with summaries resolved and cached as on a normal send, so a mistake caused by a lossy summary shows up as one. It is wrapped as a transcript in one user message, so the reviewer judges the replies instead of continuing the chat.
- **The verdict is a two-line trailer (`ACCURACY: OK|MINOR|MAJOR`, `RECOMMENDATION: STAY|UPGRADE`).** It is parsed leniently by `parseReview` in `@tangent/shared`, which also holds the labels that the prompt uses. We chose a text trailer over JSON/tool output so the prose streams readably on every provider. A missing trailer means no badge, never an error.
- **The client picks the reviewer's provider/model per request.** This is the one generation route where it does. The model allowlist, the server-set output cap, same-origin and the per-cookie rate limit still apply.
- **Reviews stream straight from the Worker, not through the tree's Durable Object.** There is no persisted run to reconnect to. A client disconnect aborts the upstream request.
- **The default reviewer is a browser setting (localStorage, `tangent.settings`).** It is not a secret, and every request names its model anyway. If it is unset or unusable, the branch's provider default is used. Server-side per-account settings can replace it when multi-user arrives.

## Authentication (replaced Cloudflare Access)

- **Better Auth in the Worker instead of Cloudflare Access in front of it.** Sign-in is part of the app (Google, GitHub, magic link, passkeys), it works on any host, and the Worker stays the only security boundary. Its tables live in D1 as `auth_*` (Drizzle schema, migration 0002), so its `account` model can't be confused with our `accounts`.
- **No passwords.** Email+password stays disabled; the methods are OAuth, magic link and passkeys. Passkeys are added from the Account dialog once signed in.
- **`ALLOWED_EMAILS` gates sign-in, and everyone on it shares the default account.** It replaces the Access policy. Users outside it are never created (`user.create.before` returns false, so the OAuth callback redirects to `/login?error=unable_to_create_user` instead of answering JSON), never sent a magic link (same response either way, so the form doesn't reveal who is allowed), and the middleware re-checks it on every request. `OPEN_SIGNUP=true` adds personal simple accounts for everyone else (see _Accounts_).
- **The API session check never refreshes the session.** A refresh must re-issue the cookie, which only `GET /api/auth/get-session` does; the web app calls it at startup. Refreshing in the middleware would move the database expiry while the cookie kept its old one.
- **"Remember me" for every method via an after-hook.** Better Auth only has it for email+password. Sessions start remembered (30 days, extended at most daily); when the login page's one-shot `tangent-remember` cookie isn't `1`, the hook shortens the row to 1 day and re-issues the cookie with no Max-Age plus Better Auth's signed `dont_remember` cookie. It's a cookie because the OAuth callback and magic link are top-level navigations. Missing (e.g. a link opened in another browser) means not remembered.
- **Captcha only on `/sign-in/magic-link`.** It is the one endpoint that sends email; OAuth providers run their own bot checks and passkeys can't be scripted. Without `TURNSTILE_SECRET_KEY` the plugin refuses the request (fails closed). Hostname pinning is skipped on localhost because Turnstile's test keys report their own hostname.
- **Turnstile only runs in the `/login` document, which has its own CSP.** `_headers` detaches the app-wide CSP for `/login` and allows `challenges.cloudflare.com` there, without Trusted Types (the page renders no model output). The app reaches `/login` and leaves it only by full page loads, so third-party script never runs in a document holding conversations or the key cookie's API access.
- **Better Auth's rate limiter stores counters in D1.** Memory storage would be per isolate. The client IP comes from `cf-connecting-ip`.
- **Email goes through an `EmailSender` interface** (`apps/worker/src/email/`), picked by `EMAIL_PROVIDER` in one function. Resend is called with raw `fetch` (no SDK), like the LLM providers. The `log` sender prints links to the console and is refused off localhost, since a logged magic link is a credential.
- **Magic-link tokens are stored hashed** and expire after 15 minutes.
- **`nodejs_compat` is on**, because Better Auth imports `node:async_hooks`.
- **`pnpm dev` passes `--local-upstream localhost:8787`.** Otherwise wrangler rewrites local requests to the production hostname from `routes`, and Better Auth's origin check rejects them.

## Simple mode and billing

- **A separate simple app (`apps/simple`) rather than a mode of the power app.** The owner asked for one, and a lean `LessonStore` doesn't drag the inspector, reviewer, shares and BYOK along.
- **Shared Angular code lives in `packages/web-shared`, exported as TS source.** The same convention as the other packages: both apps' Angular builders compile it AOT through the pnpm symlinks, so there is no library build. `TreeStore` and the power dialogs stay in `apps/web`.
- **The simple app is served at `/learn/` on the same origin and Worker.** Better Auth cookies, passkeys (rpID = host), OAuth callbacks, Turnstile's hostname, `PUBLIC_BASE_URL` and the CSP all stay single-origin; a second hostname would duplicate every one of them.
- **The Worker serves `/learn*` and sets its CSP itself** (`http/learn-app.ts`). SPA fallback only ever serves the root `index.html`, and `_headers` isn't applied to Worker-generated responses. A test keeps the Worker's copies identical to the `_headers` policies.
- **Both builds are assembled into `apps/worker/site/`** (`scripts/assemble-assets.mjs`, plain Node fs), not under `dist/`, so git can keep a `.gitkeep` that lets wrangler and the tests start before anything is built.
- **One server-side provider, `tangent` (OpenRouter), is the only provider in a simple account's registry.** The generic provider checks then apply unchanged. Two tiers: Smart (`deepseek/deepseek-v4-pro`) and Simple (`deepseek/deepseek-v4-flash`), both configurable; `SIMPLE_PROVIDER` replaces the whole config (tests, AI Gateway, `options.extraBody`).
- **A dedicated `OPENROUTER_SIMPLE_API_KEY`, with no fallback to `OPENROUTER_API_KEY`.** Customer spend stays separate from the owner's, and the key can carry a hard credit limit as a backstop.
- **Simple accounts get a built-in Socratic tutor prompt, capped input (`SIMPLE_MAX_INPUT_TOKENS`, 60k) and output (4,096), and summaries and titles on the fast model.** The pedagogy is server-controlled, and the caps bound the cost of any one call.
- **Simple accounts can't use BYOK and are rate limited per account.** They spend the operator's key, so the account is the abuse boundary.
- **Metering wraps the `ProviderRegistry`** (`billing/meter.ts`). Every provider call (replies, summaries, titles, reviews) goes through it, so nothing in `ChatService` changes beyond a `usageTag` on each request. Power accounts are not metered.
- **A pending `usage_events` row is written, and awaited, before every upstream call.** No row, no call; a crash can leave a row pending but never double-charge, because every settle is one conditional `UPDATE … WHERE status = 'pending'`.
- **Cost is OpenRouter's reported `usage.cost`, never a price table.** Prices drift (and differ per upstream), and the reported cost is what we pay. The generation id (`X-Generation-Id`, or a chunk `id`) is stored as soon as it is known.
- **A stream that ends without a cost is reconciled via `GET /api/v1/generation`** with retries at 1, 3, 10 and 30 s, since the endpoint 404s for a few seconds. Aborted streams never get the final usage chunk.
- **A cron every 10 minutes is the backstop.** It covers Durable Object eviction mid-stream: rows with a generation id settle from OpenRouter; rows without one after 10 minutes never reached OpenRouter and settle at $0.
- **Rows still unresolved after 24 hours become `unresolved` at $0 and are logged.** A bounded loss, for manual review, rather than holding the user's balance forever.
- **The ledger is integer micro-USD; provider cost is stored in nano-USD.** `charge = ceil(costNanos × (10000 + bps) / 10⁷)` in integer math: never rounded down, and the bias is under $0.000001 per call.
- **The balance is computed, not cached:** `Σ credit_grants − Σ settled charges`, minus pending holds for "available". Every write is one idempotent statement, so there is no cross-table atomicity to get wrong.
- **Markup is applied when usage settles, at the rate fixed when the call started:** `MARKUP_MONTHLY_BPS` (+5%) with an active subscription, else `MARKUP_PREPAID_BPS` (+10%). It is the owner's literal rule, one formula, and keeps the balance in plain pre-tax dollars. Credit bought at one rate may be spent at the other.
- **Sends need `available ≥ USAGE_HOLD_MICROS` ($0.02), else 402 `payment_required`.** A running generation is never cut off; overdraft is bounded by the caps and the hold, and the next purchase absorbs a negative balance.
- **Prepaid credit uses our own Checkout Session (`mode: 'payment'`) with `price_data` on `STRIPE_CREDITS_PRODUCT_ID`.** The plugin can't do one-time payments, and inline prices keep the $5–$500 amount server-validated.
- **Monthly plans are recurring prepaid credit, through the Better Auth Stripe plugin.** Every paid subscription invoice with a positive subtotal credits that pre-tax subtotal, which rolls over, whatever its `billing_reason` (create, cycle, a prorated update, threshold): whoever paid an invoice gets its credit, even if the Customer Portal is set up to prorate. `prorationBehavior: 'none'`, so plan switches through the plugin apply next cycle. Plan changes, cancellation, cards and invoices are all in the Stripe Customer Portal.
- **Rejected: metered (postpaid) Stripe billing.** It would need reliable meter-event delivery with retries, a reconciliation job against Stripe and spend caps against unpaid invoices, plus credit risk. Prepaid tiers need none of that and share one ledger.
- **Stripe Tax, not Managed Payments.** The owner asked for Stripe Tax. Prices are tax-exclusive, `automatic_tax` is on in both Checkout flows, and only pre-tax amounts (`amount_subtotal`, `invoice.subtotal`) enter the ledger.
- **One webhook: the plugin's `/api/auth/stripe/webhook`, with our logic in `onEvent`.** One endpoint and one secret for the operator, and the plugin keeps its subscription table in sync. Throwing from `onEvent` makes the plugin answer 400, so Stripe retries.
- **Accepted quirk: the plugin calls `subscriptions.retrieve(null)` for payment-mode `checkout.session.completed`.** It fails, is logged, and `onEvent` still runs. One wasted API call and one log line per top-up; a test asserts the credit is still granted.
- **Grants are idempotent on the Stripe object id** (`credit_grants.stripe_ref` is unique: session, invoice or refund id), so redeliveries are no-ops. Webhooks find the account by `metadata.accountId` (top-ups) or by `customer` → `auth_users.stripe_customer_id`, so grants don't depend on the plugin's row existing yet.
- **Refunds debit automatically (`charge.refunded`), one negative grant per refund.** For top-ups only the pre-tax share is debited; disputes are handled by hand with an `adjustment` grant.
- **Stripe customers are created lazily** (`createCustomerOnSignUp: false`), on the first top-up or plan checkout, with the plugin's metadata keys and an idempotency key per user. No Stripe calls for the owner or for sign-ups that never pay.
- **`stripe@^22.6.2`, not 23.** `@better-auth/stripe@1.7.7` accepts `stripe` ^18–^22 only. 22.6.2 pins API version `2026-08-26.dahlia`; the webhook endpoint is created on the same version.
- **The plugin is registered only when both Stripe secrets are set,** but its `subscription` table is always mapped, so the schema doesn't depend on configuration. Without Stripe, simple accounts can't spend.
- **Known margin problem (R1): the default markups likely lose money** after OpenRouter's ~5.5% credit fee and Stripe's fees. They are the owner's numbers, implemented exactly but as config (`MARKUP_*_BPS`), and flagged in the README.

## Landing page and demo

- **The landing page is rendered by the Worker, like the share viewer** (`http/landing.ts`): one self-contained document with no script and one constant inline stylesheet, allowed by its SHA-256 in a `default-src 'none'` CSP. It needs no Angular bundle, loads instantly and can't be broken by an app build.
- **`/` checks for the session cookie's presence, not a D1 session lookup.** The page is served on every visit to `/`, and a lookup would cost a D1 read per request. A stale or forged cookie only lands in the power app, which asks the API, gets 401 and redirects to sign in. The dev bypass (`DEV_ALLOW_NO_AUTH` without a secret) keeps `/` as the app.
- **`/` is `no-cache` with `Vary: Cookie`; `/welcome` is cached for 5 minutes.** `/` answers differently by cookie, so a browser must never reuse the landing page after sign-in. `/welcome` serves everyone the same page.
- **`/welcome` always serves the landing page,** signed in or not: an escape hatch for signed-in users, dev mode and links that must show the page.
- **The Worker sets the `_headers` `/*` CSP on the power app's `/`** when it passes the request to `ASSETS`: `_headers` doesn't apply to Worker responses, the same reason as `/learn*`.
- **The demo (`/learn/demo`) runs entirely in the browser against an in-memory `ChatService`.** It costs nothing, needs no account and sends nothing to a model, and it exercises the real tree logic (branching, context assembly, "Ask about this"). Replies come from random English sentences (`txtgen`), so nobody mistakes them for tutoring.
