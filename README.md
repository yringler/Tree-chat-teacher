# Tangent — branching LLM chat

Tangent is a self-hosted chat app for having tree-shaped conversations with LLMs. It runs on **Cloudflare Workers + D1 + Durable Objects** and has two **Angular** UIs: a full-featured power app and a simple "Learn" tutor. Anyone can sign up, and every user can switch between the two at any time.

In a normal chat, digging into a side topic pollutes the main thread, and starting a new chat loses the connection to where the question came from. In Tangent any message can spawn any number of **branches**:

- Each branch has a **context mode** that decides what the model sees:
  - `path`: everything its parent saw, plus the branch's own messages.
  - `summary`: a cached summary of the parent context.
  - `independent`: only the highlighted quote or topic.
- The **Context Inspector** shows exactly what will be sent to the model, and why.
- **Review up to here** (on any assistant reply, or `v`) sends the conversation, as the model saw it, to a reviewer model of your choice (default in **Settings**). The reviewer lists corrections and says whether to continue on a stronger model. One click moves the branch to the reviewer's model, branches off on it, or puts the corrections in the message box.
- Conversations can be shared as read-only links (the whole tree, one subtree, or one path; as a frozen snapshot or live). They can also be exported as Markdown or as one self-contained HTML file.

## Two ways to use Tangent

|          | Power mode                                                                              | Learn mode ("simple")                                                                                                        |
| -------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| URL      | `/` (`apps/web`)                                                                        | `/learn/` (`apps/simple`)                                                                                                    |
| Who      | Anyone who signs in with a verified email. Account `p_<userId>`                         | The same users. Account `u_<userId>`, with its own conversations                                                             |
| Models   | Every configured provider and model, on the user's own keys (bring-your-own-key)        | Two tiers, **Smart** and **Simple**, on OpenRouter                                                                           |
| Controls | All of them: context modes, inspector, reviewer, system prompt, shares, export, backups | Nothing to configure: a built-in tutor prompt, tangents after every answer, "Ask about this" branches, a Smart/Simple toggle |
| Cost     | Your own provider keys, unmetered                                                       | Your own OpenRouter key, unmetered; or, where the operator sells it, paid credit (see below)                                 |

**How Tangent answers.** New conversations in both apps start with the same built-in system prompt (`DEFAULT_SYSTEM_PROMPT` in `packages/shared/src/default-prompt.ts`). It answers the question asked, directly and in depth, and never quizzes the user: whatever they don't follow, they branch into. Every substantive reply ends with a `<tangents>` block of two to four directions to explore next ("Why ice is less dense than water — …"). Both apps keep that block out of the rendered reply and show it as buttons under the message; tapping one creates a `path` branch titled after the tangent and sends the title as its first message (the parser is `splitTangents` in `packages/shared`). The block stays in the stored message, so the model sees what it already offered; shares and exports show it as a plain "Where next?" list.

- **Power mode:** **Settings** → **Default system prompt** sets your own prompt for new conversations, saved to your account (`GET`/`PATCH /api/settings`, table `account_settings`), so it follows you to every device. **Use default** copies the built-in prompt into the editor to edit from; an empty editor means the built-in one. A conversation's own prompt (**Conversation settings**) overrides it for that conversation; clear it there for a conversation without a system prompt.
- **Learn:** the operator can replace the built-in prompt with `SIMPLE_SYSTEM_PROMPT`; learners have no prompt editor.

### Experimental: Canvas (for the brave)

A third UI, **Tangent Canvas** at `/canvas/` (`apps/canvas`), takes branching as far as it goes. It is a view of the **power** account's conversations (same account `p_<userId>`, same keys, same API, no header of its own), so anything started in Power mode can be opened on the canvas and the other way round. Instead of one branch at a time:

- **Every branch is a lane on one pannable, zoomable surface.** A lane hangs to the right of the message it forks from, connected by a curve whose stroke is its context mode (solid for `path`, dashed for `summary`, dotted and cut short for `independent`). The layout is a contour sweep in `apps/canvas/src/app/layout/layout.ts` over the lanes' measured heights.
- **Every lane has its own message box and streams on its own.** Any number of lanes can generate at once (the server only refuses a send into a branch whose last reply is still streaming); the bar counts how many are writing.
- **Branch into variants.** The branch button on any message opens one lane, or several at once, each with its own context mode and model, and an optional first message sent to all of them in parallel ("Every context mode" opens the same question three ways, side by side).
- **Lineage.** With the selected lane, the canvas asks the context planner (`GET /api/branches/:id/context`, summaries not generated) what the model would see and lights those cards up; cards that reach the model only through a summary are marked, dropped ones too, and everything else dims. The lane head shows the plan's token budget.
- **Fold** any lane's subtree into a capsule; a minimap and keyboard navigation (`?` lists it) cover the rest.

It is marked experimental in the app and in the **Power | Learn | Canvas** switch. There is no reviewer, no share or export UI and no settings editor there yet; use Power mode for those. Its demo runs at `/canvas/demo` over the power demo's in-browser backend.

**Switching modes.** All apps show a **Power | Learn | Canvas** switch (the sidebar of the power app, the header of Learn). It is a link to the other app: one sign-in covers both. Each user has one account per mode, so power conversations and Learn lessons are kept apart (a Learn lesson runs on the tutor's provider, which the power app doesn't have, and the reverse). The app tells the API which mode it is with the `x-tangent-mode` header.

**How Learn pays.** In Learn, **How replies are paid for** (account menu) offers:

