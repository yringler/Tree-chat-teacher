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

|          | Power mode                                                                                                                                                                                                                                                                                                                                                                              | Learn mode ("simple")                                                                                                                                                                                                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| URL      | `/` (`apps/web`)                                                                                                                                                                                                                                                                                                                                                                        | `/learn/` (`apps/simple`)                                                                                                                                                                                                                                                                                    |
| Who      | Anyone who signs in with a verified email. Account `p_<userId>`                                                                                                                                                                                                                                                                                                                         | The same users. Account `u_<userId>`, with its own conversations (credit is per user, shared by both apps)                                                                                                                                                                                                   |
| Models   | Every configured provider and model, on the user's own keys (bring-your-own-key). Where the operator sells credit, also **Tangent credit**: any OpenRouter model on the operator's key. For OpenRouter and Tangent credit the model is a text field (any OpenRouter model id) with the Learn models suggested first; keys and the balance are in the sidebar's **Keys & credit** dialog | Two tiers, **Smart** and **Simple**, on OpenRouter                                                                                                                                                                                                                                                           |
| Controls | All of them: context modes, inspector, reviewer, system prompt, shares, export, backups                                                                                                                                                                                                                                                                                                 | Nothing to configure: a built-in tutor prompt, tangents after every answer, "Ask about this" branches, a Smart/Simple toggle, JSON backups (export and import, the same files as power's)                                                                                                                       |
| Cost     | Where the operator charges for it, a membership ($10 a year plus tax, one for both apps): your own provider keys need it (unmetered), and while it is missing a panel over the app offers it (only on load when no Tangent credit is left, else after an own-key call is refused, dismissible); Tangent credit, metered, works while the balance lasts, membership or not (see below). **Billing** in the sidebar (`/billing`): membership, balance, top-ups, usage                                                                               | Free on your own OpenRouter key (unmetered, no membership needed) or on the community pool at its free caps; where the operator sells it, **Tangent credit** (see below): spending it needs no membership, buying it needs the same membership, as do the pool's higher member caps. **Billing** in the account menu (`/learn/billing`): membership, balance, top-ups, usage |

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

**Switching modes.** All apps show a **Power | Learn | Canvas** switch (the sidebar of the power app, the header of Learn). It is a link to the other app: one sign-in covers both. Each user has one account per mode, so power conversations and Learn lessons are kept apart (a Learn lesson runs on the tutor's provider, which the power app doesn't have, and the reverse). To move one across, export its JSON backup in one app and import it in the other (see **Backup** under [Using it](#using-it)). The app tells the API which mode it is with the `x-tangent-mode` header.

**How Learn pays.** In Learn, **How replies are paid for** (account menu) offers:

- **Use my own OpenRouter key.** The key is stored like any bring-your-own-key (a sealed cookie, the same one power mode uses, so one OpenRouter key serves both apps). Nothing is metered, there is no balance check, and the operator's key is never used.
- **Use Tangent credit** (prepaid, pay as you go). The dialog shows the available balance, an **Add credit** link to the billing page and, in one sentence, what a reply costs: "the model's OpenRouter price + 5.5% OpenRouter fee + 10%" (tax on top at checkout; see [How pricing works](#how-pricing-works)). The header shows the balance as a pill. Offered only when the operator has set up payments (Polar) and `OPENROUTER_SIMPLE_API_KEY`. Without them (for example a self-hosted install) Learn runs on the learner's own key only and the credit option is hidden.

Where the operator has set up and switched on the membership (`ANNUAL_FEE_ENABLED`, off by default), buying Tangent credit needs it ($10 a year plus tax, or a waiver from the operator); see [Membership, credit and billing](#membership-credit-and-billing). Spending credit already held never does, and neither does the learner's own key. Without one, a learner is on the **free tier**: Learn runs on their own key, or on the community pool at the free caps while the pool is on, or on credit they still hold (a lapsed member's, or an operator grant), until it runs out. With a balance, **How replies are paid for** offers credit as usual and notes "$X left. Buying more credit needs a membership.", and the funding toggle above the composer shows; with none, the credit option is disabled ("Members only", with a **Become a member** link to the billing page) and the toggle is hidden. No Learn reply needs a membership, so Learn's membership panel ("Tangent is $10 a year", the included credit when there is any, **Subscribe**, **Have a code?**, **See billing** and **Sign out**) is only a safeguard: it shows if a reply is ever refused with 402 `membership_required`, with **Continue free on the community pool** (or, with the pool off, **Continue with my own OpenRouter key**) to move replies off credit, and the unsent message is kept. The panel stays off the billing page and the demo. The billing page (`/learn/billing`, the same page as power's `/billing`) has a **Membership** section (status, price, Subscribe, Manage billing, the code form) and, where credit is sold, **Credit**, **Add credit** and **Recent usage**.

**Server keys.** Anyone can sign up, so the server-side keys of the power-mode providers (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or whatever `PROVIDERS` names) are never used for a signed-in user: power mode is bring-your-own-key for everyone. Those secrets serve only the local dev bypass (`DEV_ALLOW_NO_AUTH`), so leave them unset in production. `OPENROUTER_SIMPLE_API_KEY` only ever serves the built-in provider (Tangent credit, in both apps), metered and paid from credit.

Two public pages sit in front of both apps:

- **Landing page.** Anonymous visitors to `/` get a marketing page instead of the power app: what Tangent is, the two modes, and links to the demo, Learn sign-in (`/learn/login`) and power sign-in (`/login`). "Anonymous" means no Better Auth session cookie (`tangent.session_token`, or `__Secure-tangent.session_token` on https) and not the local dev bypass; with a cookie, `/` is the power app as before. `/welcome` always serves the page, signed in or not. The Worker renders it (`apps/worker/src/http/landing.ts`): one HTML document, no JavaScript, one inline stylesheet allowed by a hash-based CSP.
- **Free demo at `/learn/demo`.** The Learn interface running entirely in the browser: no sign-in, no model calls, and its state lives only in the browser tab. Replies are generated from random English sentences (the `txtgen` package), so they are playful nonsense, but branching, "Ask about this", the tangents under each reply and the tree all behave as in the real app. Export and Import work there too, in memory. The power app has the same demo at `/demo` (without shares, keys or server-made exports), and the Power / Learn switch moves between the two demos. Both run on the in-browser backend in `@tangent/web-shared/demo`.

Design docs:

- [docs/PLAN.md](docs/PLAN.md): architecture, data model, interfaces, the context algorithm and portability.
- [docs/DECISIONS.md](docs/DECISIONS.md): one-line decision log.
- [docs/RESEARCH.md](docs/RESEARCH.md): research notes, with sources.
- [docs/DEFERRED.md](docs/DEFERRED.md): known gaps and follow-ups left out of a change, with what fixing them takes.
- [docs/LEGAL.md](docs/LEGAL.md): legal and compliance checklist (privacy policy, terms, account deletion, trademark, payments, what the operator must do before launch).

```
packages/shared     domain types, API + SSE contract (zod), share DTO
packages/core       context assembly (pure), tree utils, share projection, services, repository ports
packages/providers  Anthropic, OpenAI-compatible (OpenAI/OpenRouter/…), a fake for tests — raw fetch + SSE
packages/render     markdown → safe HTML, self-contained viewer page, Markdown export
packages/web-shared Angular code shared by the apps: API client, auth, billing client, SSE, markdown, login page, base styles
apps/worker         Hono API, D1 repositories, TreeSession Durable Object, Better Auth, email, share routes, billing
apps/web            Power app at /: Angular 22 (standalone, signals, zoneless)
apps/simple         Simple "Learn" app at /learn/: Angular 22
apps/canvas         Experimental Canvas app at /canvas/ (a map of the power account's trees): Angular 22
apps/admin          Admin app at /admin/ (operator only: who may share, takedowns): Angular 22
```

## License

The code is released under the [MIT License](LICENSE), © 2026 Yehuda Ringler. The license covers the code only: "Tangent" and the Tangent logo are trademarks and aren't licensed, so a deployment you run yourself must use its own name and logo, and its own privacy policy and terms (set the `LEGAL_*` vars; see [docs/LEGAL.md](docs/LEGAL.md)).

## Requirements

- **Node ≥ 22.22.3**. Node 24 is recommended (`.nvmrc`), and the Angular 22 CLI refuses older versions.
- **pnpm 10** (`corepack enable`).
- To deploy you need a Cloudflare account. The **Workers Paid** plan is recommended: the Free plan's 10 ms CPU per request is tight for streaming.
- You also need a domain on Cloudflare: sign-in callbacks, magic links and passkeys are tied to one public origin.
- Paid Learn mode also needs an [OpenRouter](https://openrouter.ai) account and a [Polar](https://polar.sh) account, the merchant of record (see [Membership, credit and billing](#membership-credit-and-billing)). Learn on the learner's own OpenRouter key only needs `KEY_ENCRYPTION_SECRET`.

## Local development

```bash
pnpm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # DEV_ALLOW_NO_AUTH=true (no sign-in), optional API keys
pnpm --filter @tangent/worker db:migrate:local            # create the local D1 database
pnpm dev                                                  # `wrangler dev`, which first builds both Angular apps
```

Open <http://localhost:8787>. To chat, add `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` to `apps/worker/.dev.vars` (the dev bypass may use them). Without any API keys, the demos at <http://localhost:8787/demo> and <http://localhost:8787/learn/demo> run the whole interface in the browser, and "Option C" in `.dev.vars.example` runs the built-in provider offline.

To try real sign-in locally, follow "Option B" in `.dev.vars.example`: it sets a `BETTER_AUTH_SECRET`, prints magic links to the `wrangler dev` console instead of emailing them (`EMAIL_PROVIDER=log`, allowed on localhost only), and uses Cloudflare's always-pass Turnstile test keys. Passkeys work on `localhost` too. `pnpm dev` runs `wrangler dev --local-upstream localhost:8787`: without that flag, wrangler rewrites requests to the production hostname from `routes`, and Better Auth rejects the mismatched origin.

For UI work with hot reload, run `pnpm --filter @tangent/worker dev` and `pnpm --filter @tangent/web start` in two terminals, then open <http://localhost:4200>. The Angular dev server proxies `/api` and `/s` to the Worker on port 8787. With real sign-in, set `PUBLIC_BASE_URL=http://localhost:4200` in `.dev.vars` so links and passkeys use that origin.

The simple app works the same way: `pnpm --filter @tangent/simple start` serves it on <http://localhost:4201/learn/> (`ng serve --serve-path /learn/ --port 4201`, same proxy). The dev bypass acts as the `default` account in power mode and `default_simple` in Learn; to try paid credit offline, see "Option C" in `.dev.vars.example` and [Testing billing locally](#testing-billing-locally). With real sign-in on the dev server, set `PUBLIC_BASE_URL=http://localhost:4201`.

The canvas app too: `pnpm --filter @tangent/canvas start` serves it on <http://localhost:4202/canvas/> (`ng serve --serve-path /canvas/ --port 4202`, same proxy), acting as the `default` power account.

And the admin app: `pnpm --filter @tangent/admin start` serves it on <http://localhost:4203/admin/>. The dev bypass is always an admin; with real sign-in, put your own user id in `ADMIN_USER_IDS` in `.dev.vars` (see [Admin](#admin)).

**Build layout.** `pnpm build` builds the power app, the simple app, the canvas app and the admin app, then runs `scripts/assemble-assets.mjs`, which copies them into the Worker's static assets directory. `wrangler.jsonc` sets it as the Worker's `build.command`, so every `wrangler deploy` and `wrangler dev` runs it first (and `wrangler dev` reruns it when the apps' sources change):

```
apps/web/dist/web/browser/**        → apps/worker/site/         served at /
apps/simple/dist/simple/browser/**  → apps/worker/site/learn/   served at /learn/
apps/canvas/dist/canvas/browser/**  → apps/worker/site/canvas/  served at /canvas/
apps/admin/dist/admin/browser/**    → apps/worker/site/admin/   served at /admin/ (to admins only)
```

`apps/worker/site/` is git-ignored except for a `.gitkeep`, so `wrangler dev` and the tests start before anything is built. The power app's deep links come straight from Workers Static Assets (SPA fallback). `/` (exact path) and `/welcome` run the Worker first: `apps/worker/src/http/landing.ts` serves the landing page there, and passes `/` to the power app's `index.html` when the request carries a session cookie or the dev bypass is on. `/learn` and `/learn/*` run the Worker first (`run_worker_first`): `apps/worker/src/http/learn-app.ts` serves files as they are and every other path as the simple app's `index.html`, because the SPA fallback only ever serves the root `index.html`. `/canvas*` and `/admin*` work the same way; the admin app's `index.html` goes only to admins, and everyone else gets a 404.

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

### Membership, credit and billing

Learn mode (`/learn/`, called "simple" in the code) is always on. Learners can run it on their own OpenRouter key, which needs only `KEY_ENCRYPTION_SECRET`, and power users bring their own keys. This section sets up the two things the operator can charge for, both sold through Polar:

- **The membership**: **$10 a year plus tax**, one subscription per user that covers both apps. It is behind the flag `ANNUAL_FEE_ENABLED`, which ships `"false"`: while it is off nobody needs a membership, whatever else is configured, so any signed-in user may learn from the community pool (within its caps) and buy personal credit, and the apps show no membership panel or billing section. Once the flag is `"true"` and the membership is set up (`POLAR_MEMBERSHIP_PRODUCT_ID`), there are two tiers. **Free** (no membership, or a lapsed one): Learn on the learner's own OpenRouter key (BYOK) and on the community pool at the free caps, while the pool is on; and Tangent credit already held, in both apps (power mode and Canvas included), while the balance lasts (then the usual 402 `payment_required`, or, for a Learn send or context resolve, a move to the pool while it is on). Power mode on the user's own keys (any own-key call, including a review whose reviewer or branch is on one) and buying credit answer 402 `membership_required`. **Member**: power mode on own keys, buying credit, and the pool's higher member caps; part of each membership payment funds the pool. Own keys stay free in Learn on purpose: charging for BYOK wouldn't be popular, so the fee pays for power mode on own keys, buying credit and the higher pool limits instead. Credit already paid for stays spendable after a membership lapses, and anyone holding credit (an operator grant, or a purchase made while the fee was off) may spend it (docs/DECISIONS.md, "Two tiers"). Reading, exporting, deleting and settings stay open without it, so nobody is locked out of their data. The operator can waive it per user (a waived user is a member). Each paid year includes **$2 of credit** (`MEMBERSHIP_CREDIT_CENTS`) when the built-in provider below is offered.
- **The built-in provider** ("Tangent credit"; the endpoint `openrouter` on the operator's key): it spends the operator's OpenRouter key, so each call on it is metered and charged against prepaid credit. A provider id names only the endpoint; who pays is decided apart from it: per request in Learn (the payment choice), per branch in power (the branch's `funding`: `own-key` or `credit`). Both apps offer it, once both Polar secrets and `OPENROUTER_SIMPLE_API_KEY` are set; until then both are own-key only and the paid option is hidden.

- **Learn** runs on it when the learner picks **Use Tangent credit**; Learn on credit ignores the learner's own key.
- **Power** lists it after the user's own providers as **Tangent credit** (the same endpoint id as the user's own OpenRouter, with `funding: 'credit'`; a branch on it stores `funding: 'credit'`), with the Learn models as suggestions and any OpenRouter model id allowed (`openModels`: the model picker becomes a text field with the suggestions in its list). The **Keys & credit** dialog shows the available credit, the fees and an **Add credit** link to `/billing`; Canvas's keys dialog shows the same row. Only calls on it are metered: a branch on it pays for its replies, summaries and titles, a review pays when the reviewer is Tangent credit (and for any summaries a reviewed branch on it still needs), and everything on the user's own keys stays free.
- **Credit is per user**, shared by both apps: one balance on the ledger id `u_<userId>` (the Learn account's id, so balances from before power could use credit carry over). `/api/billing` answers in both apps.

A generating request in power mode that calls the user's own keys answers **402 `membership_required`** when the membership is required and the user has none (the power app then shows the subscribe panel, with **Continue with my Tangent credit** while credit is left and **Use Learn instead (free with your own key)**; Canvas shows a notice linking to the power app's `/billing`; Learn and Tangent credit never do), then, for a call on the built-in provider, **402 `payment_required`** when the balance is short; a call on the user's own key never touches the balance or the operator's key.

Users pay the operator's true cost plus the markup: the model price OpenRouter reports, grossed up by OpenRouter's fee for buying credits, then +10%; and each purchase is credited net of Polar's actual fee. The markup is configuration (`MARKUP_BPS`) and, with both fees passed through, it is the operator's real margin. See [How pricing works](#how-pricing-works).

Payments go through [Polar](https://polar.sh), the **merchant of record**: Polar sells to the user, computes, collects and remits sales tax and VAT, issues invoices and receipts, and handles disputes; you keep only income tax. The code talks to Polar through one adapter (`apps/worker/src/billing/providers/polar/`) behind a provider port (`apps/worker/src/billing/payments/`), so the rest of the app never names it ([docs/polar-migration/03-architecture.md](docs/polar-migration/03-architecture.md)).

1. **OpenRouter key.** Create a key just for the built-in provider at <https://openrouter.ai/settings/keys> and **give it a credit limit**: it is the backstop if anything goes wrong with metering. The built-in provider never falls back to `OPENROUTER_API_KEY`.
   ```bash
   npx wrangler secret put OPENROUTER_SIMPLE_API_KEY
   ```
   The tiers default to `deepseek/deepseek-v4-pro` (Smart) and `deepseek/deepseek-v4-flash` (Simple); change them with `SIMPLE_SMART_MODEL` / `SIMPLE_FAST_MODEL`. They are also the suggested models in power mode, for Tangent credit and for the user's own OpenRouter key (where the smart one is the default), though power users may pick any OpenRouter model. Users are billed OpenRouter's reported cost, never a price table, so price changes need no update. That cost is grossed up by `OPENROUTER_FEE_BPS` (default `550` = 5.5%), OpenRouter's fee when you buy its credits. OpenRouter's minimum fee is $0.80 a purchase, so top-ups under about $15 cost more than 5.5% (a $10 top-up costs 8%): buy credits in bulk, or set `OPENROUTER_FEE_BPS` to the rate you actually pay (`800` for $10 top-ups). `SIMPLE_PROVIDER` replaces the whole provider config (one `ProviderConfig` JSON, whose id must be `tangent`), for example to route through AI Gateway or to add `"options": { "extraBody": { "reasoning": { "effort": "low" } } }`.
2. **Polar organization.** Set everything up in the **sandbox** first (<https://sandbox.polar.sh>, a separate organization with its own token, products and webhook secret), then again in production. Polar reviews new accounts; an AI tutoring product is in a restricted category, so start the account review early.
   - **A credits product**, e.g. "Tangent credits": **one-time**, priced in **USD**. Its own price doesn't matter: each top-up opens a checkout with an ad-hoc USD price (tax exclusive) for the amount chosen. Put its id in `POLAR_CREDITS_PRODUCT_ID`.
   - **The membership** (optional; without it nobody needs one): a **recurring yearly** product of **$10.00**, tax behaviour **exclusive** (tax added on top). Put its id in `POLAR_MEMBERSHIP_PRODUCT_ID` (step 4). Users subscribe from the billing page (Polar's hosted checkout).
   - **Customer portal** (_Settings_): allow invoices and cancellation **at the end of the billing period**; there is one plan, so turn plan switching off. Members cancel, update cards and download invoices there ("Manage billing").
   - **Webhook endpoint** (_Settings → Webhooks_, format **Raw**): URL `https://tangent.example.com/api/webhooks/polar`, and these events: `order.paid`, `refund.created`, `refund.updated`, `subscription.created`, `subscription.updated`, `subscription.active`, `subscription.canceled`, `subscription.uncanceled`, `subscription.revoked`, `subscription.past_due`. Polar has no dispute webhooks: the 10-minute cron polls disputes instead.
   - **An organization access token** (_Settings → Developers_) with the scopes the Worker uses: `checkouts:write`, `customer_sessions:write`, `customers:read`, `customers:write`, `orders:read`, `subscriptions:read`, `subscriptions:write`, `disputes:read`. Ask Polar support to enable the disputes feature if `disputes.list` is refused.
3. **Polar secrets.** Payments are enabled only when both are set:
   ```bash
   npx wrangler secret put POLAR_ACCESS_TOKEN     # polar_oat_… of the production organization
   npx wrangler secret put POLAR_WEBHOOK_SECRET   # whsec_… of the endpoint above
   ```
   `PAYMENT_PROVIDER` is `"polar"` and `POLAR_SERVER` `"production"` in `wrangler.jsonc` (`"sandbox"`, or any other value, uses Polar's sandbox).
4. **Membership.** In `wrangler.jsonc`, set `POLAR_MEMBERSHIP_PRODUCT_ID` to the yearly product above and `ANNUAL_FEE_ENABLED` to `"true"` (either unset = no membership: everyone may use power mode on own keys and buy credit, and everyone gets the pool's free caps). With the flag off, a membership renewal paid anyway (an existing subscriber's) still grants its included credit. `MEMBERSHIP_PRICE_CENTS` (default `1000`) is only what the apps display; Polar charges its product's price. `MEMBERSHIP_CREDIT_CENTS` (default `200` = $2.00) is the credit each paid membership year includes, granted only while the built-in provider is offered (`0` = none). Optionally, a waiver code for friends (see [Waiving the membership](#waiving-the-membership)):
   ```bash
   npx wrangler secret put MEMBERSHIP_WAIVER_CODE
   ```
5. **Migrate and deploy.** Migration `0003_billing` adds the billing tables, `0004_fees` the fee columns, `0007_membership` the waiver flag, `0010_pool_ledger` the community pool's ledger columns, `0011_pool_access` its per-user access columns (suspension, Turnstile pass, pool identity) and the pool identity tables that survive account deletion, `0012_pool_consent_tags` the pool notice acknowledgments and topic tags, `0013_pool_impact` the weekly impact snapshots and the topic review queue, `0014_model_prices` the synced model price table and its history, `0015_polar_neutral` the provider-neutral ledger key (`provider_ref`) and the `billing_customers` and `billing_subscriptions` tables, `0016_drop_stripe` removes the previous processor's tables, `0017_pool_revenue_share` indexes the personal charges the pool's daily revenue share sums, and `0018_payment_ref` links each refund, dispute and reinstatement to its payment, so together they never take back more than it granted, and `0019_member_tier` renames the pool's higher tier on past rows (`supporter` → `member`). The cron triggers (`*/10 * * * *`, the daily `23 3 * * *` and the weekly `17 4 * * 1` in `wrangler.jsonc`) deploy with the Worker.
   ```bash
   pnpm db:migrate:remote
   pnpm run deploy
   ```
6. **Verify.** Sign in at `https://tangent.example.com/learn/`, subscribe to the membership (if you set it up) and check that $2 of credit appears, choose **Use Tangent credit** under **How replies are paid for**, buy $5 (in the sandbox, the test card `4242 4242 4242 4242`), and check that the balance appears and goes down as you chat. In the power app, a conversation on **Tangent credit** spends the same balance. Polar's webhook settings show every delivery and its response; the Worker logs `payment_webhook_failed` when one fails. **Polar disables an endpoint after 10 consecutive failures**, so alert on that log line and on Polar's "endpoint disabled" email.

#### How pricing works

- **Membership.** **$10 a year plus tax** (an exclusive price; Polar adds the tax), one per user for both apps, renewing yearly until cancelled in the billing portal (it then runs to the end of the paid year). Each paid membership year, the first and every renewal (Polar orders with billing reason `subscription_create` or `subscription_cycle`), adds **$2 of credit** (`MEMBERSHIP_CREDIT_CENTS`) as a fixed gift (no fee is deducted from it), only while the built-in provider is offered; the apps mention it only then. A renewal whose payment failed (`past_due`) still counts while Polar retries it.
- **The rule.** Users pay the operator's true cost plus one markup, **+10%** (`MARKUP_BPS`; the older `MARKUP_PREPAID_BPS` is still read while `MARKUP_BPS` is empty, for one release, then dropped). "True cost" passes two fees through, so the markup is real margin:
  - **OpenRouter's credit-purchase fee** is added to the cost of each call (`OPENROUTER_FEE_BPS`, default 5.5%).
  - **Polar's fee** is deducted from each purchase: the credit is what the user paid before tax, minus the fee Polar reports for that order (`platform_fee_amount`). If an order reports no usable fee, the Worker estimates it from `POLAR_FEE_BPS` and `POLAR_FEE_FIXED_CENTS` (default 5% + 50¢) and logs `fee_estimated`.
- **Balance.** Each user has one balance in US dollars, shared by both apps and kept as integer micro-dollars: what the user paid before tax, less Polar's fee on each payment, less what they have used.
- **Charges.** Every call on the built-in provider (replies, summaries, titles, reviews) is charged `ceil(cost × (1 + fee bps / 10000) × (1 + markup bps / 10000))`, rounded up to the next micro-dollar, where `cost` is the model price OpenRouter reports for the call. The fee and markup are fixed when the call starts and stored with it, so changing the config never reprices past calls. Credit bought at one rate is spent at whatever rate applies when it is used.
- **Top-ups.** One-time payments of **$5 to $500** through Polar's hosted checkout. When Polar reports the paid order (`order.paid`), the Worker credits its pre-tax amount (`net_amount`) minus Polar's fee, once per order. The billing page shows the last purchase as "paid $5.00, credit $4.23 after payment processing".
- **Worked example.** A user buys **$5** of credit. Polar adds tax on top, say $0.40, so the card is charged $5.40. On Polar's Starter plan the fee is 5% + 50¢ (plus 1.5% on cards issued outside the US), about $0.77 here, so the user gets about **$4.23** of credit (tax never enters the balance). At **$10** the fee is about 10%, at $5 about 15%: the fixed part dominates small purchases, so consider raising `MIN_TOP_UP_CENTS` (see [docs/polar-migration/04-verification.md](docs/polar-migration/04-verification.md)). A reply that OpenRouter reports at **$0.0010** is charged $0.0010 × 1.055 × 1.10 ≈ **$0.00116**. The exact fees come from Polar and OpenRouter's current terms; check <https://polar.sh/docs/merchant-of-record/fees>.
- **Tax.** Prices exclude tax. Polar, as merchant of record, computes it at checkout from the buyer's location, adds it on top, and files and remits it. Tax never enters the balance.
- **Holds.** Each call in flight holds `USAGE_HOLD_MICROS` (default `20000` = $0.02) until it settles. A message, review or summary on the built-in provider can only start when the available balance (balance − holds) covers one more hold; otherwise the API answers **402 `payment_required`** and the app points the user to the billing page (in power and Canvas, an error with an **Add credit** link). At most `USAGE_MAX_PENDING` (default `3`) such calls per user may be in flight at once, across both apps; one more answers **429 `rate_limited`** until one finishes. A reply that has started is never cut off, so the balance can go negative; the next purchase absorbs that. On Learn's models that is a few cents. In power, where any OpenRouter model may be picked, the hold doesn't follow the model's price, so the overdraft is bounded by `USAGE_MAX_PENDING` × the most expensive call the token caps allow (`SIMPLE_MAX_INPUT_TOKENS` in, 4,096 out), which can be dollars on the priciest models; the credit limit on `OPENROUTER_SIMPLE_API_KEY` is the backstop.
- **Stopped and lost replies.** Stopping a reply still costs what OpenRouter billed for it. When a stream ends without a cost, the Worker asks OpenRouter's generation endpoint (with retries), and a cron every 10 minutes settles anything left over. A call that never reached OpenRouter is charged $0, and one still unknown after 24 hours is marked `unresolved` at $0 and logged for review.
- **Refunds.** Refund in the Polar dashboard; the Worker debits the refunded pre-tax amount automatically once the refund succeeds (`refund.created` / `refund.updated`), once per refund. Polar keeps its fee on a refund, so a full refund debits the whole pre-tax amount, including the fee that was never credited; an unspent top-up refunded in full leaves the balance negative by that fee. Polar may also refund on its own to prevent a chargeback; that arrives the same way. Refunding a membership payment (in part or in full) takes back the credit it included, once, and, per refund, the same proportion of the pool's revenue share (below); revoke the subscription as well if the membership should end. Polar has no dispute webhooks, so the 10-minute cron polls its disputes: a top-up whose dispute needs a response, is under review or is lost is debited like a refund of the disputed amount, credited back if you win (less any refund that came after it), and a lost dispute also suspends the buyer's community pool access (once; an admin can lift it). Refunding a membership payment also takes back the same proportion of the pool's revenue share of it (below), clamped to what the pool still has. A purchase's refunds and disputes together never take back more than it paid (a refund then a dispute of the same top-up debits it once), and a membership payment's refunds never more than its share. Disputes of membership payments are handled by hand in Polar, with a manual adjustment if needed (below). Each dispute costs $15 at Polar whatever the outcome.
- **History.** `/learn/billing` and, in power, `/billing` (**Billing** in the sidebar) show the balance, top-ups and recent usage (`GET /api/billing/usage`) of both apps. A top-up returns to the billing page of the app it was bought from (`/learn/billing`, or `/billing` in power).
- **Cost bounds.** Every call on the built-in provider, in either app, sends at most `SIMPLE_MAX_INPUT_TOKENS` (default 60,000) input tokens and 4,096 output tokens, and those calls are rate limited per user across both apps (`CHAT_RATE_LIMITER`, 30 a minute). In power the user picks the model, so a call on an expensive model costs more within the same token bounds.

- **The community pool.** Nobody buys credit for the pool: it is free credit Tangent provides, an operator expense like a free tier, funded from Tangent's own revenue. Tangent sells only the membership and personal credit, and commits `POOL_REVENUE_SHARE_BPS` (default `2000` = 20%) of what it earns to the pool (`apps/worker/src/pool/revenue-share.ts`): of each membership payment (first year and renewals), the pre-tax amount minus Polar's actual fee, added when the payment is applied (a $10 membership with an 80¢ fee adds $1.84), and of the markup on personal credit as it is used (charge × `markup_bps` / (10000 + `markup_bps`) of each settled personal charge, never the purchase itself), added by the 10-minute cron once per completed UTC day (a $10 top-up that adds $9.20 of credit earns about $0.84 of markup once spent at +10%, of which $0.17 goes to the pool). Each grant is a `contribution` row on the pool's ledger, idempotent on its ref (`<payment ref>:pool-share`, `pool-share:usage:YYYY-MM-DD`); the cron catches up to 31 missed days, and amounts are integer micro-dollars rounded down. A refund of a membership payment takes back the same proportion of its share, clamped to what the pool has. Nothing accrues while `POOL_ENABLED` is off (or the share is 0), then or later: the cron records those days as 0, so turning the pool back on never back-fills them. The operator can add more with an admin adjustment (below), for example for someone who arranges shared access directly. Pool replies are charged at their true cost (the provider's price grossed up by OpenRouter's fee) with no markup, and the pool's holds are priced the same way, so a hold always covers its charge. Pool purchases made before this change keep their ledger rows: refunding or disputing one still takes the same share of what it added back out of the pool, clamped (`pool_debit_shortfall` logs the rest, yours to absorb). Members (a paid or waived membership, while `ANNUAL_FEE_ENABLED` is on) get higher daily pool caps (`POOL_MEMBER_*`); buying credit and admin credit don't change the tier. No page or template may call the pool a donation or say "tax-deductible" (tests check every pool page and template).
- **Where the pool shows.** The landing page (`/welcome`, and `/` for visitors) shows the pool meter: about how many learning sessions it covers (`POOL_SESSION_ESTIMATE_MICROS` each, default 2¢), the dollars, and this week's learners and funded exchanges (aggregates only), and Tangent's commitment, read from `POOL_REVENUE_SHARE_BPS`: "The community pool is free credit Tangent provides. Tangent puts 20% of what it earns into it: 20% of each membership payment after payment fees, and 20% of the markup on credit as it's used." Nothing on any page offers pool credit for sale. `GET /api/pool/status` serves the same meter publicly (with `revenueShareBps`), edge-cached for a minute. `/pool` explains how the pool works, with this deployment's revenue share, what it added this week and month, the model and caps, and the operator's contact (`LEGAL_OPERATOR`, `LEGAL_CONTACT_EMAIL`) for questions or arrangements. The billing page of both apps has a **The community pool** section with the meter. Spending from the pool is Learn-only: Learn offers it as a way to pay (header pill, the "How replies are paid for" dialog, a credit/pool switch above the message box when both can pay), locks the Smart/Simple switch to the pool's model, and shows an empty pool or a reached cap inline above the message box, keeping the message. A first pool message from an account without a Turnstile pass on record sends the learner to `/verify` once.

**Manual credit or adjustments** (goodwill credit, corrections) go through the admin API: `POST /api/admin/credit` (admins only, same-origin) with

```json
{ "target": "personal", "userId": "<userId>", "amountCents": 500, "mode": "adjustment", "idempotencyKey": "goodwill-2026-10-05-ada", "note": "Goodwill" }
```

`target` is `personal` (the user's ledger, `userId` required) or `pool` (`userId` optional: the user an arrangement is for, or omitted or `null` for an operator top-up; a simulated purchase is personal only), `amountCents` is signed (from −50000 to 50000, never 0), and repeating a request with the same `idempotencyKey` changes nothing (`"credited": false`). A negative pool adjustment never takes the pool below 0. The answer is `{ credited, amountMicros, balanceMicros }`. With `PERSONAL_CREDIT_ENABLED` set to `"true"`, granted personal credit can be spent before payments are set up.

For local testing, `"mode": "simulated_purchase"` fulfils a purchase as the payment webhook would without a processing fee, so the full amount is credited. It exists only while `DEV_PURCHASES_ENABLED` is `"true"` (in `.dev.vars`); `wrangler.jsonc` ships it `"false"`, and the route then answers 404. Never turn it on in production.

The same can still be done in SQL: an insert into `credit_grants` with `kind='adjustment'` and a signed amount in micro-dollars (`5000000` = $5; negative to debit). The ledger id is `u_<userId>` in both apps (`default_simple` for the dev bypass), and the pool's is `POOL_ACCOUNT_ID` (default `pool`; debit the pool through the API instead, which keeps it from going negative). Find it first:

```bash
npx wrangler d1 execute DB --remote --command "SELECT 'u_' || id AS ledger_id, email FROM auth_users"
npx wrangler d1 execute DB --remote --command "INSERT INTO credit_grants (id, account_id, kind, amount_micros, provider_ref, note, created_at) VALUES (lower(hex(randomblob(16))), 'u_<userId>', 'adjustment', 5000000, NULL, 'Manual credit', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
```

Use `--local` instead of `--remote` for the local database.

#### Waiving the membership

A user whose `auth_users.membership_waived` is `1` needs no membership, whatever its subscription says. Set it by hand, or give friends the code in the `MEMBERSHIP_WAIVER_CODE` secret: entering it on the billing page ("Have a code?", `POST /api/billing/membership/waiver`) sets the flag for that user (rate limited, compared in constant time). If the code leaks, change the secret (`npx wrangler secret put MEMBERSHIP_WAIVER_CODE`; set it empty to stop code redemption) and clear the flag of whoever shouldn't have it. Clearing it doesn't touch a paid membership.

```bash
# Who has it, and since when
npx wrangler d1 execute DB --remote --command "SELECT id, email, membership_waived_at FROM auth_users WHERE membership_waived = 1"
# Waive (set) or revoke (clear) it for one user
npx wrangler d1 execute DB --remote --command "UPDATE auth_users SET membership_waived = 1, membership_waived_at = COALESCE(membership_waived_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE email = 'friend@example.com'"
npx wrangler d1 execute DB --remote --command "UPDATE auth_users SET membership_waived = 0 WHERE email = 'friend@example.com'"
```

#### Testing billing locally

- **Offline, no payments or OpenRouter.** Use "Option C" in `apps/worker/.dev.vars.example`: a fake `SIMPLE_PROVIDER` that reports a fixed cost per call, and either `PERSONAL_CREDIT_ENABLED=true` or placeholder Polar secrets so paid credit is offered. Grant yourself credit with the SQL insert above (`--local`; the account is `default_simple` with the dev bypass; signed in under Option B, `POST /api/admin/credit` does it too). The dev bypass is always admin, so `POST /api/admin/credit` with `"target": "pool"` adds credit to the pool, and with `DEV_PURCHASES_ENABLED=true` in `.dev.vars`, `"mode": "simulated_purchase"` credits your own account as a purchase would, choose **Use Tangent credit**, then chat at <http://localhost:8787/learn/> (or pick **Tangent credit** in the power app, on the same balance). Top-ups and the membership checkout won't work with placeholder secrets; leave `POLAR_MEMBERSHIP_PRODUCT_ID` empty, or set it and waive yourself with the SQL above (`--local`).
- **Polar sandbox.** Put the sandbox organization's values in `apps/worker/.dev.vars` (`POLAR_SERVER=sandbox`, `POLAR_ACCESS_TOKEN`, `POLAR_CREDITS_PRODUCT_ID`, `POLAR_MEMBERSHIP_PRODUCT_ID`). Polar must reach your webhook over the internet and has no local forwarding CLI, so run a tunnel and create a sandbox webhook endpoint on it:
  ```bash
  cloudflared tunnel --url http://localhost:8787   # prints https://<random>.trycloudflare.com
  ```
  Point the endpoint at `https://<random>.trycloudflare.com/api/webhooks/polar` with the events of step 2, set its secret as `POLAR_WEBHOOK_SECRET` and restart `wrangler dev`. Pay with the test card `4242 4242 4242 4242`. The checks still to run against the sandbox are listed in [docs/polar-migration/04-verification.md](docs/polar-migration/04-verification.md).
- **Real models.** Add `OPENROUTER_SIMPLE_API_KEY` (and remove `SIMPLE_PROVIDER`). Use a key with a small credit limit.

#### Not included yet

These are out of scope for now:

- Auto-recharge, free sign-up credit, promotion codes, trials, low-balance or membership-lapse emails, multi-currency (USD only), and admin UI for personal credit (adjustments are the admin API above and waivers the SQL above; the [admin page](#admin) tops up only the community pool).
- Metered (postpaid) billing. Usage stays on the internal ledger; nothing is mirrored into Polar's meters.

### Admin

The admin page at `/admin/` (`apps/admin`) is for you, the operator. It lists users (newest first, searchable by email) and lets you:

- allow particular users to publish share links while `DMCA_AGENT_REGISTERED` is off (**May share**, stored in `auth_users.share_allowed`). The check runs on every view of a link, before the edge cache, so turning a user off takes their links down at once. Once `DMCA_AGENT_REGISTERED` is `"true"` everyone may share and the list has no effect; the page says which applies;
- see a user's shares and **Revoke** any of them, which is how to act on a takedown notice without the owner;
- suspend or restore a user's community pool access (**Pool suspended**), and see who uses the pool most (**Community pool use**, below the users);
- see the community pool's balance, what pending reservations hold, and whether the overage breaker has tripped (**Community pool**), and top up or correct the pool there (an adjustment);
- review the topics the pool's public impact feed may name (**Impact feed topics**): approve or reject each topic the first time it qualifies.

For the community pool, the admin API behind those controls:

- suspends or restores a user's pool access: `PATCH /api/admin/users/<id>` with `{"poolSuspended": true}` (or `false`), stored in `auth_users.pool_suspended` and on the user's pool identity, and checked on every pool request. It stays with the mailbox if the user deletes their account and signs up again. Nothing else about the account changes;
- credits a user's ledger or the pool: `POST /api/admin/credit` (see [Manual credit or adjustments](#how-pricing-works));
- reports the pool's balance, holds and overage breaker: `GET /api/admin/pool`;
- runs the impact feed's review queue: `GET /api/admin/pool/topics?status=pending` (or `approved`, `rejected`) and `POST /api/admin/pool/topics/<topic id>` with `{"decision": "approved"}` (or `"rejected"`); see [The weekly impact feed](#the-weekly-impact-feed);
- reports pool consumption: `GET /api/admin/pool/usage?days=7&limit=50` lists the pool's users by spend (replies, spend, tagging, last call), and today's network keys by the number of users on each. A key is a daily-rotating hash of an IPv4 address or IPv6 /64, never the address; many accounts on one key is what a farm looks like. Every refused pool request is also logged as one `pool_refused` JSON line.

#### The weekly impact feed

Every Monday at 04:17 UTC a cron (`17 4 * * 1`, `apps/worker/src/pool/impact.ts`) writes one immutable snapshot of the ISO week just ended: the pool replies it funded (settled above $0), their distinct learners, the distinct topics, the average and deepest branch depth, and the topics it names. The landing page, `/pool` (with a list of past weeks, `/pool?week=YYYY-MM-DD`) and the billing page's pool section show it; `GET /api/pool/impact?week=YYYY-MM-DD` (latest when omitted) and `GET /api/pool/impact/weeks` serve it publicly. A topic is named only when at least `IMPACT_MIN_DISTINCT_USERS` (default 5, never below 3) distinct learners touched it that week, it is not sensitive, it is not on `POOL_TOPIC_BLOCKLIST` (comma-separated topic ids; a root id such as `history` blocks all its topics), and an admin approved it. The first time a topic qualifies it goes to the review queue on the admin page instead; once approved it is named automatically in later weeks (a snapshot already written never changes), and a rejected topic never is. The same run deletes topic tags whose branch hasn't used the pool for `IMPACT_TAG_RETENTION_DAYS` (14). A re-run of a week is a no-op, and while `POOL_ENABLED` is off the job writes no snapshot (only the tag retention runs) and the public impact routes answer 404, so no empty pre-launch weeks are ever published. To run it locally: `wrangler dev --test-scheduled`, then open `http://localhost:8787/cdn-cgi/handler/scheduled?cron=17+4+*+*+1`.

Admins are the users listed in the `ADMIN_USER_IDS` secret. To add yourself:

1. Sign in to the app, open the account dialog (**Account** in the power app's sidebar, or the account menu in Learn and Canvas) and copy your **Account ID**.
2. Store it (several ids are comma-separated):
   ```bash
   npx wrangler secret put ADMIN_USER_IDS
   ```
3. The power app's sidebar now shows **Admin**. Admins may also always share.

A user id isn't a credential: being an admin still takes being signed in as that user. It is a secret only to keep it out of `wrangler.jsonc`. To everyone else, `/admin*` and `/api/admin/*` answer 404 (signed out included), and the admin API's mutating routes refuse cross-origin requests.

**Optional extra layer: Cloudflare Access.** The server-side check is the real gate, but you can also put a [Cloudflare Zero Trust Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/) self-hosted application in front of the admin paths, with a policy that allows only your email. Scope it by path on the same hostname: `tangentailearning.com/admin` and `tangentailearning.com/api/admin` (each also covers the paths below it; check that `/admin/` and `/api/admin/users` both prompt). Don't move the admin app to a subdomain: Better Auth's session cookie belongs to the main origin, so `admin.<domain>` would have no session.

## Configuration

| Name                                                                                   | Kind               | Purpose                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`                                                                      | var                | Public origin: share links, sign-in callbacks, magic links, passkey relying party (default: the request's origin; set it in production)                                                                                                                       |
| `EMAIL_PROVIDER`                                                                       | var                | `resend` (default) or `log` (prints emails to the console; localhost only)                                                                                                                                                                                    |
| `EMAIL_FROM`                                                                           | var                | Sender address for magic links (its domain must be verified in Resend)                                                                                                                                                                                        |
| `LEGAL_OPERATOR`, `LEGAL_CONTACT_EMAIL`, `LEGAL_JURISDICTION`                          | var                | Who runs the deployment, where privacy and legal requests go, and the governing law, for `/privacy`, `/terms` and page footers (see [docs/LEGAL.md](docs/LEGAL.md))                                                                                           |
| `DMCA_AGENT_REGISTERED`                                                                | var                | `"true"` once a DMCA designated agent is registered. Otherwise (default `"false"`) share links are off except for admins and users allowed on the [admin page](#admin) (see [docs/LEGAL.md](docs/LEGAL.md) §8)                                                |
| `TURNSTILE_SITE_KEY`                                                                   | var                | Cloudflare Turnstile site key for the magic-link form                                                                                                                                                                                                         |
| `PROVIDERS`                                                                            | var                | JSON array of power mode's own-key provider configs (default: anthropic, openai, openrouter; the default openrouter lists the `SIMPLE_*_MODEL`s first and takes any model id). The legacy id `tangent` is reserved: older clients still name it for Tangent credit                   |
| `SUMMARY_PROVIDER_ID`, `SUMMARY_MODEL`                                                 | var                | Cheaper model for summaries and titles, e.g. `anthropic` + `claude-haiku-4-5`. Empty = the branch's own model                                                                                                                                                 |
| `AUTO_TITLE`                                                                           | var                | `false` disables automatic branch/tree titles                                                                                                                                                                                                                 |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`                            | secret             | Provider keys, referenced by name from provider configs. Used only by the local dev bypass; leave unset in production                                                                                                                                         |
| `AI_GATEWAY_TOKEN`                                                                     | secret             | Optional, for an authenticated AI Gateway                                                                                                                                                                                                                     |
| `ADMIN_USER_IDS`                                                                       | secret             | Comma-separated Better Auth user ids of your own accounts: they open `/admin/` and `/api/admin/*` and may always share. Empty = no admins. See [Admin](#admin)                                                                                                |
| `BETTER_AUTH_SECRET`                                                                   | secret             | Signs session cookies (`openssl rand -base64 32`). Required; rotating it signs everyone out                                                                                                                                                                   |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | secret             | OAuth apps; each provider is offered only when both of its values are set                                                                                                                                                                                     |
| `TURNSTILE_SECRET_KEY`                                                                 | secret             | Turnstile secret; without it magic-link sign-in is refused                                                                                                                                                                                                    |
| `RESEND_API_KEY`                                                                       | secret             | Resend API key for magic-link emails                                                                                                                                                                                                                          |
| `KEY_ENCRYPTION_SECRET`                                                                | secret             | 32 random bytes, base64 (`openssl rand -base64 32`). Enables bring-your-own-key; rotating it revokes every stored user key                                                                                                                                    |
| `CHAT_RATE_LIMITER`, `KEY_RATE_LIMITER`                                                | rate limit binding | Requests spending a user key (30/min per key cookie) or, on the built-in provider, the operator's key (30/min per user, both apps together); key saves (10/min per account)                                                                                   |
| `OPENROUTER_SIMPLE_API_KEY`                                                            | secret             | OpenRouter key of the built-in provider (the endpoint `openrouter` on credit or the pool), sold as credit in both apps (Learn's paid option, power's **Tangent credit**). Give it a credit limit in OpenRouter. No fallback to `OPENROUTER_API_KEY`, never reachable through a user's own providers   |
| `SIMPLE_SMART_MODEL`, `SIMPLE_FAST_MODEL`                                              | var                | The suggested OpenRouter models: Learn's Smart and Simple tiers, and the first models power lists for OpenRouter and Tangent credit (default `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-flash`). The fast one also writes Learn's summaries and titles |
| `SIMPLE_PROVIDER`                                                                      | var                | One `ProviderConfig` as JSON (id `openrouter`; the legacy `tangent` is still read as `openrouter`) that replaces the built-in provider entirely (tests, offline dev, AI Gateway, `options.extraBody`). Default empty = OpenRouter with the two models above                                                          |
| `SIMPLE_MAX_INPUT_TOKENS`                                                              | var                | Input-token cap per call in Learn and on the built-in provider in power; bounds the cost of one request (default `60000`). Output is capped at 4,096 tokens                                                                                                   |
| `SIMPLE_SYSTEM_PROMPT`                                                                 | var                | Built-in prompt of new Learn trees with none saved (default empty = `DEFAULT_SYSTEM_PROMPT` in `packages/shared`). Learn only: power users set their own in Settings                                                                                          |
| `USAGE_HOLD_MICROS`                                                                    | var                | Micro-dollars held per call in flight, and the minimum available balance to start one (default `20000` = $0.02)                                                                                                                                               |
| `USAGE_MAX_PENDING`                                                                    | var                | Metered calls (Tangent credit) a user may have in flight at once, across both apps (default `3`); one more answers 429. Bounds how far a balance can go negative                                                                                              |
| `OPENROUTER_FEE_BPS`                                                                   | var                | OpenRouter's credit-purchase fee in bps, added to the reported cost of each built-in provider call before the markup (default `550` = 5.5%; raise it for OpenRouter top-ups under ~$15)                                                                       |
| `MARKUP_BPS`                                                                           | var                | Margin on the true provider cost in basis points (default `1000` = +10%). The deprecated `MARKUP_PREPAID_BPS` is still read while this is empty, for one release                                                                                              |
| `PAYMENT_PROVIDER`                                                                     | var                | The payment provider: `polar` (default). Payments go through its adapter (`apps/worker/src/billing/providers/`) |
| `POLAR_ACCESS_TOKEN`                                                                   | secret             | Polar organization access token (`polar_oat_…`). Payments are enabled only when this and `POLAR_WEBHOOK_SECRET` are set |
| `POLAR_WEBHOOK_SECRET`                                                                 | secret             | Signing secret (`whsec_…`) of the Polar webhook endpoint `/api/webhooks/polar` |
| `POLAR_SERVER`                                                                         | var                | `production` (as deployed) or `sandbox`; any other value is the sandbox, so a missing value never charges real cards |
| `POLAR_CREDITS_PRODUCT_ID`                                                             | var                | Polar one-time product that personal top-ups are sold as, each checkout with an ad-hoc USD price (default empty = no top-ups) |
| `POLAR_FEE_BPS`, `POLAR_FEE_FIXED_CENTS`                                               | var                | Polar's fee as an estimate, used only when an order reports no usable fee (logged `fee_estimated`): bps of the total plus fixed cents (defaults `500` and `50`) |
| `POOL_REVENUE_SHARE_BPS`                                                               | var                | The share of Tangent's revenue added to the community pool, in bps (default `2000` = 20%, at most `10000`, `0` = none): of each membership payment after Polar's fee, and of the markup on personal credit as it is used. The public pages quote it |
| `ANNUAL_FEE_ENABLED`                                                                   | var                | `true`: the yearly membership is charged, so with `POLAR_MEMBERSHIP_PRODUCT_ID` set power mode on own keys and buying credit need one (Learn, and spending credit already held, don't). Default `false`: nobody needs a membership; any signed-in user may use the pool (within its caps) and buy personal credit |
| `POLAR_MEMBERSHIP_PRODUCT_ID`                                                          | var                | Polar yearly product of the membership ($10, tax exclusive). Set (with `ANNUAL_FEE_ENABLED`) = power mode on own keys and buying credit need a membership (or a waiver); empty (default) = no membership |
| `MEMBERSHIP_PRICE_CENTS`                                                               | var                | The membership's yearly price shown to users (default `1000` = $10.00); Polar charges the product's price                                                                                                                                                        |
| `MEMBERSHIP_CREDIT_CENTS`                                                              | var                | Credit included with each paid membership year, in cents (default `200` = $2.00), granted only while the built-in provider is offered                                                                                                                         |
| `MEMBERSHIP_WAIVER_CODE`                                                               | secret             | Optional code users enter to waive the membership fee (sets `auth_users.membership_waived`). Empty = no code redemption; change it if it leaks                                                                                                                |
| `triggers.crons`                                                                       | cron trigger       | `*/10 * * * *`: settles usage whose cost the stream didn't report (`apps/worker/src/billing/reconcile.ts`), expires stale community pool reservations and maintains the pool's balance checkpoint, polls Polar's disputes (Polar has no dispute webhooks), and adds the pool's revenue share of each completed UTC day's markup (`apps/worker/src/pool/revenue-share.ts`). `17 4 * * 1` (Mondays): the pool's weekly impact snapshot and topic-tag retention (`apps/worker/src/pool/impact.ts`); `src/cron.ts` dispatches on the schedule |
| `POOL_BANK`                                                                            | Durable Object     | The community credit pool's bank (`PoolBank`, migration tag `v2`): serialises reservations against the pool's balance, one instance per pool |
| `POOL_ENABLED`, `POOL_*`, `MODEL_PRICES`, `IMPACT_*`        | var                | The community credit pool (off by default): its account id, model and locked prompt, revenue share (`POOL_REVENUE_SHARE_BPS`), token limits, reservation TTLs, daily caps, overage breaker and price table (synced daily from OpenRouter's list prices; a `MODEL_PRICES` entry wins). Every value is documented in `wrangler.jsonc` and parsed in `apps/worker/src/config.ts`; see [docs/pool/SPEC.md](docs/pool/SPEC.md) `IMPACT_MIN_DISTINCT_USERS`, `POOL_TOPIC_BLOCKLIST` and `IMPACT_TAG_RETENTION_DAYS` govern the [weekly impact feed](#the-weekly-impact-feed) |
| `FEATURED_CONVERSATIONS_ENABLED`                                                       | var                | Default `false`. A future "featured learning" wall of conversations users publish. Only a stub exists: `/api/featured/*` answers 404 either way, no app shows it and nothing is stored for it (see [docs/DEFERRED.md](docs/DEFERRED.md)) |
| `PERSONAL_CREDIT_ENABLED`                                                              | var                | `true`: personal credit (e.g. granted by an admin) may be spent before payments are configured. Default `false`: only with payments configured |
| `DEV_PURCHASES_ENABLED`                                                                | var                | `true`: admins may simulate purchases (`POST /api/admin/credit`, mode `simulated_purchase`) for local testing. Default `false`; never on in production |
| `DEV_ALLOW_NO_AUTH`                                                                    | `.dev.vars` only   | Skip sign-in locally (only while `BETTER_AUTH_SECRET` is unset)                                                                                                                                                                                               |

**Routing.** `assets.run_worker_first` in `wrangler.jsonc` lists the paths the Worker sees before Workers Static Assets: `/api/*`, `/s/*`, `/learn`, `/learn/*`, `/canvas`, `/canvas/*`, `/admin`, `/admin/*`, `/`, `/welcome`, `/privacy` and `/terms`. Keep `/` an exact path (not `/*`), or every asset request would run the Worker. In local dev with `DEV_ALLOW_NO_AUTH=true`, `/` is the app; open `/welcome` to see the landing page.

**Providers.** Each provider instance in `PROVIDERS` has `id`, `kind` (`anthropic` | `openai-compatible`; `fake`, a scripted provider, is for tests and offline development only), `label`, `models`, `defaultModel` and `apiKeySecret`. It can also take `baseUrl`, `headers`, `extraHeaderSecrets`, `maxContextTokens`, `maxOutputTokens`, `supportsSystemPrompt`, `options` and `openModels`. With `"openModels": true`, `models` are only suggestions and any model id the upstream knows (letters, digits and `_ . - : /`, up to 200 characters) may be used, e.g. any OpenRouter model; an unlisted model gets the provider-level limits. Any OpenAI-compatible endpoint is config only:

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

With `KEY_ENCRYPTION_SECRET` set, users can paste their own Anthropic / OpenAI / OpenRouter key under **Keys** (**Keys & credit** where the operator sells credit) in the power app's sidebar. A user key overrides the server secret for that provider, for replies, summaries and titles alike. Learn mode (**How replies are paid for**) stores and uses only the OpenRouter key, from the same cookie, so one OpenRouter key serves both apps; on paid credit Learn ignores it. The built-in provider (**Tangent credit**) takes no user key.

- The browser sends the key once (`POST /api/key`). The Worker checks it with one unbilled provider call (`GET /v1/models`), then seals `{ keys, exp }` with AES-256-GCM and returns it as `__Host-llmkey` (`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`). The server stores nothing. Page scripts can't read the cookie, and the input field is cleared as soon as the key is sent.
- Each chat request carries the cookie back. The Worker decrypts it in memory, calls the provider and streams the reply. No endpoint returns any part of a key.
- If the cookie is tampered with, expired, or sealed with an older secret, the request gets `401 key_required`, the cookie is cleared and the UI asks for the key again. **Rotating `KEY_ENCRYPTION_SECRET` revokes every stored key.**
- Limits on the proxy: same-origin requests only (`Sec-Fetch-Site`), JSON bodies only on mutations, models limited to the provider config (any well-formed id for an `openModels` provider), output tokens capped server-side, and a rate limit per key cookie.
- Trade-offs:
  - The key passes through the Worker on every request, so users trust the operator not to log it. The code never logs request headers or bodies. Keep it that way, and don't enable anything that captures them, such as Logpush with headers.
  - An XSS on the origin can spend the user's credit while the page is open, within the limits above, but it cannot extract the key.
  - Browser extensions with host permissions are out of scope.

The power app is served with a strict CSP (`apps/web/public/_headers`): `script-src 'self'`, `connect-src 'self'`, `img-src 'self'`, Trusted Types. The browser never talks to a provider directly. The simple app under `/learn/` gets the same two policies (app and login page) from the Worker (`apps/worker/src/http/learn-app.ts`), because `_headers` doesn't apply to responses the Worker generates; a test keeps the copies identical.

## Using it

This section describes the power app. The simple app at `/learn/` keeps only the essentials: a list of lessons, a chat with a Smart/Simple toggle, **Ask about this** on selected text (a new branch that keeps the conversation so far), **How replies are paid for** (your own OpenRouter key or Tangent credit), **Export** and **Import** of JSON backups (see **Backup** below), and a **Billing** page (the membership, and with credit the balance, top-ups and recent usage). The **Power | Learn** switch at the top of either app opens the other one.

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
  - While `DMCA_AGENT_REGISTERED` is off, **Share…** appears only for accounts the operator allowed (and admins); everyone else exports instead.
- **Export:** Markdown, or a single offline HTML file that uses the same viewer as share links.
- **Backup:** the JSON backup includes everything, private branches too. **Import** restores a backup as a new tree. Both apps use the same file (`<title>.tangent.json`), so a conversation moves between them: in Learn, **Export** (the download icon on each lesson and in a lesson's header) saves it and **Import** (above the lesson list) restores one made in either app. An import lands in the account of the app it is made in, and power imports are restored exactly. An import into Learn is adapted so it can be read and continued there: branches on a provider or model Learn doesn't offer move to Learn's **Smart** model (branches already on Smart or Simple keep theirs), every side question gets the whole path as context, and the lesson gets Learn's tutor prompt instead of a custom one. Nothing is charged by an import; replies after it are paid however the learner pays in Learn (see _Import and export in Learn_ in [DECISIONS.md](docs/DECISIONS.md)). Files over 50 MB, Markdown or HTML exports and other JSON are refused with a message saying why.
