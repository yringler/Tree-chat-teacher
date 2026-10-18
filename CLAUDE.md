# CLAUDE.md

Tangent: a branching LLM chat for learning. pnpm workspace; a Cloudflare Worker (Hono, D1 with Drizzle, Durable Objects) serves four Angular 22 apps and a Flutter one. Almost all code here is written by AI sessions, and the owner reviews it, so keep changes easy to review. Read [docs/DECISIONS.md](docs/DECISIONS.md) for the rules the code follows before changing an area.

## Product principles

What Tangent is for, so a case no rule covers can still be decided. The rules that follow from each are in docs/DECISIONS.md.

- **A tangent is a choice.** Every tangent can be skipped, from the reply's footer or the outline, so the one the learner opens is the one they decided is relevant. Show it from its start, with its context in view, and make its end one step away rather than the place they land.
- **Depth is not length.** A long chat buries what came first; a deep path doesn't, because at each level the learner picked that tangent over the others. Don't treat nesting as clutter to flatten, collapse or summarize away.
- **The learner's place is theirs.** Nothing moves the view, reflows text above what they're reading, or takes the focus (on a phone, the keyboard) unless they asked for it.

## Commands

```bash
pnpm install                                   # Node 24 (.nvmrc), pnpm 10, Flutter (apps/flutter/.flutter-version) on PATH
cp apps/worker/.dev.vars.example apps/worker/.dev.vars && pnpm --filter @tangent/worker db:migrate:local
pnpm dev                                       # wrangler dev on :8787, builds every app first
pnpm --filter @tangent/web start               # power app with hot reload on :4200 (simple :4201, canvas :4202, admin :4203)
pnpm test                                      # every package through turbo, cached per package (cold: minutes); prefer one file:
pnpm --filter @tangent/worker exec vitest run test/billing-ledger.test.ts
pnpm --filter @tangent/core exec vitest run test/context/assemble.test.ts
pnpm --filter @tangent/flutter test            # flutter test; `typecheck` is flutter analyze, `format` dart format
pnpm typecheck                                 # tsc and Angular strict templates everywhere
pnpm lint                                      # eslint + check-provider-neutral + check-migrations + check-cycles
pnpm format                                    # Prettier and dart format write; CI runs pnpm format:check
pnpm build                                     # the apps into apps/worker/site/
pnpm knip                                      # unused files, exports and dependencies
pnpm e2e                                       # Playwright, own wrangler dev on :8790 (E2E_PORT), fresh DB
TANGENT_LIVE=1 TANGENT_LIVE_OPENROUTER_KEY=… pnpm test:live  # spends real money: docs/runbooks/live-contract-tests.md
pnpm --filter @tangent/worker db:generate      # the migration for a schema.ts change
```