- **Use my own OpenRouter key.** The key is stored like any bring-your-own-key (a sealed cookie, the same one power mode uses, so one OpenRouter key serves both apps). Nothing is metered, there is no balance check, and the operator's key is never used.
- **Use paid credit** (pay as you go: true provider cost + 10%, 5% on a monthly plan, tax on top; see [How pricing works](#how-pricing-works)). Offered only when the operator has set up Stripe and `OPENROUTER_SIMPLE_API_KEY`. Without them (for example a self-hosted install) Learn runs on the learner's own key only and the paid option is hidden.

**Server keys.** Anyone can sign up, so the server-side keys of the power-mode providers (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or whatever `PROVIDERS` names) are never used for a signed-in user: power mode is bring-your-own-key for everyone. Those secrets serve only the local dev bypass (`DEV_ALLOW_NO_AUTH`), so leave them unset in production. `OPENROUTER_SIMPLE_API_KEY` only ever serves paid Learn mode.

Two public pages sit in front of both apps:

- **Landing page.** Anonymous visitors to `/` get a marketing page instead of the power app: what Tangent is, the two modes, and links to the demo, Learn sign-in (`/learn/login`) and power sign-in (`/login`). "Anonymous" means no Better Auth session cookie (`tangent.session_token`, or `__Secure-tangent.session_token` on https) and not the local dev bypass; with a cookie, `/` is the power app as before. `/welcome` always serves the page, signed in or not. The Worker renders it (`apps/worker/src/http/landing.ts`): one HTML document, no JavaScript, one inline stylesheet allowed by a hash-based CSP.
- **Free demo at `/learn/demo`.** The Learn interface running entirely in the browser: no sign-in, no model calls, and its state lives only in the browser tab. Replies are generated from random English sentences (the `txtgen` package), so they are playful nonsense, but branching, "Ask about this", the tangents under each reply and the tree all behave as in the real app. The power app has the same demo at `/demo` (without shares, keys or server-made exports), and the Power / Learn switch moves between the two demos. Both run on the in-browser backend in `@tangent/web-shared/demo`.

Design docs:

- [docs/PLAN.md](docs/PLAN.md): architecture, data model, interfaces, the context algorithm and portability.
- [docs/DECISIONS.md](docs/DECISIONS.md): one-line decision log.
- [docs/RESEARCH.md](docs/RESEARCH.md): research notes, with sources.
- [docs/DEFERRED.md](docs/DEFERRED.md): known gaps and follow-ups left out of a change, with what fixing them takes.

```
packages/shared     domain types, API + SSE contract (zod), share DTO
packages/core       context assembly (pure), tree utils, share projection, services, repository ports
packages/providers  Anthropic, OpenAI-compatible (OpenAI/OpenRouter/…), Fake — raw fetch + SSE
packages/render     markdown → safe HTML, self-contained viewer page, Markdown export
packages/web-shared Angular code shared by the apps: API client, auth, billing client, SSE, markdown, login page, base styles
apps/worker         Hono API, D1 repositories, TreeSession Durable Object, Better Auth, email, share routes, billing
apps/web            Power app at /: Angular 22 (standalone, signals, zoneless)
apps/simple         Simple "Learn" app at /learn/: Angular 22
apps/canvas         Experimental Canvas app at /canvas/ (a map of the power account's trees): Angular 22
```

## Requirements

- **Node ≥ 22.22.3**. Node 24 is recommended (`.nvmrc`), and the Angular 22 CLI refuses older versions.
- **pnpm 10** (`corepack enable`).
- To deploy you need a Cloudflare account. The **Workers Paid** plan is recommended: the Free plan's 10 ms CPU per request is tight for streaming.
- You also need a domain on Cloudflare: sign-in callbacks, magic links and passkeys are tied to one public origin.
- Paid Learn mode also needs an [OpenRouter](https://openrouter.ai) account and a [Stripe](https://stripe.com) account (see [Learn mode and billing](#learn-mode-and-billing)). Learn on the learner's own OpenRouter key only needs `KEY_ENCRYPTION_SECRET`.

## Local development

```bash
pnpm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # DEV_ALLOW_NO_AUTH=true (no sign-in), optional API keys
pnpm --filter @tangent/worker db:migrate:local            # create the local D1 database
pnpm dev                                                  # `wrangler dev`, which first builds both Angular apps
```

Open <http://localhost:8787>. Without any API keys, use the **Fake (offline)** provider, which echoes deterministic replies, so the whole app works offline. To use real providers, add `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` to `apps/worker/.dev.vars`.

To try real sign-in locally, follow "Option B" in `.dev.vars.example`: it sets a `BETTER_AUTH_SECRET`, prints magic links to the `wrangler dev` console instead of emailing them (`EMAIL_PROVIDER=log`, allowed on localhost only), and uses Cloudflare's always-pass Turnstile test keys. Passkeys work on `localhost` too. `pnpm dev` runs `wrangler dev --local-upstream localhost:8787`: without that flag, wrangler rewrites requests to the production hostname from `routes`, and Better Auth rejects the mismatched origin.

For UI work with hot reload, run `pnpm --filter @tangent/worker dev` and `pnpm --filter @tangent/web start` in two terminals, then open <http://localhost:4200>. The Angular dev server proxies `/api` and `/s` to the Worker on port 8787. With real sign-in, set `PUBLIC_BASE_URL=http://localhost:4200` in `.dev.vars` so links and passkeys use that origin.

The simple app works the same way: `pnpm --filter @tangent/simple start` serves it on <http://localhost:4201/learn/> (`ng serve --serve-path /learn/ --port 4201`, same proxy). The dev bypass acts as the `default` account in power mode and `default_simple` in Learn; to try paid credit offline, see "Option C" in `.dev.vars.example` and [Testing billing locally](#testing-billing-locally). With real sign-in on the dev server, set `PUBLIC_BASE_URL=http://localhost:4201`.

The canvas app too: `pnpm --filter @tangent/canvas start` serves it on <http://localhost:4202/canvas/> (`ng serve --serve-path /canvas/ --port 4202`, same proxy), acting as the `default` power account.

**Build layout.** `pnpm build` builds the power app, the simple app and the canvas app, then runs `scripts/assemble-assets.mjs`, which copies them into the Worker's static assets directory. `wrangler.jsonc` sets it as the Worker's `build.command`, so every `wrangler deploy` and `wrangler dev` runs it first (and `wrangler dev` reruns it when the apps' sources change):

```
apps/web/dist/web/browser/**        → apps/worker/site/         served at /
apps/simple/dist/simple/browser/**  → apps/worker/site/learn/   served at /learn/
apps/canvas/dist/canvas/browser/**  → apps/worker/site/canvas/  served at /canvas/
```

`apps/worker/site/` is git-ignored except for a `.gitkeep`, so `wrangler dev` and the tests start before anything is built. The power app's deep links come straight from Workers Static Assets (SPA fallback). `/` (exact path) and `/welcome` run the Worker first: `apps/worker/src/http/landing.ts` serves the landing page there, and passes `/` to the power app's `index.html` when the request carries a session cookie or the dev bypass is on. `/learn` and `/learn/*` run the Worker first (`run_worker_first`): `apps/worker/src/http/learn-app.ts` serves files as they are and every other path as the simple app's `index.html`, because the SPA fallback only ever serves the root `index.html`.

Checks:

```bash
pnpm test        # Vitest in every package; the worker suite runs inside workerd with real D1 + Durable Objects
pnpm typecheck   # tsc everywhere (+ Angular strict templates)
pnpm lint        # ESLint (typescript-eslint strict)
```

## Deploying

All commands run from `apps/worker` (use `npx wrangler …` or `pnpm exec wrangler …`).

1. **Log in**
   ```bash
   npx wrangler login
   ```
2. **Create the D1 database**, then copy the printed `database_id` into `wrangler.jsonc` (`d1_databases[0].database_id`):
   ```bash
   npx wrangler d1 create tangent
   ```
3. **Apply migrations** to the remote database:
   ```bash
   pnpm db:migrate:remote
   ```
4. **Let users bring their own keys.** Anyone can sign up, so this is how most people use power mode (and Learn, unless you sell credit). Set the key-sealing secret ([Bring your own key](#bring-your-own-key)):
   ```bash
   openssl rand -base64 32 | npx wrangler secret put KEY_ENCRYPTION_SECRET
   ```
   **Don't set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY` in production.** Power mode is bring-your-own-key for every signed-in user, including you; those secrets are used only by the local dev bypass (`.dev.vars`). If they are already set, `npx wrangler secret delete <name>` removes them.
5. **Attach a custom domain.** Add this to `wrangler.jsonc`:
   ```jsonc
   "routes": [{ "pattern": "tangent.example.com", "custom_domain": true }]
   ```
   The edge cache for share pages only works on a custom domain.
6. **Deploy.** This builds both Angular apps, assembles them into `apps/worker/site/` and deploys the Worker together with the static assets. `pnpm run deploy` and `npx wrangler deploy` are the same thing: the build is the Worker's `build.command` in `wrangler.jsonc`. Workers Builds ignores that key, so a Git-connected deploy needs the settings in [Deploying from Git](#deploying-from-git). A bare `pnpm deploy` is pnpm's own built-in command, not this script.
   ```bash
   pnpm run deploy
   ```
   Do not use `workers_dev: true` in production (see step 8 of "Sign-in" below).

### Deploying from Git

Workers Builds (the Worker's **Settings → Build**, connected to this repository) doesn't run `build.command` from `wrangler.jsonc`. Without its own build step it deploys an empty `apps/worker/site/`, and every static file 404s. Use:

| Setting                              | Value                                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Root directory                       | `/` (the repository root, so the install covers the whole pnpm workspace and `.nvmrc` applies) |
| Build command                        | `pnpm build`                                                                                   |
| Deploy command                       | `pnpm --filter @tangent/worker exec wrangler deploy`                                           |
| Non-production branch deploy command | `pnpm --filter @tangent/worker exec wrangler versions upload`                                  |

Runtime secrets and variables are unaffected: they live on the Worker, not in the build settings.

### Sign-in (required)

Sign-in uses [Better Auth](https://better-auth.com) with **no passwords**: Google, GitHub, a magic link by email, or a passkey. The Worker **fails closed**: every `/api/*` request returns 500 until `BETTER_AUTH_SECRET` is set. Once it is, **anyone can sign up** with a verified email; Turnstile and the rate limits on magic links bound abuse.

1. **Session secret.** It signs session cookies; rotating it signs everyone out.
   ```bash
   openssl rand -base64 32 | npx wrangler secret put BETTER_AUTH_SECRET
   ```
2. **Public origin.** Set `PUBLIC_BASE_URL` in `wrangler.jsonc` to your origin. Every user gets their own accounts (`p_<userId>` for power, `u_<userId>` for Learn; see _Accounts_ in [DECISIONS.md](docs/DECISIONS.md)), and every tree, branch, message and share is scoped to them. Users are only created with a verified email (Google and GitHub report it, a magic link proves it). There is no list of emails anywhere.
3. **Email (magic links) through [Resend](https://resend.com).** Verify your sending domain in Resend, set `EMAIL_FROM` in `wrangler.jsonc` to an address on it, then:
   ```bash
   npx wrangler secret put RESEND_API_KEY
   ```
   Email goes through the `EmailSender` interface (`apps/worker/src/email/`). To switch providers, add a class implementing it and a case in `createEmailSender`, then set `EMAIL_PROVIDER`.
4. **Captcha ([Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/)).** It protects the magic-link form, the one endpoint that sends email. Create a widget for your hostname in the Cloudflare dashboard, put its site key in `TURNSTILE_SITE_KEY` (`wrangler.jsonc`), and:
   ```bash
   npx wrangler secret put TURNSTILE_SECRET_KEY
   ```
   Without the secret, magic-link requests are refused.
5. **Google and GitHub (optional; each one appears on the login page only when configured).**
   - Google: in Google Cloud Console → _APIs & Services → Credentials_, create an OAuth client ID (_Web application_) with the redirect URI `https://tangent.example.com/api/auth/callback/google`.
   - GitHub: in _Settings → Developer settings → OAuth Apps_, create an app with the callback URL `https://tangent.example.com/api/auth/callback/github`.
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   ```
   Signing in with Google, GitHub or a magic link for the same email lands on the same user.
6. **Passkeys** need no setup: once signed in, open **Account** in the sidebar and add one on each device. The relying party is the `PUBLIC_BASE_URL` host, so passkeys stop working if the domain changes.
7. **Remember me.** Checked, the session lasts 30 days and is extended by use. Unchecked, the cookie ends with the browser session and the session expires after a day at most.
8. Keep `"workers_dev": false` so the `*.workers.dev` URL is not reachable: sign-in only works on `PUBLIC_BASE_URL`.
9. **Verify.**
   ```bash
   curl -i https://tangent.example.com/api/me             # 401 {"error":{"code":"unauthorized",…}}
   curl -i https://tangent.example.com/api/login-options  # which sign-in methods are configured
   curl -i https://tangent.example.com/s/does-not-exist   # 404 page from the Worker (shares are public)
   ```

**Upgrading from the Cloudflare Access setup:** run `pnpm db:migrate:remote` (migration `0002_auth` adds the sign-in tables), set the secrets and vars above, deploy, then delete both Access applications ("Tangent" and "Tangent shares") in Zero Trust. Until they are deleted, Access still sits in front of the app.

**Upgrading from the allowlist (`ALLOWED_EMAILS`, `OPEN_SIGNUP`):** sign-up is now open, and allowlisted users no longer share the `default` account.

1. Migrate: `pnpm db:migrate:remote` (migration `0005_accounts_per_mode` lets each user have a power and a Learn account, and `0006_account_settings` stores each account's default system prompt).
2. Deploy: `pnpm run deploy`.
3. Remove the old allowlist: `npx wrangler secret delete ALLOWED_EMAILS`. (`OPEN_SIGNUP` is gone from `wrangler.jsonc`.)

Power mode is now bring-your-own-key for everyone, you included: add your own key under **Keys** in the sidebar. Server-side `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `OPENROUTER_API_KEY` are no longer used by any signed-in user, and you can delete them (`npx wrangler secret delete <name>`).

Conversations and shares under the old shared `default` account are **not carried over**: they stay in the database, unreachable. To keep a conversation, download its JSON backup (**Backup** in the power app) before you upgrade, then **Import** it after signing in. Learn accounts (`u_<userId>`) keep their lessons and credit.

`DEV_ALLOW_NO_AUTH=true` is honoured **only** while `BETTER_AUTH_SECRET` is unset, and it belongs in `.dev.vars` only. Never set it as a deployed variable.

### Learn mode and billing

Learn mode (`/learn/`, called "simple" in the code) is always on. Learners can run it on their own OpenRouter key at no charge, which needs only `KEY_ENCRYPTION_SECRET`. This section sets up the paid option: Learn on **paid credit** spends the operator's OpenRouter key, so each provider call is metered and charged against prepaid credit, bought through Stripe. Paid credit is offered only when both Stripe secrets and `OPENROUTER_SIMPLE_API_KEY` are set; until then Learn is own-key only and the paid option is hidden. A request on paid credit answers **402** when the balance is short; one on the learner's own key never touches the balance or the operator's key.

Users pay the operator's true cost plus the markup: the model price OpenRouter reports, grossed up by OpenRouter's fee for buying credits, then +10% (+5% on a monthly plan); and each purchase is credited net of Stripe's actual fee. The markups are configuration (`MARKUP_PREPAID_BPS`, `MARKUP_MONTHLY_BPS`) and, with both fees passed through, they are the operator's real margin. See [How pricing works](#how-pricing-works).

1. **OpenRouter key.** Create a key just for paid Learn mode at <https://openrouter.ai/settings/keys> and **give it a credit limit**: it is the backstop if anything goes wrong with metering. Paid Learn mode never falls back to `OPENROUTER_API_KEY`.
   ```bash
   npx wrangler secret put OPENROUTER_SIMPLE_API_KEY
   ```
   The tiers default to `deepseek/deepseek-v4-pro` (Smart) and `deepseek/deepseek-v4-flash` (Simple); change them with `SIMPLE_SMART_MODEL` / `SIMPLE_FAST_MODEL`. Users are billed OpenRouter's reported cost, never a price table, so price changes need no update. That cost is grossed up by `OPENROUTER_FEE_BPS` (default `550` = 5.5%), OpenRouter's fee when you buy its credits. OpenRouter's minimum fee is $0.80 a purchase, so top-ups under about $15 cost more than 5.5% (a $10 top-up costs 8%): buy credits in bulk, or set `OPENROUTER_FEE_BPS` to the rate you actually pay (`800` for $10 top-ups). `SIMPLE_PROVIDER` replaces the whole provider config (one `ProviderConfig` JSON with id `tangent`), for example to route through AI Gateway or to add `"options": { "extraBody": { "reasoning": { "effort": "low" } } }`.
2. **Stripe Dashboard.** Set these up in test mode first, then again in live mode:
   - **Stripe Tax** (_Settings → Tax_): your origin address and a registration for every place you must collect tax. Checkout fails while Tax isn't set up, because every Checkout Session enables `automatic_tax`.
   - **A credits product** (_Product catalog → Add product_), e.g. "Tangent credits", with a tax code for digital services (e.g. _General – Electronically Supplied Services_, `txcd_10000000`; pick what fits your business). It needs no price: each top-up creates its price inline. Put its id (`prod_…`) in `STRIPE_CREDITS_PRODUCT_ID`.
   - **Monthly plans** (optional): a product with the same tax code and one **recurring monthly** price per tier (e.g. $10, $20, $50), each with tax behaviour **exclusive** (tax is added on top). Their `price_…` ids go into `STRIPE_PLANS`.
   - **Customer Portal** (_Settings → Billing → Customer portal_): turn on invoice history, payment method updates, billing address and tax ID updates, cancellation **at the end of the billing period**, and plan switching between the monthly prices with **no proration** (the plans' `prorationBehavior` is `none` too, so switches apply from the next cycle). Every paid subscription invoice credits its pre-tax subtotal (less Stripe's fee) whatever its billing reason, so if you do allow proration, a prorated mid-cycle invoice is credited as well.
   - **Webhook endpoint** (_Developers → Webhooks → Add endpoint_): URL `https://tangent.example.com/api/auth/stripe/webhook`, API version **`2026-08-26.dahlia`** (the version `stripe@22.6.2` pins), and exactly these events:
     `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `charge.refunded`.
3. **Stripe secrets.** Billing is enabled only when both are set:
   ```bash
   npx wrangler secret put STRIPE_SECRET_KEY       # sk_live_… (or a restricted key)
   npx wrangler secret put STRIPE_WEBHOOK_SECRET   # whsec_… of the endpoint above
   ```
4. **Plans.** `STRIPE_PLANS` in `wrangler.jsonc` is a string holding a JSON array (`"[]"`, the default, offers no monthly plans). `name` is the plan's id in the Better Auth Stripe plugin, `label` is shown to users, and `amountCents` is only for display: the credit granted always comes from the paid invoice.
   ```json
   [
     { "name": "monthly-10", "label": "$10 / month", "priceId": "price_…", "amountCents": 1000 },
     { "name": "monthly-20", "label": "$20 / month", "priceId": "price_…", "amountCents": 2000 }
   ]
   ```
5. **Migrate and deploy.** Migration `0003_billing` adds the billing tables and `0004_fees` the fee columns. The cron trigger (`*/10 * * * *` in `wrangler.jsonc`) deploys with the Worker.
   ```bash
   pnpm db:migrate:remote
   pnpm run deploy
   ```
6. **Verify.** Sign in at `https://tangent.example.com/learn/`, choose **Use paid credit** under **How replies are paid for**, buy $5 (with test-mode keys, the [test card](https://docs.stripe.com/testing) `4242 4242 4242 4242`), and check that the balance appears and goes down as you chat. _Developers → Webhooks_ shows every delivery and its response.

#### How pricing works

- **The rule.** Users pay the operator's true cost plus a markup: **+10%** (`MARKUP_PREPAID_BPS`), or **+5%** (`MARKUP_MONTHLY_BPS`) while the user has an active monthly plan. "True cost" passes two fees through, so the markup is real margin:
  - **OpenRouter's credit-purchase fee** is added to the cost of each call (`OPENROUTER_FEE_BPS`, default 5.5%).
  - **Stripe's payment processing fee** is deducted from each purchase: the credit is what the user paid before tax, minus the exact fee Stripe reports for that payment.
- **Balance.** Each Learn account has a balance in US dollars, kept as integer micro-dollars: what the user paid before tax, less Stripe's fee on each payment, less what they have used.
- **Charges.** Every provider call (replies, summaries, titles) is charged `ceil(cost × (1 + fee bps / 10000) × (1 + markup bps / 10000))`, rounded up to the next micro-dollar, where `cost` is the model price OpenRouter reports for the call. The fee and markup are fixed when the call starts and stored with it, so changing the config never reprices past calls. Credit bought at one rate is spent at whatever rate applies when it is used.
- **Top-ups.** One-time payments of **$5 to $500** through Stripe Checkout. When Stripe reports the payment, the Worker reads the fee from the payment's balance transaction (`fee`, itemised in `fee_details`) and credits the pre-tax amount minus that fee. The billing page shows the last purchase as "paid $5.00, credit $4.52 after payment processing".
- **Monthly plans.** A subscription for a fixed amount a month. Every paid subscription invoice (the first one, every renewal, and any prorated mid-cycle invoice) credits its pre-tax subtotal minus Stripe's fee on its payment. A $0 invoice (a trial) credits nothing. Unused credit rolls over and never expires. Plan changes take effect from the next cycle. Users change plans, cancel, update cards and download invoices in the Stripe Customer Portal ("Manage billing").
- **Worked example.** A user buys **$5** of credit. Stripe Tax adds tax on top, say $0.40, so the card is charged $5.40. Stripe's fee is about 2.9% + 30¢ for the card plus about 0.5% for Stripe Tax, about $0.48 here, so the user gets about **$4.52** of credit (tax never enters the balance). A reply that OpenRouter reports at **$0.0010** is charged $0.0010 × 1.055 × 1.10 ≈ **$0.00116**. The exact fees come from Stripe and OpenRouter's current terms; check <https://stripe.com/pricing>.
- **Tax.** Prices exclude tax. Stripe Tax computes it at checkout from the billing address and adds it on top. Tax never enters the balance.
- **Holds.** Each call in flight holds `USAGE_HOLD_MICROS` (default `20000` = $0.02) until it settles. A message, review or summary can only start when the available balance (balance − holds) covers one more hold; otherwise the API answers **402 `payment_required`** and the app sends the user to the billing page. A reply that has started is never cut off, so the balance can go a few cents negative; the next purchase absorbs that.
- **Stopped and lost replies.** Stopping a reply still costs what OpenRouter billed for it. When a stream ends without a cost, the Worker asks OpenRouter's generation endpoint (with retries), and a cron every 10 minutes settles anything left over. A call that never reached OpenRouter is charged $0, and one still unknown after 24 hours is marked `unresolved` at $0 and logged for review.
- **Refunds.** Refunding a payment in Stripe debits the refunded amount (the pre-tax share for top-ups) automatically. Stripe keeps its fee on a refund, so a full refund debits the whole pre-tax amount, including the fee that was never credited; an unspent top-up refunded in full leaves the balance negative by that fee. Disputes are handled by hand in Stripe, with a manual adjustment if needed (below).
- **History.** `/learn/billing` shows the balance, top-ups, plans and recent usage (`GET /api/billing/usage`).
- **Cost bounds.** Learn sends at most `SIMPLE_MAX_INPUT_TOKENS` (default 60,000) input tokens and 4,096 output tokens per call, and on paid credit is rate limited per account (`CHAT_RATE_LIMITER`, 30 a minute).

**Manual credit or adjustments** (refund disputes, goodwill credit) are a SQL insert into `credit_grants` with `kind='adjustment'` and a signed amount in micro-dollars (`5000000` = $5; negative to debit). Find the account id first:

```bash
npx wrangler d1 execute DB --remote --command "SELECT a.id, u.email FROM accounts a JOIN auth_users u ON u.id = a.user_id WHERE a.mode = 'simple'"
npx wrangler d1 execute DB --remote --command "INSERT INTO credit_grants (id, account_id, kind, amount_micros, stripe_ref, note, created_at) VALUES (lower(hex(randomblob(16))), 'u_<userId>', 'adjustment', 5000000, NULL, 'Manual credit', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
```

Use `--local` instead of `--remote` for the local database.

#### Testing billing locally

- **Offline, no Stripe or OpenRouter.** Use "Option C" in `apps/worker/.dev.vars.example`: a fake `SIMPLE_PROVIDER` that reports a fixed cost per call, and placeholder Stripe values so paid credit is offered. Grant yourself credit with the SQL insert above (`--local`; the account is `default_simple` with the dev bypass), choose **Use paid credit**, then chat at <http://localhost:8787/learn/>. Top-ups and plans won't work with placeholder keys.
- **Real Stripe test mode.** Put your test keys in `apps/worker/.dev.vars` (`STRIPE_SECRET_KEY=sk_test_…`, a test `STRIPE_CREDITS_PRODUCT_ID`, and test price ids in `STRIPE_PLANS`), set up Stripe Tax in test mode, and forward webhooks with the [Stripe CLI](https://docs.stripe.com/stripe-cli):
  ```bash
  stripe login
  stripe listen --forward-to localhost:8787/api/auth/stripe/webhook
  ```
  `stripe listen` prints a `whsec_…` signing secret; set it as `STRIPE_WEBHOOK_SECRET` and restart `wrangler dev`. The CLI formats events with your account's default API version; if that is older than the `dahlia` releases, add `--latest` (subscription invoices are read from `invoice.parent`, which older versions don't send). Pay with the test card `4242 4242 4242 4242`. `stripe trigger` events don't carry the metadata a top-up needs, so go through Checkout from the app instead.
- **Real models.** Add `OPENROUTER_SIMPLE_API_KEY` (and remove `SIMPLE_PROVIDER`). Use a key with a small credit limit.

#### Not included yet

These are out of scope for now. Sign-up is open to anyone, so the first two are **launch blockers** for a public deployment:

- **Terms of service and privacy policy pages.**
- **Account deletion and data export** for users (power conversations have per-tree JSON backups).
- Auto-recharge, free sign-up credit, promotion codes, trials, low-balance emails, multi-currency (USD only), and an admin UI (adjustments are the SQL insert above).
- Metered (postpaid) Stripe billing. [Stripe Managed Payments](https://docs.stripe.com/payments/managed-payments) (Stripe as merchant of record) would take tax liability off the operator, but isn't wired up.

## Configuration

| Name                                                                                   | Kind               | Purpose                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`                                                                      | var                | Public origin: share links, sign-in callbacks, magic links, passkey relying party (default: the request's origin; set it in production)                                                  |
| `EMAIL_PROVIDER`                                                                       | var                | `resend` (default) or `log` (prints emails to the console; localhost only)                                                                                                               |
| `EMAIL_FROM`                                                                           | var                | Sender address for magic links (its domain must be verified in Resend)                                                                                                                   |
| `TURNSTILE_SITE_KEY`                                                                   | var                | Cloudflare Turnstile site key for the magic-link form                                                                                                                                    |
| `PROVIDERS`                                                                            | var                | JSON array of provider configs (default: anthropic, openai, openrouter, fake)                                                                                                            |
| `SUMMARY_PROVIDER_ID`, `SUMMARY_MODEL`                                                 | var                | Cheaper model for summaries and titles, e.g. `anthropic` + `claude-haiku-4-5`. Empty = the branch's own model                                                                            |
| `AUTO_TITLE`                                                                           | var                | `false` disables automatic branch/tree titles                                                                                                                                            |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`                            | secret             | Provider keys, referenced by name from provider configs. Used only by the local dev bypass; leave unset in production                                                                    |
| `AI_GATEWAY_TOKEN`                                                                     | secret             | Optional, for an authenticated AI Gateway                                                                                                                                                |
| `BETTER_AUTH_SECRET`                                                                   | secret             | Signs session cookies (`openssl rand -base64 32`). Required; rotating it signs everyone out                                                                                              |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | secret             | OAuth apps; each provider is offered only when both of its values are set                                                                                                                |
| `TURNSTILE_SECRET_KEY`                                                                 | secret             | Turnstile secret; without it magic-link sign-in is refused                                                                                                                               |
| `RESEND_API_KEY`                                                                       | secret             | Resend API key for magic-link emails                                                                                                                                                     |
| `KEY_ENCRYPTION_SECRET`                                                                | secret             | 32 random bytes, base64 (`openssl rand -base64 32`). Enables bring-your-own-key; rotating it revokes every stored user key                                                               |
| `CHAT_RATE_LIMITER`, `KEY_RATE_LIMITER`                                                | rate limit binding | Requests spending a user key (30/min per key cookie) or, for Learn on paid credit, the operator's key (30/min per account); key saves (10/min per account)                               |
| `OPENROUTER_SIMPLE_API_KEY`                                                            | secret             | OpenRouter key for paid Learn mode (provider `tangent`). Give it a credit limit in OpenRouter. No fallback to `OPENROUTER_API_KEY`, never used by power mode                             |
| `SIMPLE_SMART_MODEL`, `SIMPLE_FAST_MODEL`                                              | var                | OpenRouter models of the Smart and Simple tiers (default `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-flash`). The fast one also writes summaries and titles                        |
| `SIMPLE_PROVIDER`                                                                      | var                | One `ProviderConfig` as JSON that replaces the simple-mode provider entirely (tests, offline dev, AI Gateway, `options.extraBody`). Default empty = OpenRouter with the two models above |
| `SIMPLE_MAX_INPUT_TOKENS`                                                              | var                | Input-token cap per simple-mode call; bounds the cost of one request (default `60000`). Output is capped at 4,096 tokens                                                                 |
| `SIMPLE_SYSTEM_PROMPT`                                                                 | var                | Built-in prompt of new Learn trees with none saved (default empty = `DEFAULT_SYSTEM_PROMPT` in `packages/shared`). Learn only: power users set their own in Settings                     |
| `USAGE_HOLD_MICROS`                                                                    | var                | Micro-dollars held per call in flight, and the minimum available balance to start one (default `20000` = $0.02)                                                                          |
| `OPENROUTER_FEE_BPS`                                                                   | var                | OpenRouter's credit-purchase fee in bps, added to the reported cost of each simple-mode call before the markup (default `550` = 5.5%; raise it for OpenRouter top-ups under ~$15)        |
| `MARKUP_PREPAID_BPS`, `MARKUP_MONTHLY_BPS`                                             | var                | Margin on the true provider cost in basis points, without / with an active monthly plan (default `1000` = +10%, `500` = +5%)                                                             |
| `STRIPE_SECRET_KEY`                                                                    | secret             | Stripe API key. Billing is enabled only when this and `STRIPE_WEBHOOK_SECRET` are set                                                                                                    |
| `STRIPE_WEBHOOK_SECRET`                                                                | secret             | Signing secret of the webhook endpoint `/api/auth/stripe/webhook`                                                                                                                        |
| `STRIPE_CREDITS_PRODUCT_ID`                                                            | var                | Stripe product (with a tax code) that one-time top-ups are sold as (default empty = no top-ups)                                                                                          |
| `STRIPE_PLANS`                                                                         | var                | Monthly plans as JSON `[{ "name", "label", "priceId", "amountCents" }]` (default `[]` = none)                                                                                            |
| `triggers.crons`                                                                       | cron trigger       | `*/10 * * * *`: settles usage whose cost the stream didn't report (`apps/worker/src/billing/reconcile.ts`)                                                                               |
| `DEV_ALLOW_NO_AUTH`                                                                    | `.dev.vars` only   | Skip sign-in locally (only while `BETTER_AUTH_SECRET` is unset)                                                                                                                          |

**Routing.** `assets.run_worker_first` in `wrangler.jsonc` lists the paths the Worker sees before Workers Static Assets: `/api/*`, `/s/*`, `/learn`, `/learn/*`, `/` and `/welcome`. Keep `/` an exact path (not `/*`), or every asset request would run the Worker. In local dev with `DEV_ALLOW_NO_AUTH=true`, `/` is the app; open `/welcome` to see the landing page.

**Providers.** Each provider instance in `PROVIDERS` has `id`, `kind` (`anthropic` | `openai-compatible` | `fake`), `label`, `models`, `defaultModel` and `apiKeySecret`. It can also take `baseUrl`, `headers`, `extraHeaderSecrets`, `maxContextTokens`, `maxOutputTokens`, `supportsSystemPrompt` and `options`. Any OpenAI-compatible endpoint is config only:

```json
[
  {
    "id": "anthropic",
    "kind": "anthropic",
    "label": "Anthropic",
    "apiKeySecret": "ANTHROPIC_API_KEY",
    "defaultModel": "claude-opus-5-5",
    "models": [
      { "id": "claude-opus-5-5", "label": "Claude Opus 5.5" },
      { "id": "claude-haiku-4-5", "label": "Claude Haiku 4.5" }
    ]
  },
  {
    "id": "openrouter",
    "kind": "openai-compatible",
    "label": "OpenRouter",
    "baseUrl": "https://openrouter.ai/api/v1",
    "apiKeySecret": "OPENROUTER_API_KEY",
    "defaultModel": "anthropic/claude-sonnet-5.5",
    "models": [{ "id": "anthropic/claude-sonnet-5.5", "label": "Claude Sonnet 5.5" }]
  }
]
```

**AI Gateway (optional).** It gives you logging, analytics and retries. Point `baseUrl` at the gateway:

- Anthropic: `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic`
- OpenRouter: `…/openrouter/v1`

For an authenticated gateway, add `"extraHeaderSecrets": { "cf-aig-authorization": "AI_GATEWAY_TOKEN" }` and store `Bearer <token>` in that secret. Gateway caching does not apply to streamed chat, so it is off.

### Bring your own key

With `KEY_ENCRYPTION_SECRET` set, users can paste their own Anthropic / OpenAI / OpenRouter key under **Keys** in the power app's sidebar. A user key overrides the server secret for that provider, for replies, summaries and titles alike. Learn mode (**How replies are paid for**) stores and uses only the OpenRouter key, from the same cookie, so one OpenRouter key serves both apps; on paid credit Learn ignores it.

- The browser sends the key once (`POST /api/key`). The Worker checks it with one unbilled provider call (`GET /v1/models`), then seals `{ keys, exp }` with AES-256-GCM and returns it as `__Host-llmkey` (`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`). The server stores nothing. Page scripts can't read the cookie, and the input field is cleared as soon as the key is sent.
- Each chat request carries the cookie back. The Worker decrypts it in memory, calls the provider and streams the reply. No endpoint returns any part of a key.
- If the cookie is tampered with, expired, or sealed with an older secret, the request gets `401 key_required`, the cookie is cleared and the UI asks for the key again. **Rotating `KEY_ENCRYPTION_SECRET` revokes every stored key.**
- Limits on the proxy: same-origin requests only (`Sec-Fetch-Site`), JSON bodies only on mutations, models limited to the provider config, output tokens capped server-side, and a rate limit per key cookie.
- Trade-offs:
  - The key passes through the Worker on every request, so users trust the operator not to log it. The code never logs request headers or bodies. Keep it that way, and don't enable anything that captures them, such as Logpush with headers.
  - An XSS on the origin can spend the user's credit while the page is open, within the limits above, but it cannot extract the key.
  - Browser extensions with host permissions are out of scope.

The power app is served with a strict CSP (`apps/web/public/_headers`): `script-src 'self'`, `connect-src 'self'`, `img-src 'self'`, Trusted Types. The browser never talks to a provider directly. The simple app under `/learn/` gets the same two policies (app and login page) from the Worker (`apps/worker/src/http/learn-app.ts`), because `_headers` doesn't apply to responses the Worker generates; a test keeps the copies identical.

## Using it

This section describes the power app. The simple app at `/learn/` keeps only the essentials: a list of lessons, a chat with a Smart/Simple toggle, **Ask about this** on selected text (a new branch that keeps the conversation so far), **How replies are paid for** (your own OpenRouter key or paid credit), and, with paid credit, a **Billing** page with the balance, top-ups, monthly plans, "Manage billing" and recent usage. The **Power | Learn** switch at the top of either app opens the other one.

- **Replying** in the composer appends to the end of the current branch.
- **Branch from here** is available on any message. You can quote the text you highlighted, pick a mode, and choose a provider and model; by default a branch inherits its parent's.
- **"N branches"** under a message lists its children. Breadcrumbs and **↩ Parent message** take you back to the exact branch point.
- **Keyboard shortcuts:**

  | Keys              | Action                         |
  | ----------------- | ------------------------------ |
  | `Alt+↑` or `[`    | Go to the parent branch        |
  | `Alt+←` / `Alt+→` | Previous / next sibling branch |
  | `Alt+↓` or `]`    | First child branch             |
  | `j` / `k`         | Next / previous message        |
  | `b`               | Branch from here               |
  | `/`               | Focus the composer             |
  | `i`               | Context Inspector              |
  | `?`               | Show all shortcuts             |

- **Tangents:** a reply that ends with suggested tangents shows them under the message (**Where next?**). Clicking one branches off in `path` mode, titles the branch after it and asks it as the first message; a tangent you already followed opens its branch.
- **Settings** (sidebar): your **default system prompt** for new conversations (saved to your account; **Use default** starts from the built-in one) and the default reviewer model (saved in this browser).
- **Private branches** (a branch setting) are left out of every share and export, together with everything below them.
- **Sharing:**
  - Use **Share…** in the chat header to pick a scope (tree / subtree / path) and a mode (snapshot / live), plus an optional title and expiry.
  - The **Shares** page lists every link. From there you can republish a snapshot in place (same URL) or revoke a link, which takes effect immediately.
- **Export:** Markdown, or a single offline HTML file that uses the same viewer as share links.
- **Backup:** the JSON backup includes everything, private branches too. **Import** restores a backup as a new tree.
