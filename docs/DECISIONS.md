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
- **The public viewer is a self-contained, server-rendered page, not the Angular app.** It needs only a single `/s/*` Access bypass, works on phones, uses a strict hash-based CSP, and is the *same function* as the HTML export.
- **Path-scoped Access Bypass on `/s/*` rather than a separate hostname.** There is one domain to manage. The page is self-contained under a strict CSP, and the Worker enforces the JWT on `/api/*` regardless of host.
- **Revocation is checked on every request against D1, and cache keys include `version`.** Revoke and republish take effect instantly and globally without a global purge (the Cache API is per-colo).
- **Private exclusion happens in the pure projection.** Private branches never enter the payload, and creating a share of a private target is rejected.
- **Share keys (`b0`, `m3`) are per payload.** No internal ids leak to viewers.
- **Exports exclude private branches by default.** The owner can opt in with `includePrivate=true`. JSON backups always include everything.
- **The Worker fails closed if Access isn't configured.** `DEV_ALLOW_NO_AUTH=true` is honoured only when `ACCESS_AUD` is empty, and belongs in `.dev.vars` only.
- **Markdown uses markdown-it (`html:false`) + highlight.js, shared by Angular and the Worker.** It needs no DOM, so there is one renderer and the output can't diverge. Angular's sanitizer is a second layer.

## Integration (post-merge)
- **Stale `streaming` nodes are recovered lazily**, when a fresh DO instance first serves a tree and when a client reconnects. No alarm is needed, because a restart always precedes the next access.
- **The Fake provider never auto-titles**: the title would just echo the prompt. Branches keep the readable default title, which is the anchor quote or the first words of the message.
- **Angular bundle budget warning set at 1.5 MB (≈235 kB gzipped).** zod, markdown-it and highlight.js ship with the shared packages; that is acceptable for a single-user app.
- **The Hono app lives in `apps/worker/src/app.ts` (`createApp`)**, so tests can inject a local JWKS. `index.ts` only exports the handler and the Durable Object.
- **Viewer tables use `ta-left/center/right` classes instead of inline `style`**, because the share page's strict hash-based CSP blocks inline styles.
- **A share whose fork node is filtered out** (a system, streaming or error node, or a node before a subtree target) drops that child branch and everything below it.

## Accounts (ownership groundwork, not multi-user)
- **Trees and shares carry `account_id`.** It references an `accounts` table seeded with a single `default` account in migration 0001. Existing rows backfill via the column default, so there is no data rewrite.
- **Branches, nodes and summaries inherit ownership through `tree_id`.** They have no column of their own, which keeps a future split into per-user data a matter of filtering by tree.
- **One place decides the acting account:** `resolveAccountId(identity)` in `apps/worker/src/auth/account.ts`. Today it always returns `default`. Multi-user replaces only this function, for example by keying on the Access JWT `sub` claim (stable) rather than email.
- **Services take `accountId` (default `default`).**
  - `listTrees`/`listShares` filter by it.
  - Tree-level operations (detail, update, delete, backup) and share management treat another account's rows as not found.
  - Imports are assigned to the importing account.
- **Not scoped yet (the remaining multi-user step):** routes addressed only by branch or node id (`/api/branches/:id`, `/api/nodes/:id/*`, the Durable Object). They would need a tree-ownership check before multi-user. Provider keys and budgets are also global.
- **`account_id` has no FK constraint.** SQLite cannot `ALTER TABLE … ADD COLUMN` with `REFERENCES` and a non-null default.
