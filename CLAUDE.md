# CLAUDE.md

Tangent: a branching LLM chat for learning. pnpm workspace; a Cloudflare Worker (Hono, D1 with Drizzle, Durable Objects) serves four Angular 22 apps. Almost all code here is written by AI sessions, and the owner reviews it, so keep changes small and easy to review. Read [docs/DECISIONS.md](docs/DECISIONS.md) for the rules the code follows before changing an area.

## Commands

```bash
pnpm install                                   # Node 24 (.nvmrc), pnpm 10
cp apps/worker/.dev.vars.example apps/worker/.dev.vars && pnpm --filter @tangent/worker db:migrate:local
pnpm dev                                       # wrangler dev on :8787, builds every app first
pnpm --filter @tangent/web start               # power app with hot reload on :4200 (simple :4201, canvas :4202, admin :4203)
pnpm test                                      # every package (slow: minutes); prefer one file:
pnpm --filter @tangent/worker exec vitest run test/billing-ledger.test.ts
pnpm --filter @tangent/core exec vitest run test/context/assemble.test.ts
pnpm typecheck                                 # tsc and Angular strict templates everywhere
pnpm lint                                      # eslint + check-provider-neutral + check-migrations + check-cycles
pnpm format                                    # Prettier writes; CI runs pnpm format:check
pnpm build                                     # the four apps into apps/worker/site/
pnpm knip                                      # unused files, exports and dependencies
pnpm e2e                                       # Playwright, own wrangler dev on :8790 (E2E_PORT), fresh DB
pnpm --filter @tangent/worker db:generate      # the migration for a schema.ts change
```

`pnpm lint` runs ESLint (typescript-eslint strict plus the type-aware promise rules), `scripts/check-provider-neutral.mjs` (no provider names in the apps or shared packages), `scripts/check-migrations.mjs` (fails while `schema.ts` has a change no migration has) and `scripts/check-cycles.mjs` (no runtime import cycles). For e2e while writing tests: `node apps/e2e/serve.mjs` in one terminal, `E2E_REUSE_SERVER=1 pnpm e2e` in another. Never run `playwright install` unless asked.

## Module map

- `packages/shared`: domain types, the HTTP API route table (`api-routes.ts`) and SSE contract, zod schemas, and the pure rules both sides use (who pays: `learn-payer.ts`, `default-route.ts`; money math: `charge.ts`; tiers, pool copy). A leaf: imports nothing else of ours.
- `packages/core`: context assembly (`context/assemble.ts`, pure), `ChatService` and the generation pipeline (`generation/`), ownership and routing (`services/`), repository ports and the in-memory repositories (`@tangent/core/memory`).
- `packages/providers`: Anthropic and OpenAI-compatible providers over raw fetch, `decorateProvider`, the registry, a fake for tests.
- `packages/render`: Markdown to safe HTML, the share viewer page, Markdown export.
- `packages/web-shared`: Angular code shared by the apps. The shared engine lives here: `conversation/` (`ConversationStore`, which every app's store extends), `power/` (power and Canvas: account, keys dialog), `ui/` (composer and `ComposerController`, toasts, `Overlays` dialog stack, Compare), `core/` (API client, auth, shortcuts), `billing/`, `pool/`, `demo/` (the in-browser backend on the real `ChatService`).
- `apps/worker`: `config.ts` (all env), `routes/` (one module per resource), `do/` (`TreeSession` per tree), `billing/` (gate, meter, ledger, payments port, Polar adapter), `pool/` (`PoolBank` DO), `auth/`, `byok/`, `http/` (public pages in hono/jsx), `db/schema.ts`, `migrations/`.
- `apps/web` power app, `apps/simple` Learn, `apps/canvas` Canvas (experimental), `apps/admin` admin, `apps/e2e` Playwright.

## Hard rules

These come from what went wrong here before. Follow them unless the owner says otherwise in this conversation.

- **Small PRs.** At most ~1.5k lines of non-generated diff. Changes to money (billing, credit, the pool, payments), auth or the schema go in their own small PR.
- **Migrations through drizzle-kit only, expand-only.** Edit `schema.ts`, run `db:generate`, commit the `.sql` with its `meta/`. Never hand-write or edit an applied migration. Migrations run before the new code deploys while the old code still serves: add tables and nullable or defaulted columns; drop or rename only in a later release. Durable Object class migrations in `wrangler.jsonc` are append-only.
- **Every env var is read in `apps/worker/src/config.ts`,** and nowhere else (a test checks). Add a var only if a deployment has its own value for it; otherwise it is a constant. Document it in `docs/configuration.md` (a test checks that too).
- **No compat shims before launch.** No fallbacks to old names, no read-time mapping of old data shapes, no feature flags for things nobody uses. Rename and delete outright.
- **Comments say why, in the present.** No history ("was", "used to", "since PR…", "for one release") and no citations of plans, sections or decision ids. Link a current doc only when it adds something.
- **Bug first, test first.** Write a failing test that reproduces the bug, next to the existing tests for that area, then fix it.
- **Frozen areas.** Don't add features to the money model (credit, membership, pool and their pricing), links between messages or share links without the owner's say. Bug fixes are fine.
- **Shared logic lives once,** in `packages/web-shared` or `packages/*`, never copied between apps. If two apps need it, move it there first.
- **Money:** integer micro-dollars, never floats; every hold is one conditional statement; never log request headers or bodies (they carry users' API keys).
- **Strict TypeScript:** no `any`, no `as unknown as`, no `@ts-ignore`, no `eslint-disable`.
- **Before you finish:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm knip`, and the tests of what you touched.

## Which doc to update

Update one doc, the one that owns the fact, in the same change. Don't restate it elsewhere; link instead.

- A rule changes, or a new one with a reason: `docs/DECISIONS.md`, edited in place (it describes the present).
- A var or secret: `docs/configuration.md`.
- Deploying, setup, admin, pricing mechanics: `docs/operating.md`.
- What users see and do: `docs/user-guide.md`.
- Something consciously left out: `docs/DEFERRED.md`; remove the entry when it is done.
- What is collected, kept or shown to users legally: the privacy page (`apps/worker/src/http/legal.tsx`) and `docs/LEGAL.md`.
- Commands, layout or these rules: this file and the README.

Don't rewrite `docs/archive/` (history) or `docs/audits/` (dated snapshots). Owner procedures are in `docs/runbooks/`.
