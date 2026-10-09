# Operating Tangent

How to deploy and run a Tangent deployment: Cloudflare and GitHub setup, sign-in, payments, admin and the open pool. Every var and secret named here is described in [configuration.md](configuration.md). Commands run from `apps/worker` unless they say otherwise (`npx wrangler …` or `pnpm exec wrangler …`).

## What you need

- A Cloudflare account. The **Workers Paid** plan is recommended: the Free plan's 10 ms of CPU per request is tight for streaming.
- A domain on Cloudflare. Sign-in callbacks, magic links and passkeys are tied to one public origin.
- A [Resend](https://resend.com) account for magic-link email, and a Cloudflare [Turnstile](https://developers.cloudflare.com/turnstile/) widget.
- To sell credit or the membership: an [OpenRouter](https://openrouter.ai) account and a [Polar](https://polar.sh) account. Learn on the learner's own OpenRouter key needs neither.

## First deployment

1. **Log in:** `npx wrangler login`.
2. **Create the D1 database** and copy the printed `database_id` into `wrangler.jsonc` (`d1_databases[0].database_id`):
   ```bash
   npx wrangler d1 create tangent
   ```
3. **Set your own values** in `wrangler.jsonc`: the domain in `routes` (`[{ "pattern": "tangent.example.com", "custom_domain": true }]`; the edge cache for share pages only works on a custom domain), `PUBLIC_BASE_URL`, `EMAIL_FROM`, `TURNSTILE_SITE_KEY` and the `LEGAL_*` vars. Keep `"workers_dev": false`: sign-in only works on `PUBLIC_BASE_URL`.
4. **Set the secrets:**
   ```bash
   openssl rand -base64 32 | npx wrangler secret put BETTER_AUTH_SECRET
   openssl rand -base64 32 | npx wrangler secret put KEY_ENCRYPTION_SECRET
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put TURNSTILE_SECRET_KEY
   ```
   Don't set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY` in production: power mode is bring-your-own-key for every signed-in user, including you, and those secrets serve only the local dev bypass.
5. **Migrate and deploy**, by hand the first time:
   ```bash
   pnpm db:migrate:remote
   pnpm run deploy   # builds the four apps into ./site, then deploys the Worker with them
   ```
   `pnpm run deploy` is `wrangler deploy`; the build is the Worker's `build.command`. A bare `pnpm deploy` is pnpm's own command, not this script.
6. **Sign in, then make yourself an admin** ([Admin](#admin)).
7. **Set up deploys from GitHub** (next section), so later changes ship after CI passes.

## Deploying from GitHub

`.github/workflows/ci.yml` runs **Checks** (`pnpm test`, `build`, `typecheck`, `lint`, `format:check`, each run even when an earlier one fails) and **End-to-end** (`pnpm e2e`) on every pull request to `master` and every push to it. On `master` (a push, or **Run workflow**), once both pass, the **Deploy** job runs in the GitHub environment `production`:

1. It stops at once if the `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` secret is missing.
2. `wrangler deploy --dry-run` runs the build and bundles the Worker, with no secrets; a check then fails the job unless all four apps' `index.html` are in `apps/worker/site/`.
3. `scripts/deploy-config.mjs` writes `apps/worker/wrangler.deploy.json`, `wrangler.jsonc` without `build`, so the two steps that hold the token run no build and upload exactly what was checked.
4. `wrangler d1 migrations apply DB --remote` applies the new migrations.
5. `wrangler deploy` ships the Worker and its assets.

Deploys never overlap and none is cancelled midway. Re-running an old run redeploys that commit's code, but the database keeps the newest schema. For a quick revert of code only, `npx wrangler rollback` picks an earlier version.

**Migrations land while the previous release still serves,** and stay if the deploy then fails, so each must work with the code already running: expand first (new tables, nullable or defaulted columns), contract (drop or rename) in a later release.

### Setting it up (once)

1. **Cloudflare API token.** Dashboard → **My Profile → API Tokens → Create Token** → the **Edit Cloudflare Workers** template → **Use template**. Under **Permissions**, **+ Add more**: _Account_ → **D1** → **Edit** (the template doesn't include it; the deploy applies migrations with it). **Account Resources:** _Include_ → your account. **Zone Resources:** _Include_ → _Specific zone_ → your domain (every deploy publishes the custom domain again, which needs _Zone_ → **Workers Routes** → **Edit** on that zone; the template has it). **Continue to summary → Create Token**, and copy it.
2. **GitHub environment.** Repository → **Settings → Environments → New environment** → `production`:
   - **Deployment branches and tags** → _Selected branches and tags_ → add `master` only. This is a security requirement: without it, a pull request from a branch of this repository that edits `ci.yml` can run a job in `production` and read its secrets.
   - **Required reviewers** → add yourself. Every deploy then waits for your **Approve and deploy**, so nothing ships unseen.
   - **Environment secrets**: `CLOUDFLARE_API_TOKEN` (the token) and `CLOUDFLARE_ACCOUNT_ID` (on the dashboard's account home, or `npx wrangler whoami`).
3. **Branch rule on `master`**: **Settings → Rules** → a rule requiring the **Checks** and **End-to-end** status checks before merging. The workflow itself doesn't block merges.
4. **Disconnect Workers Builds** if it was ever connected: dashboard → **Workers & Pages → tangent → Settings → Build** → disconnect the repository. Otherwise it also deploys every push, untested and without migrations.

Runtime secrets and vars live on the Worker, not in GitHub.

### Database migrations

A schema change is an edit to `apps/worker/src/db/schema.ts` plus the migration drizzle-kit writes for it:

```bash
pnpm --filter @tangent/worker db:generate   # from the repo root
```

Commit the `.sql` and its `meta/` snapshot together. Never edit a migration that has been applied anywhere, and never write one by hand. `pnpm lint` fails while `schema.ts` has a change no migration has (`scripts/check-migrations.mjs`). The history starts at `0000_baseline.sql`; a database created before it is converted once with [runbooks/d1-baseline.md](runbooks/d1-baseline.md).

## Sign-in

[Better Auth](https://better-auth.com) with no passwords: Google, GitHub, a magic link by email, or a passkey. Anyone with a verified email can sign up; each user gets a power account (`p_<userId>`) and a Learn account (`u_<userId>`). Without `BETTER_AUTH_SECRET`, every `/api/*` request answers 500 (fail closed). Rotating it signs everyone out.

- **Magic links** go through Resend: verify your sending domain there and set `EMAIL_FROM` to an address on it. To use another email service, implement `EmailSender` (`apps/worker/src/email/`) and add a case to `createEmailSender`.
- **Turnstile** protects the magic-link form, the one endpoint that sends email. Create a widget for your hostname, put its site key in `TURNSTILE_SITE_KEY` and its secret in `TURNSTILE_SECRET_KEY`. Without the secret, magic-link requests are refused.
- **Google and GitHub** (optional; each appears on the login page only when both its secrets are set):
  - Google Cloud Console → _APIs & Services → Credentials_ → an OAuth client ID (_Web application_) with the redirect URI `https://<your domain>/api/auth/callback/google`.
  - GitHub → _Settings → Developer settings → OAuth Apps_ → callback URL `https://<your domain>/api/auth/callback/github`.
  ```bash
  npx wrangler secret put GOOGLE_CLIENT_ID
  npx wrangler secret put GOOGLE_CLIENT_SECRET
  npx wrangler secret put GITHUB_CLIENT_ID
  npx wrangler secret put GITHUB_CLIENT_SECRET
  ```
  An OAuth identity joins an existing user only when the provider reports the email verified.
- **Passkeys** need no setup: users add them under **Account** once signed in. The relying party is the `PUBLIC_BASE_URL` host, so passkeys stop working if the domain changes.
- **Remember me** keeps a session 30 days, extended by use; unchecked, it ends with the browser session, after a day at most.
- **Check it:**
  ```bash
  curl -i https://<your domain>/api/me             # 401 {"error":{"code":"unauthorized",…}}
  curl -i https://<your domain>/api/login-options  # the sign-in methods configured
  curl -i https://<your domain>/s/does-not-exist   # the Worker's 404 page (shares are public)
  ```

`DEV_ALLOW_NO_AUTH=true` is honoured only while `BETTER_AUTH_SECRET` is unset, and belongs in `.dev.vars` only.

## Users' own keys

With `KEY_ENCRYPTION_SECRET` set, users paste their Anthropic, OpenAI or OpenRouter key under **Keys** (**Keys & credit** where credit is sold). Learn uses only the OpenRouter key, from the same cookie.

- The Worker checks the key with one unbilled call, then seals `{ keys, exp, uid }` with AES-256-GCM into the `__Host-llmkey` cookie (HttpOnly, Secure, SameSite=Strict, 7 days). The server stores nothing, and no endpoint returns any part of a key.
- A cookie that is tampered with, expired, sealed with an older secret or sealed for another user answers `401 key_required` and is cleared. Signing out clears it too. **Rotating `KEY_ENCRYPTION_SECRET` revokes every stored key.**
- Limits: same-origin requests only, models limited to the provider config, server-side output caps, and a rate limit per key cookie.
- The trade-off: the key passes through the Worker on every request, so users trust the operator not to log it. The code never logs request headers or bodies; don't enable anything that does, such as Logpush with headers. An XSS on the origin could spend through the cookie while the page is open, but can't read the key.

The apps are served with a strict CSP (`apps/web/public/_headers`; the Worker sets the same policy on the pages it renders itself, `apps/worker/src/http/learn-app.ts`).

## Credit, membership and billing

Two things can be sold, both through Polar, the **merchant of record**: Polar sells to the user, computes, collects and remits sales tax and VAT, issues receipts, and handles disputes. The code talks to Polar through one adapter (`apps/worker/src/billing/providers/polar/`) behind a port (`apps/worker/src/billing/payments/`).

- **Tangent credit**: prepaid, on the built-in provider (OpenRouter on the operator's `BUILT_IN_API_KEY`). Learn runs on it when the learner picks **Use Tangent credit**; power lists it as **Tangent credit** after the user's own providers, with any OpenRouter model. Anyone may buy and spend it, member or not. Offered once both Polar secrets and `BUILT_IN_API_KEY` are set.
- **The membership**: $10 a year plus tax, one per user for both apps. It is required for one thing, generating on the user's own keys (Learn, power and Canvas alike), and only while `ANNUAL_FEE_ENABLED` is `true`, `POLAR_MEMBERSHIP_PRODUCT_ID` is set and `KEY_ENCRYPTION_SECRET` is set. Reading, export, settings and delete never need it. No credit comes with it.

### Setup

1. **OpenRouter key.** Create a key just for the built-in provider at <https://openrouter.ai/settings/keys>, **give it a credit limit** (the backstop if metering ever goes wrong), and `npx wrangler secret put BUILT_IN_API_KEY`. It never falls back to `OPENROUTER_API_KEY`.
2. **Polar organization.** Set everything up in the **sandbox** first (<https://sandbox.polar.sh>, its own organization, token, products and webhook), then in production. Polar reviews new accounts, and an AI tutoring product is a restricted category, so start the review early.
   - **A credits product**: one-time, in USD. Its own price doesn't matter: each top-up opens a checkout with an ad-hoc price for the amount chosen. Its id goes in `POLAR_CREDITS_PRODUCT_ID`.
   - **The membership** (optional): recurring yearly, $10.00, tax **exclusive**. Its id goes in `POLAR_MEMBERSHIP_PRODUCT_ID`.
   - **Make both products Private.** A purchase from Polar's public storefront carries no user id, so the webhook would have no one to credit.
   - **Customer portal** (_Settings → Customer portal_): turn **off** plan changes, seat management, subscription pause, email address changes and metered usage. A cancel there runs the membership to the end of the paid year; check once in the sandbox that the billing page still shows it active after cancelling.
   - **Webhook endpoint** (_Settings → Webhooks_, format **Raw**): `https://<your domain>/api/webhooks/polar`, with the events `order.paid`, `refund.created`, `refund.updated`, `subscription.created`, `subscription.updated`, `subscription.active`, `subscription.canceled`, `subscription.uncanceled`, `subscription.revoked`, `subscription.past_due`. Polar has no dispute webhooks: the 10-minute cron polls disputes.
   - **An organization access token** (_Settings → Developers_) with `checkouts:write`, `customer_sessions:write`, `customers:read`, `customers:write`, `orders:read`, `subscriptions:read`, `subscriptions:write`, `disputes:read`. Ask Polar support to enable disputes if listing them is refused.
3. **Polar secrets.** Payments are on only when both are set:
   ```bash
   npx wrangler secret put POLAR_ACCESS_TOKEN     # polar_oat_… of the production organization
   npx wrangler secret put POLAR_WEBHOOK_SECRET   # whsec_… of the endpoint above
   ```
   Set `POLAR_SERVER` to `production` in `wrangler.jsonc` (unset, it is the sandbox).
4. **Membership.** Set `POLAR_MEMBERSHIP_PRODUCT_ID` and `ANNUAL_FEE_ENABLED: "true"`. Optionally, a waiver code for friends: `npx wrangler secret put MEMBERSHIP_WAIVER_CODE`.
5. **Deploy**, then **check it**: sign in at `/learn/`, subscribe (in the sandbox, card `4242 4242 4242 4242`), see it active on the billing page, choose **Use Tangent credit**, buy $5 and watch the balance go down as you chat. Polar's webhook settings show every delivery; the Worker logs `payment_webhook_failed` when one fails. **Polar disables an endpoint after 10 consecutive failures**, so alert on that log line and on Polar's "endpoint disabled" email.

### How pricing works

- **The rule:** users pay the operator's true cost plus one markup, +10% (`MARKUP_BPS`). True cost passes two fees through: OpenRouter's credit-purchase fee is added to each call (`OPENROUTER_FEE_BPS`, 5.5%), and Polar's fee is deducted from each purchase (the fee Polar reports for the order, else an estimate from `POLAR_FEE_BPS` and `POLAR_FEE_FIXED_CENTS`, logged `fee_estimated`).
- **Charges:** every call on the built-in provider (replies, summaries, titles, reviews, Compare answers) is charged `ceil(cost × (1 + fee) × (1 + markup))` in micro-dollars, where `cost` is what OpenRouter reports. Rates are fixed when the call starts.
- **Top-ups:** $5 to $500 through Polar's checkout; the credit is the pre-tax amount minus Polar's fee, once per order. Example: $5 plus tax, Polar's fee about $0.77, credit about $4.23; a reply OpenRouter reports at $0.0010 costs $0.0010 × 1.055 × 1.10 ≈ $0.00116. Small top-ups lose more to Polar's fixed fee.
- **Holds:** each call holds its worst case at its model's price until it settles, never less than $0.02. A reply is held at its whole input limit and reply cap before its prompt exists: about $0.37 available for a Max reply at the defaults, about $0.02 for Normal. Short of that, the API answers 402 `payment_required`, naming the amount. At most 6 replies, reviews and Compare answers per user may be in flight on credit at once (429 beyond). A model OpenRouter lists no price for can't run on credit.
- **Stopped and lost replies:** stopping still costs what OpenRouter billed. A stream that ends without a cost is looked up at OpenRouter, and a 10-minute cron settles anything left; a call still unknown after 24 hours is marked `unresolved` at $0 and logged.
- **Refunds:** refund in the Polar dashboard; the Worker debits the refunded pre-tax amount once the refund succeeds. Polar keeps its fee on a refund, so an unspent top-up refunded in full leaves the balance negative by that fee. Refunding a membership payment changes no balance; revoke the subscription too if it should end. Disputes of top-ups are polled and debited like a refund, credited back if won, and a lost one also suspends the buyer's pool access. Disputes of membership payments are handled by hand in Polar.
- **Web search** on credit costs about $0.007 at OpenRouter per searched reply (about $0.0081 after fee and markup), billed with the reply. Automatic searches stop for the day after `GROUNDING_AUTO_DAILY_CAP` per user.
- **Bounds:** a credit call sends at most `BUILT_IN_MAX_INPUT_TOKENS` (60,000) input tokens and 16,384 output tokens, and credit calls are rate limited per user (30 a minute).

`/pricing` (`apps/worker/src/http/pricing-page.tsx`) states all this for visitors, built from the config. Its plan cards and comparison table have a column for each way to pay this deployment offers: **Free** always (the open pool while it is on, and the user's own keys while no membership is required), **Pay as you go** while credit is sold, and **Your own key** while the membership is required. The pool rows show only while the pool is on, and web search only while `GROUNDING` isn't `off`.

### Manual credit and waivers

Admins credit or debit a user, or the pool, from the [admin page](#admin), or through the API:

```bash
# POST /api/admin/credit (admins only, same-origin)
{ "target": "personal", "userId": "<userId>", "amountCents": 500, "mode": "adjustment",
  "idempotencyKey": "goodwill-2026-10-05", "note": "Goodwill" }
```

`target` is `personal` (`userId` required) or `pool`; `amountCents` is signed (−50000 to 50000, never 0); repeating an `idempotencyKey` changes nothing. A negative pool adjustment never takes the pool below 0. `"mode": "simulated_purchase"` credits as a purchase would, without a fee, and exists only while `DEV_PURCHASES_ENABLED` is `true` (never in production).

The same in SQL (an amount in micro-dollars, `5000000` = $5, negative to debit; the ledger is `u_<userId>` in both apps, `default_simple` for the dev bypass; debit the pool through the API, which keeps it from going negative). Use `--local` for the local database:

```bash
npx wrangler d1 execute DB --remote --command "SELECT 'u_' || id AS ledger_id, email FROM auth_users"
npx wrangler d1 execute DB --remote --command "INSERT INTO credit_grants (id, account_id, kind, amount_micros, provider_ref, note, created_at) VALUES (lower(hex(randomblob(16))), 'u_<userId>', 'adjustment', 5000000, NULL, 'Manual credit', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
```

A **waived** user (`auth_users.membership_waived = 1`) needs no membership. Set it on the admin page (**Member**), or let friends redeem the `MEMBERSHIP_WAIVER_CODE` on the billing page. If the code leaks, change the secret (empty stops redemption) and clear the flag of whoever shouldn't have it:

```bash
npx wrangler d1 execute DB --remote --command "SELECT id, email, membership_waived_at FROM auth_users WHERE membership_waived = 1"
npx wrangler d1 execute DB --remote --command "UPDATE auth_users SET membership_waived = 0 WHERE email = 'friend@example.com'"
```

### Testing billing locally

- **Offline:** "Option C" in `apps/worker/.dev.vars.example` (a fake built-in provider that reports a fixed cost, and `PERSONAL_CREDIT_ENABLED=true`). The dev bypass is an admin, so `POST /api/admin/credit` grants credit (to `default_simple`) or tops up the pool. Then pick **Use Tangent credit** at <http://localhost:8787/learn/>.
- **Polar sandbox:** put the sandbox values in `.dev.vars` (`POLAR_SERVER=sandbox`, `POLAR_ACCESS_TOKEN`, the product ids), run `cloudflared tunnel --url http://localhost:8787`, point a sandbox webhook at `https://<random>.trycloudflare.com/api/webhooks/polar` with the events above, set its secret as `POLAR_WEBHOOK_SECRET`, restart `wrangler dev`, and pay with `4242 4242 4242 4242`.
- **Real models:** add `BUILT_IN_API_KEY` (and remove `BUILT_IN_PROVIDER`), on a key with a small credit limit.

## The open pool

Free credit Tangent provides, for Learn users who can't pay; nobody can buy it. Turn it on with `POOL_ENABLED: "true"` (it also needs `BUILT_IN_API_KEY`), and fund it with admin adjustments (target `pool`). Pool replies are charged at true cost with no markup.

- **Limits**, the same for everyone: 30 replies and $0.10 a day per user, 60 and $0.30 per network, and for everyone together the lower of $5 and 20% of the day's base (the balance at 00:00 UTC plus what was added since); 6 replies a minute per user, 20 per network. One model (`POOL_MODEL`, default Normal's model at low effort), 8,192-token replies, no web search, no Compare or reviews. All are `POOL_*` vars.
- **The ceiling hold** of one reply (`POOL_MAX_INPUT_TOKENS` in and `POOL_MAX_OUTPUT_TOKENS` out at the model's price) must fit under the daily spend caps, or the pool reports itself off and logs `pool_misconfigured`.
- **Access:** signed in, a Turnstile pass on record (a first pool message without one goes through `/verify` once), one pool account per mailbox, and not suspended. A lost dispute suspends; an admin can lift it.
- **Where it shows:** the landing page's meter (about how many learning sessions it covers), `/pool` (how it works, with this deployment's model and caps), and the billing page of both apps. Spending is Learn-only. No page may call it a donation (tests check every pool page).
- **Watch it:** every refusal is logged as one `pool_refused` line. A breaker refuses every reservation when settled charges exceed their holds by more than $0.20 in a day (`pool_breaker_tripped`): a price in the table is below what calls really cost.

## Admin

`/admin/` (`apps/admin`) is for the operator. Admins are the user ids in the `ADMIN_USER_IDS` secret: sign in, copy your **Account ID** from the account dialog, then `npx wrangler secret put ADMIN_USER_IDS` (comma-separated for several). To everyone else, `/admin*` and `/api/admin/*` answer 404.

The page lists users (newest first, searchable by email) and lets you:

- allow users to publish share links while `DMCA_AGENT_REGISTERED` is off (**May share**); the check runs on every view of a link, so turning a user off takes their links down at once;
- see a user's shares and **Revoke** any of them (how to act on a takedown notice);
- see a user's credit balance and add or take back credit (**Credit**);
- waive the membership (**Member**);
- suspend or restore a user's open pool access (**Pool suspended**), and see who uses the pool most;
- see the pool's balance, pending holds and the breaker, and top it up or correct it.

The API behind it also reports pool consumption: `GET /api/admin/pool/usage?days=7&limit=50` lists users by spend and today's network keys by the number of users on each (many accounts on one key is what a farm looks like).

Optionally, put a Cloudflare Access application in front of `<your domain>/admin` and `<your domain>/api/admin` as a second layer. Don't move the admin app to a subdomain: the session cookie belongs to the main origin.

## Observability

Workers Logs is on (`observability` in `wrangler.jsonc`). The Worker logs one JSON event per line (`apps/worker/src/log.ts`): `llm_call` for every metered call (funding, model, tokens, cost, finish reason), `pool_refused`, `payment_webhook_failed`, `fee_estimated`, `pool_misconfigured`, `pool_breaker_tripped` and others. Nothing logs request headers or bodies.
