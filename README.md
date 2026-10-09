# Tangent — branching LLM chat

Tangent is a self-hosted chat app for having tree-shaped conversations with LLMs. It runs on **Cloudflare Workers + D1 + Durable Objects** and has two **Angular** UIs: a full-featured power app and a simple "Learn" tutor. Anyone can sign up, and every user can switch between the two at any time.

In a normal chat, digging into a side topic pollutes the main thread, and starting a new chat loses the connection to where the question came from. In Tangent any message can spawn any number of **branches**:

- Each branch has a **context mode** that decides what the model sees:
  - `path`: everything its parent saw, plus the branch's own messages.
  - `summary`: a cached summary of the parent context.
  - `message`: only the message the branch forks from, plus the highlighted quote.
  - `independent`: only the highlighted quote or topic.
- The **Context Inspector** shows exactly what will be sent to the model, and why.
- **Review up to here** (on any assistant reply, or `v`) sends the conversation, as the model saw it, to a reviewer model of your choice (default in **Settings**). The reviewer lists corrections and says whether to continue on a stronger model. One click moves the branch to the reviewer's model, branches off on it, or puts the corrections in the message box.
- Conversations can be shared as read-only links (the whole tree, one subtree, or one path; as a frozen snapshot or live). They can also be exported as Markdown or as one self-contained HTML file.

## Two ways to use Tangent

