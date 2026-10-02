# Tangent — branching LLM chat

Tangent is a self-hosted, single-user chat app for having tree-shaped conversations with LLMs. It runs on **Cloudflare Workers + D1 + Durable Objects** and has an **Angular** UI.

In a normal chat, digging into a side topic pollutes the main thread, and starting a new chat loses the connection to where the question came from. In Tangent any message can spawn any number of **branches**:

- Each branch has a **context mode** that decides what the model sees:
  - `path`: everything its parent saw, plus the branch's own messages.
  - `summary`: a cached summary of the parent context.
  - `independent`: only the highlighted quote or topic.
- The **Context Inspector** shows exactly what will be sent to the model, and why.
- **Review up to here** (on any assistant reply, or `v`) sends the conversation, as the model saw it, to a reviewer model of your choice (default in **Settings**). The reviewer lists corrections and says whether to continue on a stronger model. One click moves the branch to the reviewer's model, branches off on it, or puts the corrections in the message box.
- Conversations can be shared as read-only links (the whole tree, one subtree, or one path; as a frozen snapshot or live). They can also be exported as Markdown or as one self-contained HTML file.

Design docs:
- [docs/PLAN.md](docs/PLAN.md): architecture, data model, interfaces, the context algorithm and portability.
- [docs/DECISIONS.md](docs/DECISIONS.md): one-line decision log.
- [docs/RESEARCH.md](docs/RESEARCH.md): research notes, with sources.

```
packages/shared     domain types, API + SSE contract (zod), share DTO
packages/core       context assembly (pure), tree utils, share projection, services, repository ports
packages/providers  Anthropic, OpenAI-compatible (OpenAI/OpenRouter/…), Fake — raw fetch + SSE
packages/render     markdown → safe HTML, self-contained viewer page, Markdown export
apps/worker         Hono API, D1 repositories, TreeSession Durable Object, Better Auth, email, share routes
apps/web            Angular 22 (standalone, signals, zoneless)
```

## Requirements

- **Node ≥ 22.22.3**. Node 24 is recommended (`.nvmrc`), and the Angular 22 CLI refuses older versions.
- **pnpm 10** (`corepack enable`).
- To deploy you need a Cloudflare account. The **Workers Paid** plan is recommended: the Free plan's 10 ms CPU per request is tight for streaming.
- You also need a domain on Cloudflare: sign-in callbacks, magic links and passkeys are tied to one public origin.

## Local development

```bash
pnpm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # DEV_ALLOW_NO_AUTH=true (no sign-in), optional API keys
pnpm --filter @tangent/worker db:migrate:local            # create the local D1 database
pnpm dev                                                  # builds the Angular app, then `wrangler dev`
```

Open <http://localhost:8787>. Without any API keys, use the **Fake (offline)** provider, which echoes deterministic replies, so the whole app works offline. To use real providers, add `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` to `apps/worker/.dev.vars`.

To try real sign-in locally, follow "Option B" in `.dev.vars.example`: it sets a `BETTER_AUTH_SECRET`, prints magic links to the `wrangler dev` console instead of emailing them (`EMAIL_PROVIDER=log`, allowed on localhost only), and uses Cloudflare's always-pass Turnstile test keys. Passkeys work on `localhost` too. `pnpm dev` runs `wrangler dev --local-upstream localhost:8787`: without that flag, wrangler rewrites requests to the production hostname from `routes`, and Better Auth rejects the mismatched origin.

For UI work with hot reload, run `pnpm --filter @tangent/worker dev` and `pnpm --filter @tangent/web start` in two terminals, then open <http://localhost:4200>. The Angular dev server proxies `/api` and `/s` to the Worker on port 8787. With real sign-in, set `PUBLIC_BASE_URL=http://localhost:4200` in `.dev.vars` so links and passkeys use that origin.

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
4. **Set the provider secrets** you need. They are Worker secrets and are never sent to the browser.
   ```bash
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put OPENAI_API_KEY        # optional
   npx wrangler secret put OPENROUTER_API_KEY    # optional
   ```
   Provider secrets are optional if users bring their own keys. To allow that, set the key-sealing secret (next section):
   ```bash
   openssl rand -base64 32 | npx wrangler secret put KEY_ENCRYPTION_SECRET
   ```
5. **Attach a custom domain.** Add this to `wrangler.jsonc`:
   ```jsonc
   "routes": [{ "pattern": "tangent.example.com", "custom_domain": true }]
   ```
   The edge cache for share pages only works on a custom domain.
