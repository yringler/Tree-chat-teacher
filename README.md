# Tangent — branching LLM chat

Tangent is a self-hosted, single-user chat app for having tree-shaped conversations with LLMs. It runs on **Cloudflare Workers + D1 + Durable Objects** and has an **Angular** UI.

In a normal chat, digging into a side topic pollutes the main thread, and starting a new chat loses the connection to where the question came from. In Tangent any message can spawn any number of **branches**:

- Each branch has a **context mode** that decides what the model sees:
  - `path`: everything its parent saw, plus the branch's own messages.
  - `summary`: a cached summary of the parent context.
  - `independent`: only the highlighted quote or topic.
- The **Context Inspector** shows exactly what will be sent to the model, and why.
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
apps/worker         Hono API, D1 repositories, TreeSession Durable Object, Access JWT, share routes
apps/web            Angular 22 (standalone, signals, zoneless)
```

## Requirements

- **Node ≥ 22.22.3**. Node 24 is recommended (`.nvmrc`), and the Angular 22 CLI refuses older versions.
- **pnpm 10** (`corepack enable`).
- To deploy you need a Cloudflare account. The **Workers Paid** plan is recommended: the Free plan's 10 ms CPU per request is tight for streaming.
- You also need a domain on Cloudflare if you want Cloudflare Access with a share-route bypass (recommended).

## Local development

```bash
pnpm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # DEV_ALLOW_NO_AUTH=true, optional API keys
pnpm --filter @tangent/worker db:migrate:local            # create the local D1 database
pnpm dev                                                  # builds the Angular app, then `wrangler dev`
```

Open <http://localhost:8787>. Without any API keys, use the **Fake (offline)** provider, which echoes deterministic replies, so the whole app works offline. To use real providers, add `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` to `apps/worker/.dev.vars`.

For UI work with hot reload, run `pnpm --filter @tangent/worker dev` and `pnpm --filter @tangent/web start` in two terminals, then open <http://localhost:4200>. The Angular dev server proxies `/api` and `/s` to the Worker on port 8787.

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
   Do not use `workers_dev: true` in production (step 8).

### Cloudflare Access (required)

The Worker **fails closed**: every `/api/*` request returns 500 until Access is configured. There are two Access applications on the same hostname; the more specific path wins.

1. In **Zero Trust → Access → Applications → Add → Self-hosted**, create:
   - **Application 1 — "Tangent"**: domain `tangent.example.com`, no path. Policy: **Allow** → *Emails* → your email.
   - **Application 2 — "Tangent shares"**: domain `tangent.example.com`, path `s/*`. Policy: action **Bypass** → *Everyone*.

   The bypass exists because anonymous viewers must be able to open `/s/<token>`. The Worker serves those routes read-only, rate-limited, and with an allow-listed DTO.
2. Copy Application 1's **Application Audience (AUD) tag** (under *Additional settings*) and your **team domain** (`https://<team>.cloudflareaccess.com`) into `wrangler.jsonc`:
   ```jsonc
   "vars": {
     "ACCESS_TEAM_DOMAIN": "https://<team>.cloudflareaccess.com",
     "ACCESS_AUD": "<aud tag>",
     "PUBLIC_BASE_URL": "https://tangent.example.com"
   }
   ```
3. Set `"workers_dev": false` so the `*.workers.dev` URL is not reachable. The API would still reject it without a valid JWT, but the Angular bundle would be public. Then run `pnpm deploy` again.
4. **Verify.** The Worker validates `Cf-Access-Jwt-Assertion` on every `/api/*` request, using Access's JWKS and checking issuer and audience.
   ```bash
   curl -i https://tangent.example.com/api/me           # 302 to the Access login
   curl -i https://tangent.example.com/s/does-not-exist # 404 page from the Worker (bypass works)
   ```

`DEV_ALLOW_NO_AUTH=true` is honoured **only** while `ACCESS_AUD` is empty, and it belongs in `.dev.vars` only. Never set it as a deployed variable.

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | var | Cloudflare Access JWT verification (required in production) |
| `PUBLIC_BASE_URL` | var | Origin used in share links (default: the request's origin) |
| `PROVIDERS` | var | JSON array of provider configs (default: anthropic, openai, openrouter, fake) |
| `SUMMARY_PROVIDER_ID`, `SUMMARY_MODEL` | var | Cheaper model for summaries and titles, e.g. `anthropic` + `claude-haiku-4-5`. Empty = the branch's own model |
| `AUTO_TITLE` | var | `false` disables automatic branch/tree titles |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` | secret | Provider keys, referenced by name from provider configs |
| `AI_GATEWAY_TOKEN` | secret | Optional, for an authenticated AI Gateway |
| `KEY_ENCRYPTION_SECRET` | secret | 32 random bytes, base64 (`openssl rand -base64 32`). Enables bring-your-own-key; rotating it revokes every stored user key |
| `CHAT_RATE_LIMITER`, `KEY_RATE_LIMITER` | rate limit binding | Requests spending a user key (30/min per key cookie); key saves (10/min per account) |
| `DEV_ALLOW_NO_AUTH` | `.dev.vars` only | Skip Access locally |

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