`pnpm lint` runs ESLint (typescript-eslint strict plus the type-aware promise rules), `scripts/check-provider-neutral.mjs` (no provider names in the apps or shared packages), `scripts/check-migrations.mjs` (fails while `schema.ts` has a change no migration has), `scripts/check-cycles.mjs` (no runtime import cycles) and `scripts/check-turbo-inputs.mjs` (a test's reads outside its package are in its turbo hash). `pnpm test`, `typecheck`, `coverage` and `build` run through Turborepo (`turbo.json`) and replay a package's cached result when nothing it depends on changed; `--force` reruns everything. For e2e while writing tests: `node apps/e2e/serve.mjs` in one terminal, `E2E_REUSE_SERVER=1 pnpm e2e` in another. Never run `playwright install` unless asked. To drive the Flutter app with the Dart MCP's `flutter_driver` tool, launch `apps/flutter/test_driver/app.dart`; its `enter_text` needs `set_text_entry_emulation` on, and while it is on the device keyboard can't type, so turn it off again.

## Module map

- `packages/shared`: domain types, the HTTP API route table (`api-routes.ts`) and SSE contract, zod schemas, and the pure rules both sides use (who pays: `learn-payer.ts`, `default-route.ts`; money math: `charge.ts`; tiers, pool copy). A leaf: imports nothing else of ours.
- `packages/core`: context assembly (`context/assemble.ts`, pure), `ChatService` and the generation pipeline (`generation/`), ownership and routing (`services/`), repository ports and the in-memory repositories (`@tangent/core/memory`).
- `packages/providers`: Anthropic and OpenAI-compatible providers over raw fetch, `decorateProvider`, the registry, a fake for tests.
- `packages/render`: Markdown to safe HTML, the share viewer page, Markdown export.
- `packages/web-shared`: Angular code shared by the apps. The shared engine lives here: `conversation/` (`ConversationStore`, which every app's store extends), `power/` (power and Canvas: account, keys dialog), `ui/` (composer and `ComposerController`, toasts, `Overlays` dialog stack, Compare, the `TangentHelp` sheet), `walkthrough/` (Learn's first-run walkthrough and its `CoachMark`), `core/` (API client, auth, shortcuts), `billing/`, `pool/`, `demo/` (the in-browser backend on the real `ChatService`).
- `apps/worker`: `config.ts` (all env), `routes/` (one module per resource), `do/` (`TreeSession` per tree), `billing/` (gate, meter, ledger, payments port, Polar adapter), `pool/` (`PoolBank` DO), `auth/`, `byok/`, `http/` (public pages in hono/jsx), `db/schema.ts`, `migrations/`.
- `apps/web` power app, `apps/simple` Learn, `apps/canvas` Canvas (experimental), `apps/admin` admin, `apps/e2e` Playwright.
- `apps/flutter`: Learn in Flutter (Dart; `lib/api`, `lib/state`, `lib/ui`), its web build served at `/app/`. A workspace package only so turbo runs its `flutter build web`, `flutter test` and `flutter analyze`.

## Hard rules

These come from what went wrong here before. Follow them unless the owner says otherwise in this conversation.

- **Easy to review.** Prefer small PRs, but a larger one is fine when the work belongs together. Then make each commit one coherent step that passes the checks on its own, and keep money (billing, credit, the pool, payments), auth and schema changes in their own commits.
- **Migrations through drizzle-kit only, expand-only.** Edit `schema.ts`, run `db:generate`, commit the `.sql` with its `meta/`. Never hand-write or edit an applied migration. Migrations run before the new code deploys while the old code still serves: add tables and nullable or defaulted columns; drop or rename only in a later release. Durable Object class migrations in `wrangler.jsonc` are append-only.
- **Every env var is read in `apps/worker/src/config.ts`,** and nowhere else (a test checks). Add a var only if a deployment has its own value for it; otherwise it is a constant. Document it in `docs/configuration.md` (a test checks that too).
- **No compat shims before launch.** No fallbacks to old names, no read-time mapping of old data shapes, no feature flags for things nobody uses. Rename and delete outright.
- **Comments say why, in the present.** No history ("was", "used to", "since PR…", "for one release") and no citations of plans, sections or decision ids. Link a current doc only when it adds something.
- **Bug first, test first.** Write a failing test that reproduces the bug, next to the existing tests for that area, then fix it.
- **Frozen areas.** Don't add features to the money model (credit, membership, pool and their pricing), links between messages or share links without the owner's say. Bug fixes are fine.
- **Research before building.** Before writing something nontrivial yourself (a parser, a renderer, an integration), look for best practice and a well-maintained library that already does it, and compare the candidates (a Sonnet subagent can do the survey). Write it yourself only when none fits, and say why.
- **Rendering parity.** The web apps and the Flutter app render a reply the same way. Whatever Markdown the web renderer (`packages/render`) supports, such as TeX math or Mermaid diagrams, the Flutter app supports in the same change, with the same delimiters and edge cases, and vice versa.
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
- A change Android app users will notice: a short line in `apps/flutter/android/whatsnew/whatsnew-en-US`, the next Play release's notes (500 characters in all). Say in the PR description that the notes go out with the next Play release and the file is to be emptied after it.
- Something consciously left out: `docs/DEFERRED.md`; remove the entry when it is done.
- What is collected, kept or shown to users legally: the privacy page (`apps/worker/src/http/legal.tsx`) and `docs/LEGAL.md`.
- Commands, layout or these rules: this file and the README.

Don't rewrite `docs/archive/` (history) or `docs/audits/` (dated snapshots). Owner procedures are in `docs/runbooks/`.