6. **Deploy.** This builds the Angular app and deploys the Worker together with the static assets.
   ```bash
   pnpm deploy
   ```
   Do not use `workers_dev: true` in production (see step 8 of "Sign-in" below).

### Sign-in (required)

Sign-in uses [Better Auth](https://better-auth.com) with **no passwords**: Google, GitHub, a magic link by email, or a passkey. The Worker **fails closed**: every `/api/*` request returns 500 until `BETTER_AUTH_SECRET` is set, and nobody can sign in until their email is on `ALLOWED_EMAILS`.

1. **Session secret.** It signs session cookies; rotating it signs everyone out.
   ```bash
   openssl rand -base64 32 | npx wrangler secret put BETTER_AUTH_SECRET
   ```
2. **Who may sign in.** Set the `ALLOWED_EMAILS` secret to a comma-separated list (`you@example.com, @yourcompany.com` allows a whole domain). It's a secret rather than a var so the addresses stay out of git. Also set `PUBLIC_BASE_URL` in `wrangler.jsonc` to your origin.
   ```bash
   npx wrangler secret put ALLOWED_EMAILS
   ```
   Everyone on the list shares the one built-in account (Tangent is single-user; see *Accounts* in [DECISIONS.md](docs/DECISIONS.md)). Users not on the list are never created and never sent a magic link, and removing an email locks out its existing sessions on the next request.
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
   - Google: in Google Cloud Console → *APIs & Services → Credentials*, create an OAuth client ID (*Web application*) with the redirect URI `https://tangent.example.com/api/auth/callback/google`.
   - GitHub: in *Settings → Developer settings → OAuth Apps*, create an app with the callback URL `https://tangent.example.com/api/auth/callback/github`.
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

**Upgrading from the Cloudflare Access setup:** run `pnpm db:migrate:remote` (migration `0002_auth` adds the sign-in tables), set the secrets and vars above, deploy, then delete both Access applications ("Tangent" and "Tangent shares") in Zero Trust. Until they are deleted, Access still sits in front of the app. Existing conversations belong to the built-in account, so they appear as soon as you sign in.

`DEV_ALLOW_NO_AUTH=true` is honoured **only** while `BETTER_AUTH_SECRET` is unset, and it belongs in `.dev.vars` only. Never set it as a deployed variable.

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `PUBLIC_BASE_URL` | var | Public origin: share links, sign-in callbacks, magic links, passkey relying party (default: the request's origin; set it in production) |
| `ALLOWED_EMAILS` | secret | Who may sign in: emails and/or `@domain` entries, comma-separated. Empty = nobody |
| `EMAIL_PROVIDER` | var | `resend` (default) or `log` (prints emails to the console; localhost only) |
| `EMAIL_FROM` | var | Sender address for magic links (its domain must be verified in Resend) |
| `TURNSTILE_SITE_KEY` | var | Cloudflare Turnstile site key for the magic-link form |
| `PROVIDERS` | var | JSON array of provider configs (default: anthropic, openai, openrouter, fake) |
| `SUMMARY_PROVIDER_ID`, `SUMMARY_MODEL` | var | Cheaper model for summaries and titles, e.g. `anthropic` + `claude-haiku-4-5`. Empty = the branch's own model |
| `AUTO_TITLE` | var | `false` disables automatic branch/tree titles |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` | secret | Provider keys, referenced by name from provider configs |
| `AI_GATEWAY_TOKEN` | secret | Optional, for an authenticated AI Gateway |
| `BETTER_AUTH_SECRET` | secret | Signs session cookies (`openssl rand -base64 32`). Required; rotating it signs everyone out |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | secret | OAuth apps; each provider is offered only when both of its values are set |
| `TURNSTILE_SECRET_KEY` | secret | Turnstile secret; without it magic-link sign-in is refused |
| `RESEND_API_KEY` | secret | Resend API key for magic-link emails |
| `KEY_ENCRYPTION_SECRET` | secret | 32 random bytes, base64 (`openssl rand -base64 32`). Enables bring-your-own-key; rotating it revokes every stored user key |
| `CHAT_RATE_LIMITER`, `KEY_RATE_LIMITER` | rate limit binding | Requests spending a user key (30/min per key cookie); key saves (10/min per account) |
| `DEV_ALLOW_NO_AUTH` | `.dev.vars` only | Skip sign-in locally (only while `BETTER_AUTH_SECRET` is unset) |

**Providers.** Each provider instance in `PROVIDERS` has `id`, `kind` (`anthropic` | `openai-compatible` | `fake`), `label`, `models`, `defaultModel` and `apiKeySecret`. It can also take `baseUrl`, `headers`, `extraHeaderSecrets`, `maxContextTokens`, `maxOutputTokens`, `supportsSystemPrompt` and `options`. Any OpenAI-compatible endpoint is config only:

```json
[
  { "id": "anthropic", "kind": "anthropic", "label": "Anthropic", "apiKeySecret": "ANTHROPIC_API_KEY",
    "defaultModel": "claude-opus-5-5",
    "models": [{ "id": "claude-opus-5-5", "label": "Claude Opus 5.5" }, { "id": "claude-haiku-4-5", "label": "Claude Haiku 4.5" }] },
  { "id": "openrouter", "kind": "openai-compatible", "label": "OpenRouter", "baseUrl": "https://openrouter.ai/api/v1",
    "apiKeySecret": "OPENROUTER_API_KEY", "defaultModel": "anthropic/claude-sonnet-5.5",
    "models": [{ "id": "anthropic/claude-sonnet-5.5", "label": "Claude Sonnet 5.5" }] }
]
```

**AI Gateway (optional).** It gives you logging, analytics and retries. Point `baseUrl` at the gateway:
- Anthropic: `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic`
- OpenRouter: `…/openrouter/v1`

For an authenticated gateway, add `"extraHeaderSecrets": { "cf-aig-authorization": "AI_GATEWAY_TOKEN" }` and store `Bearer <token>` in that secret. Gateway caching does not apply to streamed chat, so it is off.

### Bring your own key

With `KEY_ENCRYPTION_SECRET` set, users can paste their own Anthropic / OpenAI / OpenRouter key under **Keys** in the sidebar. A user key overrides the server secret for that provider, for replies, summaries and titles alike.

- The browser sends the key once (`POST /api/key`). The Worker checks it with one unbilled provider call (`GET /v1/models`), then seals `{ keys, exp }` with AES-256-GCM and returns it as `__Host-llmkey` (`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`). The server stores nothing. Page scripts can't read the cookie, and the input field is cleared as soon as the key is sent.
- Each chat request carries the cookie back. The Worker decrypts it in memory, calls the provider and streams the reply. No endpoint returns any part of a key.
- If the cookie is tampered with, expired, or sealed with an older secret, the request gets `401 key_required`, the cookie is cleared and the UI asks for the key again. **Rotating `KEY_ENCRYPTION_SECRET` revokes every stored key.**
- Limits on the proxy: same-origin requests only (`Sec-Fetch-Site`), JSON bodies only on mutations, models limited to the provider config, output tokens capped server-side, and a rate limit per key cookie.
- Trade-offs:
  - The key passes through the Worker on every request, so users trust the operator not to log it. The code never logs request headers or bodies. Keep it that way, and don't enable anything that captures them, such as Logpush with headers.
  - An XSS on the origin can spend the user's credit while the page is open, within the limits above, but it cannot extract the key.
  - Browser extensions with host permissions are out of scope.

The Angular app is served with a strict CSP (`apps/web/public/_headers`): `script-src 'self'`, `connect-src 'self'`, `img-src 'self'`, Trusted Types. The browser never talks to a provider directly.

## Using it

- **Replying** in the composer appends to the end of the current branch.
- **Branch from here** is available on any message. You can quote the text you highlighted, pick a mode, and choose a provider and model; by default a branch inherits its parent's.
- **"N branches"** under a message lists its children. Breadcrumbs and **↩ Parent message** take you back to the exact branch point.
- **Keyboard shortcuts:**

  | Keys | Action |
  |---|---|
  | `Alt+↑` or `[` | Go to the parent branch |
  | `Alt+←` / `Alt+→` | Previous / next sibling branch |
  | `Alt+↓` or `]` | First child branch |
  | `j` / `k` | Next / previous message |
  | `b` | Branch from here |
  | `/` | Focus the composer |
  | `i` | Context Inspector |
  | `?` | Show all shortcuts |
- **Private branches** (a branch setting) are left out of every share and export, together with everything below them.
- **Sharing:**
  - Use **Share…** in the chat header to pick a scope (tree / subtree / path) and a mode (snapshot / live), plus an optional title and expiry.
  - The **Shares** page lists every link. From there you can republish a snapshot in place (same URL) or revoke a link, which takes effect immediately.
- **Export:** Markdown, or a single offline HTML file that uses the same viewer as share links.
- **Backup:** the JSON backup includes everything, private branches too. **Import** restores a backup as a new tree.