|          | Power mode                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Learn mode ("simple")                                                                                                                                                                                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL      | `/` (`apps/web`)                                                                                                                                                                                                                                                                                                                                                                                                                                             | `/learn/` (`apps/simple`)                                                                                                                                                                                                                                                                                                                                             |
| Who      | Anyone who signs in with a verified email. Account `p_<userId>`                                                                                                                                                                                                                                                                                                                                                                                              | The same users. Account `u_<userId>`, with its own conversations (credit is per user, shared by both apps)                                                                                                                                                                                                                                                            |
| Models   | Every configured provider and model, on the user's own keys (bring-your-own-key). Where the operator sells credit, also **Tangent credit**: any OpenRouter model on the operator's key. For OpenRouter and Tangent credit the model is a text field (any OpenRouter model id) with the suggested models, Learn's Normal and Max first, as chips under it, all in view and one click each; keys and the balance are in the sidebar's **Keys & credit** dialog | Two tiers, **Normal** and **Max**, on OpenRouter                                                                                                                                                                                                                                                                                                                      |
| Controls | All of them: context modes, inspector, reviewer, system prompt, shares, export, backups                                                                                                                                                                                                                                                                                                                                                                      | Nothing to configure: a built-in tutor prompt, tangents after every answer, "Ask about this" branches, a Normal/Max toggle and **Compare**, JSON backups (export and import, the same files as power's)                                                                                                                                                               |
| Cost     | Where the operator charges for it, a membership ($10 a year plus tax, one for both apps): your own provider keys need it (unmetered), and while it is missing conversations on them are read-only (a notice where the message box was: renew, create a copy in Learn, or continue on Tangent credit); Tangent credit, metered, needs no membership to buy or spend (see below). **Billing** in the sidebar (`/billing`): membership, balance, top-ups, usage | Your own OpenRouter key (unmetered) needs the same membership where the operator charges for it; free on the open pool within its daily caps (the same for everyone); where the operator sells it, **Tangent credit** (see below), which needs no membership to buy or spend. **Billing** in the account menu (`/learn/billing`): membership, balance, top-ups, usage |

**How Tangent answers.** New conversations in both apps start with the same built-in system prompt (`DEFAULT_SYSTEM_PROMPT` in `packages/shared/src/default-prompt.ts`). It answers the question asked, directly and in depth, and never quizzes the user: whatever they don't follow, they branch into. Every substantive reply ends with a `<tangents>` block of two to four directions to explore next ("Why ice is less dense than water — …"). Both apps keep that block out of the rendered reply and show it as buttons under the message; tapping one creates a `path` branch titled after the tangent and sends the title as its first message (the parser is `splitTangents` in `packages/shared`). The block stays in the stored message, so the model sees what it already offered; shares and exports show it as a plain "Where next?" list.

- **Power mode:** **Settings** → **Default system prompt** sets your own prompt for new conversations, saved to your account (`GET`/`PATCH /api/settings`, table `account_settings`), so it follows you to every device. **Use default** copies the built-in prompt into the editor to edit from; an empty editor means the built-in one. A conversation's own prompt (**Conversation settings**) overrides it for that conversation; clear it there for a conversation without a system prompt.
- **Learn:** the operator can replace the built-in prompt with `LEARN_SYSTEM_PROMPT`; learners have no prompt editor.

**How Tangent checks facts.** The deeper a learner drills into tangents, the more likely the tutor is to misremember specifics. On OpenRouter-backed routes (Tangent credit, in both apps, and OpenRouter on your own key), replies can be grounded with OpenRouter's web search. Anthropic and OpenAI direct can't search, and neither can the open pool (its holds are priced from tokens alone).

- **Whether search is offered.** A free check on the server offers it when a reply likely needs it: two or more tangents deep, a specific fact (a date, a figure, "who invented…"), something recent, or sources asked for. The model then decides whether to search, at most once per reply.
- **What a grounded reply shows.** It cites its claims as links and lists its sources under the message ("Checked against 3 sources"); shares and exports list them too. An unchecked reply says "From the tutor's own knowledge", with a **Check sources** button that runs a search and adds the corrected, cited answer to the conversation.
- **What it costs.** A reply that searches costs about $0.007 more at OpenRouter (checked on live calls, 2026-10), and it is part of the cost OpenRouter reports for the reply, so on Tangent credit it is billed like the reply, and on your own key OpenRouter bills you (see [How pricing works](#how-pricing-works)).
- **Configuration.** The `GROUNDING*` vars in [docs/configuration.md](docs/configuration.md#web-search). Power mode also has a per-branch setting in branch settings (**Check facts with web search**: when likely needed, on every reply, or off).

### Experimental: Canvas (for the brave)

A third UI, **Tangent Canvas** at `/canvas/` (`apps/canvas`), takes branching as far as it goes. It is a view of the **power** account's conversations (same account `p_<userId>`, same keys, same API, no header of its own), so anything started in Power mode can be opened on the canvas and the other way round. Instead of one branch at a time:

- **Every branch is a lane on one pannable, zoomable surface.** A lane hangs to the right of the message it forks from, connected by a curve whose stroke is its context mode (solid for `path`, dashed for `summary`, dash-dot for `message`, dotted and cut short for `independent`). The layout is a contour sweep in `apps/canvas/src/app/layout/layout.ts` over the lanes' measured heights.
- **Every lane has its own message box and streams on its own.** Any number of lanes can generate at once (the server only refuses a send into a branch whose last reply is still streaming); the bar counts how many are writing.
- **Branch into variants.** The branch button on any message opens one lane, or several at once, each with its own context mode and model, and an optional starting message sent to all of them in parallel ("Every context mode" opens the same question three ways, side by side). There is no title field: a single lane is named after its first reply, several are named by model and mode.
- **Ask your own.** Under a finished reply, after its suggested tangents (or on its own), **Ask your own question…** grows into a few lines when clicked; Enter asks it in a new `path` lane (Shift+Enter for a new line, Escape folds it), and its gear opens the branch dialog with the question as the starting message, for other modes, models or variants. On the selected lane's last reply it is already open (without taking focus), until folded.
- **Ask about this.** Selecting text in a finished card floats **Ask about this** at the foot of the canvas: a new `path` lane quoting it, its message box focused. Its gear opens the branch dialog with the quote filled in. Each lane's box reads "Continue this lane…": it adds to that lane, while new questions branch.
- **Lineage.** With the selected lane, the canvas asks the context planner (`GET /api/branches/:id/context`, summaries not generated) what the model would see and lights those cards up; cards that reach the model only through a summary are marked, dropped ones too, and everything else dims. The lane head shows the plan's token budget.
- **Fold** any lane's subtree into a capsule; a minimap and keyboard navigation (`?` lists it) cover the rest.
- **Link related messages** across lanes: drag the port on a card's right edge onto another card, or click the port (or press `r`) for pick mode ("Click the card that relates to …", with **Search** for the shared picker). A link is a thin line between the two cards with a dot halfway; the dot opens a popover to go to either end, edit the note or remove the link. **Links** in the canvas bar hides or shows the lines. Each card lists its links as compact chips (open, edit the note, remove), and a **Back to ‘…’** pill in the bar returns from a followed link.
- **Delete** a lane with every lane below it from the trash in its head (it asks first, with how many lanes and messages go); a selection inside it moves back to the card it forked from. **Lane settings** offer the same.
- **Text size:** **Aa** in the bar makes the cards' text and the lanes' message boxes smaller or larger (85% to 140%), saved in this browser apart from the other apps'; the lanes are measured again and re-laid out. Lane heads, the bar and dialogs keep their size, and there is no shortcut for it (`+`, `-` and `0` zoom the canvas).

It is marked experimental in the app and in the **Power | Learn | Canvas** switch. There is no reviewer, no share or export UI and no settings editor there yet; use Power mode for those. Its demo runs at `/canvas/demo` over the power demo's in-browser backend.

**Switching modes.** All apps show a **Power | Learn | Canvas** switch (the sidebar of the power app, the header of Learn). It is a link to the other app: one sign-in covers both. Each user has one account per mode, so power conversations and Learn lessons are kept apart (a Learn lesson runs on the tutor's provider, which the power app doesn't have, and the reverse). To move one across, export its JSON backup in one app and import it in the other (see **Backup** under [Using it](#using-it)). The app tells the API which mode it is with the `x-tangent-mode` header.

**How Learn pays.** In Learn, **How replies are paid for** (account menu) offers:

- **Use my own OpenRouter key.** The key is stored like any bring-your-own-key (a sealed cookie, the same one power mode uses, so one OpenRouter key serves both apps). Nothing is metered, there is no balance check, and the operator's key is never used.
- **Use Tangent credit** (prepaid, pay as you go). The dialog shows the available balance, an **Add credit** link to the billing page and, in one sentence, what a reply costs: "the model's OpenRouter price + 5.5% OpenRouter fee + 10%" (tax on top at checkout; see [How pricing works](#how-pricing-works)). The header shows the balance as a pill. Offered only when the operator has set up payments (Polar) and `BUILT_IN_API_KEY`. Without them (for example a self-hosted install) Learn runs on the learner's own key only and the credit option is hidden.

Where the operator has set up and switched on the membership (`ANNUAL_FEE_ENABLED`, off by default), **Use my own OpenRouter key** needs it ($10 a year plus tax, or a waiver from the operator), as own keys do in power mode; see [Membership, credit and billing](#membership-credit-and-billing). Nothing else in Learn does: Tangent credit is bought and spent without one, and the open pool, while it is on, serves everyone within the same daily caps, member or not. Without a membership, Learn doesn't offer the own key in **How replies are paid for**, and a learner still on it (a lapsed member whose browser remembers the choice, or a membership that lapses mid-lesson, when the server refuses the reply with 402 `membership_required`) keeps reading: where the message box (or the new lesson's **Start lesson**) would be, a notice offers **Renew membership** (or **Become a member**), **Continue on the open pool** and **Continue on Tangent credit**, and the unsent message comes back once they pick a way on. The billing page (`/learn/billing`, the same page as power's `/billing`) has a **Membership** section (status, price, Subscribe, Manage billing, the code form) and, where credit is sold, **Credit**, **Add credit** and **Recent usage**.

**Server keys.** Anyone can sign up, so the server-side keys of the power-mode providers (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or whatever `PROVIDERS` names) are never used for a signed-in user: power mode is bring-your-own-key for everyone. Those secrets serve only the local dev bypass (`DEV_ALLOW_NO_AUTH`), so leave them unset in production. `BUILT_IN_API_KEY` only ever serves the built-in provider (Tangent credit, in both apps), metered and paid from credit.

Two public pages sit in front of both apps:

- **Landing page.** Anonymous visitors to `/` get a marketing page instead of the power app: what Tangent is, the two modes, and links to the demo, Learn sign-in (`/learn/login`) and power sign-in (`/login`). "Anonymous" means no Better Auth session cookie (`tangent.session_token`, or `__Secure-tangent.session_token` on https) and not the local dev bypass; with a cookie, `/` is the power app as before. `/welcome` always serves the page, signed in or not. The Worker renders it (`apps/worker/src/http/landing.ts`): one HTML document, no JavaScript, one inline stylesheet allowed by a hash-based CSP.
- **Free demo at `/learn/demo`.** The Learn interface running entirely in the browser: no sign-in, no model calls, and its state lives only in the browser tab. Replies are generated from random English sentences (the `txtgen` package), so they are playful nonsense, but branching, "Ask about this", the tangents under each reply and the tree all behave as in the real app. Grounding is simulated too: some replies list pretend sources on example domains, and **Check sources** works. Export and Import work there too, in memory. The power app has the same demo at `/demo` (without shares, keys or server-made exports), and the Power / Learn switch moves between the two demos. Both run on the in-browser backend in `@tangent/web-shared/demo`.

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
apps/e2e            Playwright end-to-end tests, against wrangler dev (pnpm e2e)
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
pnpm test        # Vitest in every package; the worker suite runs inside workerd with real D1 + Durable Objects,
                 # and the Angular packages' *.dom.spec.ts render components with TestBed in happy-dom
pnpm typecheck   # tsc everywhere (+ Angular strict templates)
pnpm lint        # ESLint (typescript-eslint strict, plus the type-aware promise rules)
pnpm format:check # Prettier (`pnpm format` rewrites); .prettierignore skips vendored and generated files
pnpm coverage    # the same tests with coverage, then a lines/branches table per package
pnpm knip        # unused files, dependencies and exports (knip.jsonc); not in CI yet
pnpm e2e         # Playwright end-to-end tests against wrangler dev (see below)
```

**Coverage** (`pnpm coverage`) runs `vitest run --coverage` in every package, one at a time, then `scripts/coverage-summary.mjs` prints each package's totals. It only reports; nothing fails on low numbers. The settings are shared (`vitest.coverage.ts`): each package measures its own `src/` (files no test loads count as uncovered, so the Angular apps, whose components have few unit tests, show low numbers), with V8 in the Node packages and Istanbul in the worker, since `@cloudflare/vitest-pool-workers` runs the tests inside workerd, where V8 coverage isn't available. Each package writes an HTML report to its git-ignored `coverage/` (open `apps/worker/coverage/index.html`). `node scripts/coverage-summary.mjs <file>…` also prints single files, e.g. `apps/worker/src/billing/gate.ts`. A worker run with coverage takes a few minutes; `pnpm --filter @tangent/core coverage` covers one package.

**End-to-end tests** (`pnpm e2e`, in `apps/e2e`) drive Chromium through the built apps with [Playwright](https://playwright.dev), against `wrangler dev` on port 8790 (`E2E_PORT`). They are separate from `pnpm test`. `apps/e2e/serve.mjs` (Playwright's `webServer`) generates the Worker's config into the git-ignored `apps/e2e/.state/` (passed with `--env-file`, so your `apps/worker/.dev.vars` and local database are never read), migrates a fresh local database there, and starts `wrangler dev`, which builds every app first (about a minute). No model is called: power runs on the offline test provider, and the built-in provider is configured but never sent to. Signed-in tests sign a new user in through the real magic-link endpoints (`signIn` in `tests/helpers.ts`): the link is read from the server log and followed with the browser context's request client, which shares its cookies, so no page loads the app just to sign in. Each sign-in comes from a client IP of its own (`cf-connecting-ip`), so the magic-link rate limit (5 a minute per IP, tested in the worker's `auth.test.ts`) never trips however many tests sign in or how often the suite reruns against one server. The suites:

- `demo.spec.ts`: the power demo's Delete in the conversation list (Cancel keeps the conversation, OK removes it), Delete on a branch in a message's branch list (the same ask, without the outline), the conversation text size (**Aa**: the messages and composer grow and the header doesn't, the size survives a reload, and the `-` / `0` shortcuts), deleting the open branch from the chat header (back on its parent at the branch point, gone from the outline), **Ask your own question…** under a reply (it grows on click and folds on Escape; Enter asks in a new branch, and the field empties; its gear opens **Branch from here** with the question and neither a starting message nor a title field, and cancelling keeps the question) and **Branch from here** (a starting message, no title, `Ctrl+Enter` creates and asks), **Ask about this** on selected text (a quoted `path` branch, the composer focused and nothing sent; its gear opens **Branch from here** with the quote; `b` still does), the newest reply's **Ask your own question…** (open from the start without focus, the others folded; Shift+Enter is a new line, leaving it empty keeps it open, folded by hand it stays folded until the user goes elsewhere; an older one folds when left empty and stays open with text), the Learn demo's **Ask your own question…** (a side question that starts with it), **Ask about this** (a quoted side question, the box focused), the newest reply's ask item marked, the "Continue this lesson…" box, deleting a side question from its chip and the open one from the header, the lesson text size (the messages and composer grow, the header doesn't, kept across a reload under Learn's own key), the lesson header on a phone (at 360 and 400px the title is whole on a row of its own, the tools under it, and **Aa** and the account menu on screen), and its Export, then Import of a power-style backup (another provider and model, a custom prompt, a summary branch on credit), which comes back adapted to Learn; a file that isn't a backup is refused; and the Canvas demo's **Ask your own question…** (a new lane, inline or through the gear's dialog, which has no starting message or title field, while the branch button's has a starting message and no title), **Ask about this** (a quoted lane with its box focused; the gear's dialog has the quote) and the selected lane's open ask item (the only one open), deleting a selected lane from its head (the selection goes back to the fork), and the card text size (cards and lane composers grow, the bar doesn't, the lanes re-lay out without overlapping, kept across a reload under the canvas's own key, and `-` still zooms).
- `read-only-power.spec.ts`: with the membership required and cancelled, the own-key branch shows the read-only notice, the credit branch keeps its message box, **Renew membership** goes to `/billing`, **Create a copy in Learn** opens the copy at `/learn/t/<id>` and leaves the power conversation unchanged, and **Continue with Tangent credit** moves the branch onto credit.
- `model-suggestions.spec.ts`: on Tangent credit, power's **Branch from here** and Canvas's lanes dialog show both suggested models (Normal and Max) under the model id with Normal's id in it, Normal pressed; clicking Max (or Enter on it) sets the id, and the new branch or lane is on it; a typed id keeps both chips in view.
- `missing-key-power.spec.ts`: a member with Tangent credit opens a conversation on an own-key provider (`keyed`, whose key is never saved) in a browser without its key: the bar under the message box says so; a message sent stays in the (disabled) box while in flight, the server refuses it (401 `key_required`) and the keys dialog says it wasn't sent, offering **Continue on Tangent credit**. Clicking it moves the branch onto credit and sends the message there, which then leaves the box; closing the dialog instead sends nothing and leaves the exact text in the box.
- `learn-key.spec.ts`: Learn on the learner's own key without one says which key is missing and opens **How replies are paid for**; the learner stays signed in.
- `share-dialog.spec.ts`: the **Share…** dialog lists only the open conversation's links (a conversation without any says so), with the branch a path link ends in; a link created there joins the top of the list, and one revoked there shows as revoked at once and after reopening. The e2e server turns share links on for everyone (`DMCA_AGENT_REGISTERED`) for it.

Sign-in is the real magic-link flow: `EMAIL_PROVIDER=log` prints the link to the server log, which the tests read, and Cloudflare's always-pass Turnstile test keys stand in for the captcha (their check still calls `challenges.cloudflare.com`, so the run needs network access). Memberships and credit come from the fake payment provider's signed webhook (`PAYMENT_PROVIDER=fake`, which the Worker allows only with `TEST_SEAMS`, as in the worker tests). `@playwright/test` is pinned to the release whose Chromium is installed; on a new machine run `pnpm --filter @tangent/e2e exec playwright install chromium` once, or point `PLAYWRIGHT_CHROMIUM_PATH` at a Chromium binary. While writing tests, `node apps/e2e/serve.mjs` in one terminal and `E2E_REUSE_SERVER=1 pnpm e2e` in another skips the rebuild. CI (`.github/workflows/ci.yml`) runs on every pull request to `master` and every push to it: a **Checks** job (`pnpm test`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, each run even when an earlier one fails) and an **End-to-end** job (installs Chromium, then `pnpm e2e`; on failure it uploads the Playwright report and the Worker log). Merging is blocked by a rule on `master` that requires both jobs (Settings → Rules), not by the workflow. On `master`, a **Deploy** job follows once both pass ([Deploying from Git](#deploying-from-git)).

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
6. **Deploy.** This builds both Angular apps, assembles them into `apps/worker/site/` and deploys the Worker together with the static assets. `pnpm run deploy` and `npx wrangler deploy` are the same thing: the build is the Worker's `build.command` in `wrangler.jsonc`. To deploy every merge to `master` from GitHub instead, see [Deploying from Git](#deploying-from-git). A bare `pnpm deploy` is pnpm's own built-in command, not this script.
   ```bash
   pnpm run deploy
   ```
   Do not use `workers_dev: true` in production (see step 8 of "Sign-in" below).

### Deploying from Git

`.github/workflows/ci.yml` deploys every push to `master`, and a manual **Run workflow** on `master`, once the **Checks** and **End-to-end** jobs pass. Its **Deploy** job runs in the GitHub environment `production`:

1. It stops at once if the `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` secret is missing.
2. `wrangler deploy --dry-run` runs `build.command` (the root `pnpm build`) and bundles the Worker, then a check fails the job unless `apps/worker/site/` holds all four apps' `index.html`. A deploy without the build would serve an empty assets directory, and every app page and asset would 404.
3. `scripts/deploy-config.mjs` writes `apps/worker/wrangler.deploy.json`, a copy of `wrangler.jsonc` without `build`, so the two steps that hold the API token run no build: the token never meets the apps' build toolchain, and the upload is the site just checked.
4. `wrangler d1 migrations apply DB --remote` applies the new migrations in `apps/worker/migrations`.
5. `wrangler deploy` deploys the Worker with those static assets.

Deploys never overlap, and none is cancelled midway: a newer one waits for the running one. Re-running an old `master` run redeploys that commit's code but doesn't roll back later migrations: the database keeps the newest schema.

**Migrations must stay compatible with the code still running.** They are applied before the deploy, so new code never meets an old schema, but the previous release keeps serving on the new schema until the deploy finishes, and for good if the deploy then fails. Expand first (new tables, new nullable or defaulted columns); contract (drop or rename what the running code still reads) in a later release, once no deployed code uses it.

To set it up (once):

1. **Create a Cloudflare API token**: **My Profile → API Tokens → Create Token → Create Custom Token**, with these permissions, the account resources limited to your account and the zone resources to your domain's zone:
   - Account → **Workers Scripts** → Edit: uploads the Worker, its Durable Objects, cron triggers and static assets.
   - Account → **D1** → Edit: applies the migrations.
   - Account → **Account Settings** → Read: lets wrangler read the account.
   - Zone → **Workers Routes** → Edit: every deploy publishes the custom domain in `routes` again.
2. **Add the `production` environment** in the repository's **Settings → Environments**. Under **Deployment branches and tags**, allow only `master`. This rule is a security requirement, not an option: without it, a pull request from a branch of this repository that edits `ci.yml` can run a job in `production` and read its secrets. Add two environment secrets: `CLOUDFLARE_API_TOKEN` (the token) and `CLOUDFLARE_ACCOUNT_ID` (on the dashboard's account home, or `npx wrangler whoami`).
3. **Merge to `master`** and check that the first **Deploy** run succeeds.
4. **Disconnect Workers Builds** once the workflow is on `master`: the Worker's **Settings → Build**, disconnect the repository. Until then, Workers Builds also deploys every push, untested and without migrations.

Runtime secrets and variables are unaffected: they live on the Worker, not in GitHub. The manual `pnpm db:migrate:remote` and `pnpm run deploy` still work.

### Database migrations

`apps/worker/migrations` starts from one baseline, `0000_baseline.sql`, which creates the whole schema of `apps/worker/src/db/schema.ts` from nothing. A schema change is an edit to `schema.ts` plus the migration drizzle-kit writes for it (`pnpm --filter @tangent/worker db:generate`, then commit the `.sql` and its `meta/` snapshot together); `pnpm lint` fails while `schema.ts` has a change no migration has (`scripts/check-migrations.mjs`). `pnpm db:migrate:remote` (or the deploy job) applies the new ones; wrangler records them in the database's `d1_migrations` table.

A database created before the baseline (migrations `0000_init` to `0026_model_windows`) is converted once with `apps/worker/scripts/d1-baseline/convert.sql` before the first deploy of the baseline: [docs/runbooks/d1-baseline.md](docs/runbooks/d1-baseline.md). Without that, `migrations apply` stops on the existing tables (`table account_settings already exists`) and nothing is changed. A database older than `0026` is first migrated with the commit before the baseline.

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

**Upgrading from the Cloudflare Access setup:** migrate ([Database migrations](#database-migrations)), set the secrets and vars above, deploy, then delete both Access applications ("Tangent" and "Tangent shares") in Zero Trust. Until they are deleted, Access still sits in front of the app.

**Upgrading from the allowlist (`ALLOWED_EMAILS`, `OPEN_SIGNUP`):** sign-up is now open, and allowlisted users no longer share the `default` account.

1. Migrate ([Database migrations](#database-migrations)): each user then has a power and a Learn account.
2. Deploy: `pnpm run deploy`.
3. Remove the old allowlist: `npx wrangler secret delete ALLOWED_EMAILS`. (`OPEN_SIGNUP` is gone from `wrangler.jsonc`.)

Power mode is now bring-your-own-key for everyone, you included: add your own key under **Keys** in the sidebar. Server-side `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `OPENROUTER_API_KEY` are no longer used by any signed-in user, and you can delete them (`npx wrangler secret delete <name>`).

Conversations and shares under the old shared `default` account are **not carried over**: they stay in the database, unreachable. To keep a conversation, download its JSON backup (**Backup** in the power app) before you upgrade, then **Import** it after signing in. Learn accounts (`u_<userId>`) keep their lessons and credit.

`DEV_ALLOW_NO_AUTH=true` is honoured **only** while `BETTER_AUTH_SECRET` is unset, and it belongs in `.dev.vars` only. Never set it as a deployed variable.

### Membership, credit and billing

Learn mode (`/learn/`, called "simple" in the code) is always on. Learners can run it on their own OpenRouter key, which needs only `KEY_ENCRYPTION_SECRET`, and power users bring their own keys. This section sets up the two things the operator can charge for, both sold through Polar:

- **The membership**: **$10 a year plus tax**, one subscription per user that covers both apps. It is behind the flag `ANNUAL_FEE_ENABLED`, which ships `"false"`: while it is off nobody needs a membership, whatever else is configured, so any signed-in user may generate on their own keys in both apps, and the apps show no membership panel or billing section. Once the flag is `"true"` and the membership is set up (`POLAR_MEMBERSHIP_PRODUCT_ID`) on a server that stores user keys (`KEY_ENCRYPTION_SECRET`; without it there are no own keys to unlock, so nothing requires or sells the membership), the membership is required for one thing: generating on the user's own keys, in Learn, power mode and Canvas alike (any own-key call, including a review whose reviewer or branch is on one, answers 402 `membership_required` without it). Nothing else needs it. Tangent credit can be bought and spent by anyone, anywhere (Learn on either model, power and Canvas on any model); when the balance runs out, the usual 402 `payment_required` follows, or, for a Learn send or context resolve, a move to the pool while it is on. The open pool stays Learn-only and has one set of daily caps for everyone, member or not. The idea is that everyone pays a fair amount for what they use: the membership is how Tangent earns from bringing your own key, and the 10% markup is how it earns from credit. As a rule of thumb, $10 is the markup on about $100 of AI spend a year, so light users do better on credit and heavy users on their own key with the membership. Paying doesn't buy more of the pool, which is for people who can't pay (docs/DECISIONS.md, "One membership rule: own keys"). Reading, exporting, deleting and settings stay open without a membership, so nobody is locked out of their data. The operator can waive it per user (a waived user is a member). No credit comes with the membership.
- **The built-in provider** ("Tangent credit"; the endpoint `openrouter` on the operator's key): it spends the operator's OpenRouter key, so each call on it is metered and charged against prepaid credit. A provider id names only the endpoint; who pays is decided apart from it: per request in Learn (the payment choice), per branch in power (the branch's `funding`: `own-key` or `credit`). Both apps offer it, once both Polar secrets and `BUILT_IN_API_KEY` are set; until then both are own-key only and the paid option is hidden.

- **Learn** runs on it when the learner picks **Use Tangent credit**; Learn on credit ignores the learner's own key.
- **Power** lists it after the user's own providers as **Tangent credit** (the same endpoint id as the user's own OpenRouter, with `funding: 'credit'`; a branch on it stores `funding: 'credit'`), with the Learn models as suggestions and any OpenRouter model id allowed (`openModels`: the model picker becomes a text field with every suggestion as a chip under it, the current one pressed). The **Keys & credit** dialog shows the available credit, the fees and an **Add credit** link to `/billing`; Canvas's keys dialog shows the same row. Only calls on it are metered: a branch on it pays for its replies, summaries and titles, a review pays when the reviewer is Tangent credit (and for any summaries a reviewed branch on it still needs), and everything on the user's own keys stays free.
- **Credit is per user**, shared by both apps: one balance on the ledger id `u_<userId>` (the Learn account's id, so balances from before power could use credit carry over). `/api/billing` answers in both apps.

A generating request on the user's own keys, in either app, answers **402 `membership_required`** when the membership is required and the user has none (the power app and Canvas then show that branch read-only: where the message box was, a notice with **Renew membership** (to `/billing`), **Create a copy in Learn** and, while credit is sold or some is left, **Continue with Tangent credit**; `/api/me` says which fundings need the membership (`membershipNeededFor`), so the apps show it before the first refusal too; the open pool and Tangent credit never need it), then, for a call on the built-in provider, **402 `payment_required`** when the balance is short; a call on the user's own key never touches the balance or the operator's key.

Without a membership, nothing is locked away: power conversations stay listed, readable, exportable and manageable (rename, settings, delete). **Create a copy in Learn** (`POST /api/trees/:treeId/copy-to-learn`) copies a power conversation into the same user's Learn account, adapted to Learn like an imported backup, without a membership, credit or a model call, and opens it in Learn; the power conversation is left as it was.

Users pay the operator's true cost plus the markup: the model price OpenRouter reports, grossed up by OpenRouter's fee for buying credits, then +10%; and each purchase is credited net of Polar's actual fee. The markup is configuration (`MARKUP_BPS`) and, with both fees passed through, it is the operator's real margin. See [How pricing works](#how-pricing-works).

**`/pricing`** (`apps/worker/src/http/pricing-page.ts`, linked from the landing page's header, pricing card and footer) spells this out for visitors as a pricing chart: a card per plan, a Free vs. paid comparison table, and numbered notes with the fine print (fees, tax, top-up range, pool limits, what needs a membership). It is static, script-free and built from the config, so it describes what the deployment sells: the paid column is **Membership** while `ANNUAL_FEE_ENABLED` is on, else **Pay as you go** while credit is sold, else there is none; the pool rows show only while the pool is on, and web search only while `GROUNDING` isn't `off`.

Payments go through [Polar](https://polar.sh), the **merchant of record**: Polar sells to the user, computes, collects and remits sales tax and VAT, issues invoices and receipts, and handles disputes; you keep only income tax. The code talks to Polar through one adapter (`apps/worker/src/billing/providers/polar/`) behind a provider port (`apps/worker/src/billing/payments/`), so the rest of the app never names it ([docs/polar-migration/03-architecture.md](docs/polar-migration/03-architecture.md)).

1. **OpenRouter key.** Create a key just for the built-in provider at <https://openrouter.ai/settings/keys> and **give it a credit limit**: it is the backstop if anything goes wrong with metering. The built-in provider never falls back to `OPENROUTER_API_KEY`.
   ```bash
   npx wrangler secret put BUILT_IN_API_KEY
   ```
   Learn's tiers default to `deepseek/deepseek-v4.1-flash` (Normal, the default, at `high` effort) and `anthropic/claude-sonnet-5.5` (Max); change them with `LEARN_NORMAL_MODEL` / `LEARN_MAX_MODEL`. Summaries, titles and the open pool's default model run on `BACKGROUND_MODEL` (default `deepseek/deepseek-v4.1-flash`, Normal's model at `low` effort), which is no tier. These defaults come from a 2026-10 eval of the hosted models (docs/DECISIONS.md, _Hosted models from the eval_). The privacy policy names the models Tangent pays for, their makers and the hosts each is pinned to from this config (`apps/worker/src/http/hosted-ai.ts`), so a model or `*_PROVIDER_ORDER` change shows on `/privacy` without a code change. Both tiers are also the suggested models in power mode, for Tangent credit and for the user's own OpenRouter key (where Normal is the default), though power users may pick any OpenRouter model. While Max is selected, both apps say about how much more it uses than Normal, from the two models' list prices (the price table below, synced daily). Users are billed OpenRouter's reported cost, never a price table, so price changes need no update. That cost is grossed up by `OPENROUTER_FEE_BPS` (default `550` = 5.5%), OpenRouter's fee when you buy its credits. OpenRouter's minimum fee is $0.80 a purchase, so top-ups under about $15 cost more than 5.5% (a $10 top-up costs 8%): buy credits in bulk, or set `OPENROUTER_FEE_BPS` to the rate you actually pay (`800` for $10 top-ups). `BUILT_IN_PROVIDER` replaces the whole provider config (one `ProviderConfig` JSON, whose id must be `openrouter`), for example to route through AI Gateway or to add `"options": { "extraBody": { "reasoning": { "effort": "low" } } }`. How each tier asks its model is config too: its reasoning effort, reply cap and pinned OpenRouter providers (`LEARN_NORMAL_EFFORT`, `LEARN_NORMAL_REPLY_TOKENS`, `LEARN_NORMAL_PROVIDER_ORDER`, the same for `LEARN_MAX_*` and `POOL_*`, and `BACKGROUND_EFFORT` for summaries and titles; see [docs/configuration.md](docs/configuration.md)). Empty, they are the evaluated settings while a tier runs its default model, else that model's own defaults. `MODEL_PRICES` in `wrangler.jsonc` pins V4.1 Flash's price ($0.15 / $0.60 per MTok), which the pool's `max_price` routing needs: OpenRouter's model-level list price for it would admit only fp4 endpoints. `minimax/minimax-m3` is priced as a fallback candidate, so pointing a model var at it is enough; it is no default (see docs/DECISIONS.md, _Hosted tier config_).
2. **Polar organization.** Set everything up in the **sandbox** first (<https://sandbox.polar.sh>, a separate organization with its own token, products and webhook secret), then again in production. Polar reviews new accounts; an AI tutoring product is in a restricted category, so start the account review early.
   - **A credits product**, e.g. "Tangent credits": **one-time**, priced in **USD**. Its own price doesn't matter: each top-up opens a checkout with an ad-hoc USD price (tax exclusive) for the amount chosen. Put its id in `POLAR_CREDITS_PRODUCT_ID`.
   - **The membership** (optional; without it nobody needs one): a **recurring yearly** product of **$10.00**, tax behaviour **exclusive** (tax added on top). Put its id in `POLAR_MEMBERSHIP_PRODUCT_ID` (step 4). Users subscribe from the billing page (Polar's hosted checkout).
   - **Make both products private** (visibility **Private**). A purchase from Polar's public storefront carries no user id, so the webhook would have no one to credit; private products sell only through the checkouts the Worker opens.
   - **Customer portal** (_Settings → Customer portal_): members cancel, update their card and download invoices and receipts there ("Manage billing"); those are always on. Set the optional toggles:
     - _Enable subscription plan changes_: **off**. There is one plan, and a switch would move a membership to a product the Worker never sold it as.
     - _Enable subscription seat management_: **off** (there is no seat pricing).
     - _Enable subscription pause_: **off**. A paused membership counts as none, and resuming starts a new year, charged at once.
     - _Allow email address changes_: **off** (customers are matched by user id, so it would only confuse).
     - _Show metered usage_: **off**. Usage is metered in the Worker's ledger, not in Polar meters, so the tab would be empty.
     - Cancelling has no setting: a cancel in the portal sets `cancel_at_period_end`, so the membership runs to the end of the paid year. Check it once in the sandbox: after cancelling, the billing page still shows the membership as active.
   - **Webhook endpoint** (_Settings → Webhooks_, format **Raw**): URL `https://tangent.example.com/api/webhooks/polar`, and these events: `order.paid`, `refund.created`, `refund.updated`, `subscription.created`, `subscription.updated`, `subscription.active`, `subscription.canceled`, `subscription.uncanceled`, `subscription.revoked`, `subscription.past_due`. Polar has no dispute webhooks: the 10-minute cron polls disputes instead.
   - **An organization access token** (_Settings → Developers_) with the scopes the Worker uses: `checkouts:write`, `customer_sessions:write`, `customers:read`, `customers:write`, `orders:read`, `subscriptions:read`, `subscriptions:write`, `disputes:read`. Ask Polar support to enable the disputes feature if `disputes.list` is refused.
3. **Polar secrets.** Payments are enabled only when both are set:
   ```bash
   npx wrangler secret put POLAR_ACCESS_TOKEN     # polar_oat_… of the production organization
   npx wrangler secret put POLAR_WEBHOOK_SECRET   # whsec_… of the endpoint above
   ```
   `PAYMENT_PROVIDER` defaults to `polar`, and `wrangler.jsonc` sets `POLAR_SERVER` to `"production"` (unset, it is Polar's sandbox).
4. **Membership.** In `wrangler.jsonc`, set `POLAR_MEMBERSHIP_PRODUCT_ID` to the yearly product above and `ANNUAL_FEE_ENABLED` to `"true"` (either unset = no membership: everyone may use their own keys in both apps). Credit and the pool's caps are the same either way. `MEMBERSHIP_PRICE_CENTS` (default `1000`) is only what the apps display; Polar charges its product's price. The membership includes no credit. Optionally, a waiver code for friends (see [Waiving the membership](#waiving-the-membership)):
   ```bash
   npx wrangler secret put MEMBERSHIP_WAIVER_CODE
   ```
5. **Migrate and deploy** ([Database migrations](#database-migrations)): the billing and pool tables are in the baseline migration. The cron triggers (`*/10 * * * *` and the daily `23 3 * * *` in `wrangler.jsonc`) deploy with the Worker.
   ```bash
   pnpm db:migrate:remote
   pnpm run deploy
   ```
6. **Verify.** Sign in at `https://tangent.example.com/learn/`, subscribe to the membership (if you set it up) and check that the billing page shows it as active, choose **Use Tangent credit** under **How replies are paid for**, buy $5 (in the sandbox, the test card `4242 4242 4242 4242`), and check that the balance appears and goes down as you chat. In the power app, a conversation on **Tangent credit** spends the same balance. Polar's webhook settings show every delivery and its response; the Worker logs `payment_webhook_failed` when one fails. **Polar disables an endpoint after 10 consecutive failures**, so alert on that log line and on Polar's "endpoint disabled" email.

#### How pricing works

- **Membership.** **$10 a year plus tax** (an exclusive price; Polar adds the tax), one per user for both apps, renewing yearly until cancelled in the billing portal (it then runs to the end of the paid year). A membership payment adds no credit. The membership is what own keys pay Tangent; credit pays it through the markup (below). A renewal whose payment failed (`past_due`) still counts while Polar retries it.
- **The rule.** Users pay the operator's true cost plus one markup, **+10%** (`MARKUP_BPS`). "True cost" passes two fees through, so the markup is real margin:
  - **OpenRouter's credit-purchase fee** is added to the cost of each call (`OPENROUTER_FEE_BPS`, default 5.5%).
  - **Polar's fee** is deducted from each purchase: the credit is what the user paid before tax, minus the fee Polar reports for that order (`platform_fee_amount`). If an order reports no usable fee, the Worker estimates it from `POLAR_FEE_BPS` and `POLAR_FEE_FIXED_CENTS` (default 5% + 50¢) and logs `fee_estimated`.
- **Balance.** Each user has one balance in US dollars, shared by both apps and kept as integer micro-dollars: what the user paid before tax, less Polar's fee on each payment, less what they have used.
- **Charges.** Every call on the built-in provider (replies, summaries, titles, reviews) is charged `ceil(cost × (1 + fee bps / 10000) × (1 + markup bps / 10000))`, rounded up to the next micro-dollar, where `cost` is the model price OpenRouter reports for the call. The fee and markup are fixed when the call starts and stored with it, so changing the config never reprices past calls. Credit bought at one rate is spent at whatever rate applies when it is used.
- **Top-ups.** One-time payments of **$5 to $500** through Polar's hosted checkout. When Polar reports the paid order (`order.paid`), the Worker credits its pre-tax amount (`net_amount`) minus Polar's fee, once per order. The billing page shows the last purchase as "paid $5.00, credit $4.23 after payment processing".
- **Worked example.** A user buys **$5** of credit. Polar adds tax on top, say $0.40, so the card is charged $5.40. On Polar's Starter plan the fee is 5% + 50¢ (plus 1.5% on cards issued outside the US), about $0.77 here, so the user gets about **$4.23** of credit (tax never enters the balance). At **$10** the fee is about 10%, at $5 about 15%: the fixed part dominates small purchases, so consider raising `MIN_TOP_UP_CENTS` (see [docs/polar-migration/04-verification.md](docs/polar-migration/04-verification.md)). A reply that OpenRouter reports at **$0.0010** is charged $0.0010 × 1.055 × 1.10 ≈ **$0.00116**. The exact fees come from Polar and OpenRouter's current terms; check <https://polar.sh/docs/merchant-of-record/fees>.
- **Tax.** Prices exclude tax. Polar, as merchant of record, computes it at checkout from the buyer's location, adds it on top, and files and remits it. Tax never enters the balance.
- **Holds.** Each call in flight holds its worst case at its model's price until it settles: its input (estimated at 3.5 characters a token, the measure of credit's input limit) and its output cap at the price table's price, with the fee and the markup, and never less than $0.02 (`USAGE_HOLD_MICROS`). A reply is held before its prompt exists, at its whole input limit and reply cap, so starting one needs that much available: about $0.37 for a Max (Sonnet 5.5) reply at the defaults (60,000 tokens in, 16,384 out), and about $0.02 for Normal (V4.1 Flash), which the floor sets; a shorter input limit or reply length in power lowers it. The price is the model's `MODEL_PRICES` entry or built-in placeholder (every tier, suggested and background model has one), else the OpenRouter list price the daily sync stores for every listed model (a model it hasn't stored yet is looked up on demand, once per isolate within ten minutes); a model OpenRouter lists no price for can't run on credit (400), and when OpenRouter can't be reached for one, the request answers 502 to retry. On an endpoint other than OpenRouter, which the sync can't list, credit runs only the models `MODEL_PRICES` prices. A message, review or compare answer on the built-in provider can only start when the available balance (balance − holds) covers its hold; otherwise the API answers **402 `payment_required`**, naming the amount it needs ("This reply needs about $0.37 of Tangent credit available"), and the app points the user to the billing page (in power and Canvas, an error with an **Add credit** link). A reply's hold is taken in the same statement that checks the balance, before its nodes are written, so sends racing on several conversations can't overdraw it. At most 6 (`USAGE_MAX_PENDING`, as many as Canvas fans out) replies, reviews and compare answers per user may be in flight at once, across both apps (their summaries and titles ride on them); one more answers **429 `rate_limited`** until one finishes. A reply that has started is never cut off; the charge is the cost OpenRouter reports, which a list price can understate (a route dearer than the list), so the balance can still go a little negative, and the next purchase absorbs that; the credit limit on `BUILT_IN_API_KEY` is the backstop.
- **Stopped and lost replies.** Stopping a reply still costs what OpenRouter billed for it. When a stream ends without a cost, the Worker asks OpenRouter's generation endpoint (with retries), and a cron every 10 minutes settles anything left over. A call that never reached OpenRouter is charged $0, and one still unknown after 24 hours is marked `unresolved` at $0 and logged for review.
- **Refunds.** Refund in the Polar dashboard; the Worker debits the refunded pre-tax amount automatically once the refund succeeds (`refund.created` / `refund.updated`), once per refund. Polar keeps its fee on a refund, so a full refund debits the whole pre-tax amount, including the fee that was never credited; an unspent top-up refunded in full leaves the balance negative by that fee. Polar may also refund on its own to prevent a chargeback; that arrives the same way. Refunding a membership payment changes no balance; revoke the subscription as well if the membership should end. Polar has no dispute webhooks, so the 10-minute cron polls its disputes: a top-up whose dispute needs a response, is under review or is lost is debited like a refund of the disputed amount, credited back if you win (less any refund that came after it), and a lost dispute also suspends the buyer's open pool access (once; an admin can lift it). A purchase's refunds and disputes together never take back more than it paid (a refund then a dispute of the same top-up debits it once). Disputes of membership payments are handled by hand in Polar, with a manual adjustment if needed (below). Each dispute costs $15 at Polar whatever the outcome.
- **History.** `/learn/billing` and, in power, `/billing` (**Billing** in the sidebar) show the balance, top-ups and recent usage (`GET /api/billing/usage`) of both apps. A top-up returns to the billing page of the app it was bought from (`/learn/billing`, or `/billing` in power).
- **Web searches (grounding).** A reply on Tangent credit that searches the web costs about $0.007 more at OpenRouter (Exa, up to 10 results), about **$0.0081** after the fee and markup. The search fee is part of the cost OpenRouter reports for the reply, so it is charged the same way. The usage list shows such replies as "Reply + web search". Automatic searches stop for the day after `GROUNDING_AUTO_DAILY_CAP` (default 40) per user on credit; **Check sources** is never capped. Pool replies never search: a pool hold is priced from tokens alone, so a search fee would be overage the operator pays.
- **Cost bounds.** Every call on the built-in provider, in either app, sends at most `BUILT_IN_MAX_INPUT_TOKENS` (default 60,000) input tokens and 16,384 output tokens (4,096 by default on a model that doesn't reason; a reasoning model's thinking counts as output), and those calls are rate limited per user across both apps (`CHAT_RATE_LIMITER`, 30 a minute). In power the user picks the model, so a call on an expensive model costs more within the same token bounds.

- **The open pool.** Nobody buys credit for the pool: it is free credit Tangent provides, an operator expense like a free tier. Tangent sells only the membership and personal credit; the operator funds the pool with admin adjustments (below), for example also for someone who arranges shared access directly. Pool replies are charged at their true cost (the provider's price grossed up by OpenRouter's fee) with no markup, and the pool's holds are priced the same way, so a hold always covers its charge. The pool's daily caps are the same for everyone, membership or credit or neither: 30 replies and $0.10 per user (`POOL_REQUESTS_PER_DAY`, `POOL_SPEND_MICROS_PER_DAY`), under one ceiling for all users together, the lower of `POOL_DAILY_GLOBAL_MICROS` ($5) and `POOL_DAILY_GLOBAL_BPS` (20%) of the day's base (the pool's balance at 00:00 UTC plus what was added since). Paying doesn't buy more pool. No page or template may call the pool a donation or say "tax-deductible" (tests check every pool page and template).
- **Where the pool shows.** The landing page (`/welcome`, and `/` for visitors) shows the pool meter: about how many learning sessions it covers (2¢ each), the dollars (aggregates only), and where its credit comes from: "The open pool is free credit Tangent provides." Nothing on any page offers pool credit for sale. `GET /api/pool/status` serves the same meter publicly, edge-cached for a minute. `/pool` explains how the pool works, with this deployment's model and caps, and the operator's contact (`LEGAL_OPERATOR`, `LEGAL_CONTACT_EMAIL`) for questions or arrangements. The billing page of both apps has a **The open pool** section with the meter. Spending from the pool is Learn-only: Learn offers it as a way to pay (header pill, the "How replies are paid for" dialog, a credit/pool switch above the message box when both can pay), locks the Normal/Max switch to the pool's model, and shows an empty pool or a reached cap inline above the message box, keeping the message. A first pool message from an account without a Turnstile pass on record sends the learner to `/verify` once.

**Manual credit or adjustments** (goodwill credit, corrections) go through the admin API: `POST /api/admin/credit` (admins only, same-origin) with

```json
{
  "target": "personal",
  "userId": "<userId>",
  "amountCents": 500,
  "mode": "adjustment",
  "idempotencyKey": "goodwill-2026-10-05-ada",
  "note": "Goodwill"
}
```

`target` is `personal` (the user's ledger, `userId` required) or `pool` (`userId` optional: the user an arrangement is for, or omitted or `null` for an operator top-up; a simulated purchase is personal only), `amountCents` is signed (from −50000 to 50000, never 0), and repeating a request with the same `idempotencyKey` changes nothing (`"credited": false`). A negative pool adjustment never takes the pool below 0. The answer is `{ credited, amountMicros, balanceMicros }`. With `PERSONAL_CREDIT_ENABLED` set to `"true"`, granted personal credit can be spent before payments are set up.

For local testing, `"mode": "simulated_purchase"` fulfils a purchase as the payment webhook would without a processing fee, so the full amount is credited. It exists only while `DEV_PURCHASES_ENABLED` is `"true"` (in `.dev.vars`); otherwise the route answers 404. Never turn it on in production.

The same can still be done in SQL: an insert into `credit_grants` with `kind='adjustment'` and a signed amount in micro-dollars (`5000000` = $5; negative to debit). The ledger id is `u_<userId>` in both apps (`default_simple` for the dev bypass), and the pool's is `pool` (debit the pool through the API instead, which keeps it from going negative). Find it first:

```bash
npx wrangler d1 execute DB --remote --command "SELECT 'u_' || id AS ledger_id, email FROM auth_users"
npx wrangler d1 execute DB --remote --command "INSERT INTO credit_grants (id, account_id, kind, amount_micros, provider_ref, note, created_at) VALUES (lower(hex(randomblob(16))), 'u_<userId>', 'adjustment', 5000000, NULL, 'Manual credit', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
```

Use `--local` instead of `--remote` for the local database.

#### Waiving the membership

A user whose `auth_users.membership_waived` is `1` needs no membership, whatever its subscription says. Set or clear it on the [admin page](#admin) (**Member**), by hand, or give friends the code in the `MEMBERSHIP_WAIVER_CODE` secret: entering it on the billing page ("Have a code?", `POST /api/billing/membership/waiver`) sets the flag for that user (rate limited, compared in constant time). If the code leaks, change the secret (`npx wrangler secret put MEMBERSHIP_WAIVER_CODE`; set it empty to stop code redemption) and clear the flag of whoever shouldn't have it. Clearing it doesn't touch a paid membership.

```bash
# Who has it, and since when
npx wrangler d1 execute DB --remote --command "SELECT id, email, membership_waived_at FROM auth_users WHERE membership_waived = 1"
# Waive (set) or revoke (clear) it for one user
npx wrangler d1 execute DB --remote --command "UPDATE auth_users SET membership_waived = 1, membership_waived_at = COALESCE(membership_waived_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE email = 'friend@example.com'"
npx wrangler d1 execute DB --remote --command "UPDATE auth_users SET membership_waived = 0 WHERE email = 'friend@example.com'"
```

#### Testing billing locally

- **Offline, no payments or OpenRouter.** Use "Option C" in `apps/worker/.dev.vars.example`: a fake `BUILT_IN_PROVIDER` that reports a fixed cost per call, and either `PERSONAL_CREDIT_ENABLED=true` or placeholder Polar secrets so paid credit is offered. Grant yourself credit with the SQL insert above (`--local`; the account is `default_simple` with the dev bypass; signed in under Option B, `POST /api/admin/credit` does it too). The dev bypass is always admin, so `POST /api/admin/credit` with `"target": "pool"` adds credit to the pool, and with `DEV_PURCHASES_ENABLED=true` in `.dev.vars`, `"mode": "simulated_purchase"` credits your own account as a purchase would, choose **Use Tangent credit**, then chat at <http://localhost:8787/learn/> (or pick **Tangent credit** in the power app, on the same balance). Top-ups and the membership checkout won't work with placeholder secrets; leave `POLAR_MEMBERSHIP_PRODUCT_ID` empty, or set it and waive yourself with the SQL above (`--local`).
- **Polar sandbox.** Put the sandbox organization's values in `apps/worker/.dev.vars` (`POLAR_SERVER=sandbox`, `POLAR_ACCESS_TOKEN`, `POLAR_CREDITS_PRODUCT_ID`, `POLAR_MEMBERSHIP_PRODUCT_ID`). Polar must reach your webhook over the internet and has no local forwarding CLI, so run a tunnel and create a sandbox webhook endpoint on it:
  ```bash
  cloudflared tunnel --url http://localhost:8787   # prints https://<random>.trycloudflare.com
  ```
  Point the endpoint at `https://<random>.trycloudflare.com/api/webhooks/polar` with the events of step 2, set its secret as `POLAR_WEBHOOK_SECRET` and restart `wrangler dev`. Pay with the test card `4242 4242 4242 4242`. The checks still to run against the sandbox are listed in [docs/polar-migration/04-verification.md](docs/polar-migration/04-verification.md).
- **Real models.** Add `BUILT_IN_API_KEY` (and remove `BUILT_IN_PROVIDER`). Use a key with a small credit limit.

#### Not included yet

These are out of scope for now:

- Auto-recharge, free sign-up credit, promotion codes, trials, low-balance or membership-lapse emails, and multi-currency (USD only). Membership waivers and personal credit adjustments are on the [admin page](#admin) (or the admin API above); simulated purchases only through the API.
- Metered (postpaid) billing. Usage stays on the internal ledger; nothing is mirrored into Polar's meters.

### Admin

The admin page at `/admin/` (`apps/admin`) is for you, the operator. It lists users (newest first, searchable by email) and lets you:

- allow particular users to publish share links while `DMCA_AGENT_REGISTERED` is off (**May share**, stored in `auth_users.share_allowed`). The check runs on every view of a link, before the edge cache, so turning a user off takes their links down at once. Once `DMCA_AGENT_REGISTERED` is `"true"` everyone may share and the list has no effect; the page says which applies;
- see a user's shares and **Revoke** any of them, which is how to act on a takedown notice without the owner;
- see each user's credit balance (their own ledger, shared by both apps; pending holds not deducted) and add credit to it, or take it back with a negative amount (**Credit**): an `adjustment` with an optional note, no payment and no processing fee, idempotent per submit. A debit asks first and isn't clamped, so it can leave the balance below zero;
- make a user a member without paying, or take that back (**Member**: the membership waiver, `auth_users.membership_waived`, as the [waiver code](#waiving-the-membership) sets it; `PATCH /api/admin/users/<id>` with `{"membershipWaived": true}`). It applies from the user's next request. A user with a paid membership is marked **paid**; clearing a waiver leaves that membership alone, and clearing it for a user without one asks first. While the membership isn't required (`ANNUAL_FEE_ENABLED` off) the page says so, and a waiver changes nothing until it is;
- suspend or restore a user's open pool access (**Pool suspended**), and see who uses the pool most (**Open pool use**, below the users);
- see the open pool's balance, what pending reservations hold, and whether the overage breaker has tripped (**Open pool**), and top up or correct the pool there (an adjustment).

For the open pool, the admin API behind those controls:

- suspends or restores a user's pool access: `PATCH /api/admin/users/<id>` with `{"poolSuspended": true}` (or `false`), stored in `auth_users.pool_suspended` and on the user's pool identity, and checked on every pool request. It stays with the mailbox if the user deletes their account and signs up again. Nothing else about the account changes;
- credits a user's ledger or the pool: `POST /api/admin/credit` (see [Manual credit or adjustments](#how-pricing-works));
- reports the pool's balance, holds and overage breaker: `GET /api/admin/pool`;
- reports pool consumption: `GET /api/admin/pool/usage?days=7&limit=50` lists the pool's users by spend (replies, spend, last call), and today's network keys by the number of users on each. A key is a daily-rotating hash of an IPv4 address or IPv6 /64, never the address; many accounts on one key is what a farm looks like. Every refused pool request is also logged as one `pool_refused` JSON line.

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

Every var and secret is documented in [docs/configuration.md](docs/configuration.md): what it does, its default and who needs it. `wrangler.jsonc` lists only this deployment's own values, and a malformed value fails every request with an error naming it.

A new deployment sets at least `PUBLIC_BASE_URL`, `EMAIL_FROM`, `TURNSTILE_SITE_KEY` and the `LEGAL_*` vars in `wrangler.jsonc`, and the secrets `BETTER_AUTH_SECRET`, `KEY_ENCRYPTION_SECRET`, `RESEND_API_KEY`, `TURNSTILE_SECRET_KEY` and, once you have signed in, `ADMIN_USER_IDS` ([Deploying](#deploying)). Selling credit adds `BUILT_IN_API_KEY` and the `POLAR_*` settings ([Membership, credit and billing](#membership-credit-and-billing)).

**Renamed variables.** The `SIMPLE_*` names became `BUILT_IN_*` (the built-in provider, which serves Learn, Tangent credit in power and the pool), `LEARN_*` (Learn's Normal and Max tiers) and `BACKGROUND_*` (summaries and titles). There is no fallback to the old names. The one renamed secret has to be set again:

```bash
npx wrangler secret put BUILT_IN_API_KEY             # the value of OPENROUTER_SIMPLE_API_KEY
npx wrangler secret delete OPENROUTER_SIMPLE_API_KEY # once the new code is deployed
```

### Bring your own key

With `KEY_ENCRYPTION_SECRET` set, users can paste their own Anthropic / OpenAI / OpenRouter key under **Keys** (**Keys & credit** where the operator sells credit) in the power app's sidebar. A user key overrides the server secret for that provider, for replies, summaries and titles alike. Learn mode (**How replies are paid for**) stores and uses only the OpenRouter key, from the same cookie, so one OpenRouter key serves both apps; on paid credit Learn ignores it. The built-in provider (**Tangent credit**) takes no user key.

- The browser sends the key once (`POST /api/key`). The Worker checks it with one unbilled provider call (`GET /v1/models`), then seals `{ keys, exp, uid }` (the signed-in user's id) with AES-256-GCM and returns it as `__Host-llmkey` (`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`). The server stores nothing. Page scripts can't read the cookie, and the input field is cleared as soon as the key is sent.
- Each chat request carries the cookie back. The Worker decrypts it in memory, calls the provider and streams the reply. No endpoint returns any part of a key.
- If the cookie is tampered with, expired, sealed with an older secret or sealed for another user, the request gets `401 key_required`, the cookie is cleared and the UI asks for the key again. Signing out clears it too, so the next user of a shared browser never runs on the previous user's keys. **Rotating `KEY_ENCRYPTION_SECRET` revokes every stored key.**
- Limits on the proxy: same-origin requests only (`Sec-Fetch-Site`), JSON bodies only on mutations, models limited to the provider config (any well-formed id for an `openModels` provider), output tokens capped server-side, and a rate limit per key cookie.
- Trade-offs:
  - The key passes through the Worker on every request, so users trust the operator not to log it. The code never logs request headers or bodies. Keep it that way, and don't enable anything that captures them, such as Logpush with headers.
  - An XSS on the origin can spend the user's credit while the page is open, within the limits above, but it cannot extract the key.
  - Browser extensions with host permissions are out of scope.

The power app is served with a strict CSP (`apps/web/public/_headers`): `script-src 'self'`, `connect-src 'self'`, `img-src 'self'`, Trusted Types. The browser never talks to a provider directly. The simple app under `/learn/` gets the same two policies (app and login page) from the Worker (`apps/worker/src/http/learn-app.ts`), because `_headers` doesn't apply to responses the Worker generates; a test keeps the copies identical.

## Using it

This section describes the power app. The simple app at `/learn/` keeps only the essentials: a list of lessons, a chat with a Normal/Max toggle (while Max is on, a note under the message box says about how many times as much it uses as Normal), **Compare** next to Send (Normal and Max both answer the question in a window, side by side on a wide screen, one at a time with a switch on a narrow one; only the answer you keep enters the lesson, and comparing uses both models; not on the open pool), **Ask about this** on selected text (a new branch that keeps the conversation so far, opened ready to type), the tutor's suggested tangents under each reply with **Ask your own question…** after them (type and press Enter: a side question that starts with it; the newest reply's stands out, and the message box below reads "Continue this lesson…"), **Connect** on a message (a sheet to search or browse the lesson for a related message, with an optional note; both messages then list it under **Connected to N**, and following one offers **Back to …**), deleting a side question with everything below it (the trash beside a side question under its message, or beside **Back to…** while it is open; it asks first), the lesson's text size (**Aa** in the lesson header, saved in this browser apart from the other apps'; on a phone the header's tools sit on a row under the lesson title), **How replies are paid for** (your own OpenRouter key or Tangent credit), **Export** and **Import** of JSON backups (see **Backup** below), and a **Billing** page (the membership, and with credit the balance, top-ups and recent usage). The **Power | Learn** switch at the top of either app opens the other one.

- **Replying** in the composer appends to the end of the current branch ("Continue this thread…"). Anything new is meant to be a branch, a click away: **Ask about this** on a selection, **Ask your own question…** and the tangents under each reply.
- **Ask about this:** select text in a finished message and **Ask about this** floats above the composer. It opens a `path` branch quoting the selection, on the message's model, with the composer focused for your question (nothing is sent until you do). Its gear (**More**) opens **Branch from here** with the quote filled in, for another mode, model or a starting message. Selecting and pressing `b` opens that dialog too. On a branch whose funding needs the membership, the button opens the dialog, to pick a route you can use.
- **Branch from here** is available on any message. You can quote the text you highlighted, write a **starting message** (sent as the branch's first message; `Ctrl`/`Cmd+Enter` creates and asks; empty, your next message starts the branch), pick a mode, and choose a provider and model; by default a branch inherits its parent's. There is no title field: a branch is named after its first reply (until then it reads "Branch: …"); rename it in **Branch settings**.
- **"N branches"** under a message lists its children. Breadcrumbs and **↩ Parent message** take you back to the exact branch point.
- **Deleting a branch** (with everything below it, after a confirmation) works from the chat itself: the trash icon beside a branch in a message's **"N branches"** list, or beside **↩ Parent message** for the open branch. The outline and **Branch settings** offer the same.
- **Keyboard shortcuts:**

  | Keys              | Action                         |
  | ----------------- | ------------------------------ |
  | `Alt+↑` or `[`    | Go to the parent branch        |
  | `Alt+←` / `Alt+→` | Previous / next sibling branch |
  | `Alt+↓` or `]`    | First child branch             |
  | `j` / `k`         | Next / previous message        |
  | `b`               | Branch from here               |
  | `l`               | Link to another message        |
  | `/`               | Focus the composer             |
  | `i`               | Context Inspector              |
  | `+` / `-`         | Larger / smaller text          |
  | `0`               | Reset the text size            |
  | `?`               | Show all shortcuts             |

- **Text size:** **Aa** in the chat header makes the conversation's text smaller or larger (**A−** / **A+**, in steps from 85% to 140%, and **Reset to 100%**), or use `-`, `+` and `0` outside a text field (`Ctrl`/`Cmd` with `+`, `-` and `0` stay the browser's zoom). It applies to the messages (with their code, tables, tangents and sources) and to the composer; the sidebar, header and dialogs keep their size. The choice is saved in this browser; Learn and Canvas have the same **Aa**, each with a setting of its own.
- **Tangents:** a reply that ends with suggested tangents shows them under the message (**Where next?**). Clicking one branches off in `path` mode, titles the branch after it and asks it as the first message; a tangent you already followed opens its branch.
- **Links between messages:** **Link…** on any message (or `l`) links it to another message of the conversation, in any branch, with an optional note: search or browse in the dialog, or **Pick on the page instead** and click **Link here** on the other message (Esc cancels). **Link this branch…** in the chat header links a branch's first message. Linked messages show **N related** chips at both ends; a chip opens the other end, with a **Back to ‘…’** pill in the header, and edits the note or removes the link from either end. The sidebar outline counts each branch's links. Links work while power is read-only (they call no model), and two messages are linked at most once.
- **Ask your own:** every finished reply ends its **Where next?** list (after the tangents, or alone when there are none) with **Ask your own question…**. On the open branch's newest reply it is already grown and drawn stronger, without taking focus; folded by hand (its **Fold** button or Escape), it stays folded until you go elsewhere. Elsewhere, clicking it grows it into a few lines; Enter asks the question in a new `path` branch on the reply's provider and model, like a tangent, and opens it (Shift+Enter for a new line, Escape or leaving it empty folds it back). Its gear opens **Branch from here** with the question as the first message (and no starting message field), for another mode, model, quote or a private branch; cancelling keeps the question where you typed it.
- **Settings** (sidebar): your **default system prompt** for new conversations (saved to your account; **Use default** starts from the built-in one), and, saved in this browser, the default reviewer model, the models of Normal and Max, the **Reply length** and the **Input limit**. The input limit caps how much of a conversation each message sends (16,000, 32,000, 64,000 or 128,000 tokens, or a custom number from 1,000 to 2,000,000); without one, a message on your own key may send the model's whole context window less the reply (for an OpenRouter model, its real window as OpenRouter lists it, synced daily, rather than a 128,000-token default), and one on Tangent credit up to `BUILT_IN_MAX_INPUT_TOKENS`, which a limit can only lower. As you edit it, it shows that default for the open conversation's model, the number in words and paperback pages (¾ of a word a token, 275 words a page) with a comparison ("a short novel"), and, when the server has the model's price, what a message that sends that much costs in input, uncached and read from the prompt cache: on Tangent credit what credit charges (OpenRouter's list price with its fee and Tangent's markup, as billing works it out), on your own OpenRouter key the list price, which OpenRouter bills you directly. Over the limit, the oldest messages are either summarized (the default; they are left out when no summary can be written or the limit leaves no room for one) or dropped. Both settings go with each message, with **Compare**'s two answers and with reviews (where the limit bounds what the reviewer reads and the reply length caps the review), and with the **Context** panel's preview, so the panel shows what the next message will send. On Tangent credit the server's cap applies to each of them, with or without a setting.
- **Private branches** (a branch setting) are left out of every share and export, together with everything below them.
- **Sharing:**
  - Use **Share…** in the chat header to pick a scope (tree / subtree / path) and a mode (snapshot / live), plus an optional title and expiry.
  - The **Share…** dialog first lists the links that conversation already has (scope, and the branch for a subtree or path; mode; state; title; when it was created and expires; the link), each with the same copy / open / edit / republish / revoke as the **Shares** page, so you can see what's already published before making another. A link you create there joins the list.
  - The **Shares** page lists every link. From there you can republish a snapshot in place (same URL) or revoke a link, which takes effect immediately.
  - While `DMCA_AGENT_REGISTERED` is off, **Share…** appears only for accounts the operator allowed (and admins); everyone else exports instead.
- **Export:** Markdown, or a single offline HTML file that uses the same viewer as share links.
- **Backup:** the JSON backup includes everything, private branches and links between messages too (so does **Create a copy in Learn**); shares and Markdown or HTML exports leave links out. **Import** restores a backup as a new tree. Both apps use the same file (`<title>.tangent.json`), so a conversation moves between them: in Learn, **Export** (the download icon on each lesson and in a lesson's header) saves it and **Import** (above the lesson list) restores one made in either app. An import lands in the account of the app it is made in, and power imports are restored exactly. An import into Learn is adapted so it can be read and continued there: branches on a provider or model Learn doesn't offer move to Learn's **Normal** model (branches already on Normal or Max keep theirs), every side question gets the whole path as context, and the lesson gets Learn's tutor prompt instead of a custom one. Nothing is charged by an import; replies after it are paid however the learner pays in Learn (see _Import and export in Learn_ in [DECISIONS.md](docs/DECISIONS.md)). Files over 10 MB, Markdown or HTML exports and other JSON are refused with a message saying why; imports and copies into Learn are limited to 10 a minute per account.
