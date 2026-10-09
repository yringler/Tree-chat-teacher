# Tangent — branching LLM chat

Tangent is a chat app for tree-shaped conversations with LLMs, built for learning. It runs on **Cloudflare Workers, D1 and Durable Objects**, with **Angular** front ends.

In a normal chat, digging into a side topic pollutes the main thread, and starting a new chat loses where the question came from. In Tangent any message can grow any number of **branches**, and each branch has a **context mode** that decides what the model sees:

- `path`: everything its parent saw, plus the branch's own messages;
- `summary`: a cached summary of the parent's conversation;
- `message`: only the message the branch forks from, plus the highlighted quote;
- `independent`: only the highlighted quote or topic.

The **Context Inspector** shows exactly what will be sent and why. Every reply suggests a few **tangents** to explore next, and replies can be grounded in a web search, with sources.

Three apps share one Worker and one sign-in:

| App           | Path       | Code          | What it is                                                                                                                                                 |
| ------------- | ---------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Power         | `/`        | `apps/web`    | Every control: context modes, inspector, reviewer, system prompts, shares, export, backups. Runs on the user's own API keys, or on prepaid Tangent credit. |
| Learn         | `/learn/`  | `apps/simple` | A tutor with nothing to configure: Normal and Max models, Compare, tangents, "Ask about this". Own OpenRouter key, Tangent credit, or the free open pool.  |
| Canvas (exp.) | `/canvas/` | `apps/canvas` | The power app's conversations as lanes on one pannable surface, each streaming on its own.                                                                 |
| Admin         | `/admin/`  | `apps/admin`  | For the operator: users, share permissions, credit, waivers, the pool.                                                                                     |

The Worker also renders the public pages (landing, `/pricing`, `/pool`, `/privacy`, `/terms`), the share viewer (`/s/…`), and in-browser demos at `/demo`, `/learn/demo` and `/canvas/demo` that need no account and call no model.

How to use the apps: [docs/user-guide.md](docs/user-guide.md).

## Quickstart (local development)

You need **Node 24** (`.nvmrc`; at least 22.22.3, which the Angular 22 CLI requires) and **pnpm 10** (`corepack enable`).

```bash
pnpm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # no sign-in (DEV_ALLOW_NO_AUTH=true)
pnpm --filter @tangent/worker db:migrate:local            # create the local D1 database
pnpm dev                                                  # wrangler dev; builds every app first
```

Open <http://localhost:8787>. Without any API keys, the demos at <http://localhost:8787/demo> and <http://localhost:8787/learn/demo> run the whole interface in the browser. To chat for real, add `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY` to `apps/worker/.dev.vars` (only the dev bypass uses them), or use "Option C" there for an offline built-in provider. "Option B" sets up real sign-in locally, with magic links printed to the console.

For UI work with hot reload, run the Worker and an app's dev server in two terminals:

```bash
pnpm --filter @tangent/worker dev       # the API on :8787
pnpm --filter @tangent/web start        # power on http://localhost:4200
pnpm --filter @tangent/simple start     # Learn on http://localhost:4201/learn/
pnpm --filter @tangent/canvas start     # Canvas on http://localhost:4202/canvas/
pnpm --filter @tangent/admin start      # Admin on http://localhost:4203/admin/
```

The dev servers proxy `/api` and `/s` to the Worker. With real sign-in, set `PUBLIC_BASE_URL` in `.dev.vars` to the dev server's origin.

### Checks

```bash
pnpm test           # Vitest everywhere; worker suites run in workerd with real D1 and Durable Objects; Angular *.dom.spec.ts render components with TestBed in happy-dom
pnpm typecheck      # tsc everywhere, Angular strict templates included
pnpm lint           # ESLint, plus the provider-neutral, migration and import-cycle checks
pnpm format:check   # Prettier (`pnpm format` rewrites)
pnpm build          # builds the four apps into apps/worker/site/
pnpm knip           # unused files, dependencies and exports
pnpm coverage       # tests with coverage, then a table per package
pnpm e2e            # Playwright against wrangler dev on port 8790
```

`pnpm e2e` builds every app and starts its own `wrangler dev` on port 8790, apart from `pnpm dev`'s 8787, with a fresh database and config in `apps/e2e/.state/` (your `.dev.vars` and local database are never read). On a new machine install Chromium once (`pnpm --filter @tangent/e2e exec playwright install chromium`, or set `PLAYWRIGHT_CHROMIUM_PATH`). If port 8790 is taken, set `E2E_PORT`. While writing tests, run `node apps/e2e/serve.mjs` in one terminal and `E2E_REUSE_SERVER=1 pnpm e2e` in another to skip the rebuild. Sign-in in the tests is the real magic-link flow, so a run needs network access for Turnstile's test keys.

CI (`.github/workflows/ci.yml`) runs the checks and the end-to-end tests on every pull request to `master`, and deploys `master` once both pass.

## Repository map

```
packages/shared      domain types, the HTTP API route table and SSE contract (zod), pure rules both sides use
packages/core        context assembly (pure), ChatService and the generation pipeline, repository ports, memory repos
packages/providers   Anthropic and OpenAI-compatible (OpenAI, OpenRouter, …) over raw fetch + SSE; a fake for tests
packages/render      Markdown to safe HTML, the self-contained viewer page, Markdown export
packages/web-shared  Angular code shared by the apps: the conversation engine, API client, auth, billing,
                     composer, dialogs, toasts, the in-browser demo backend
apps/worker          Hono API, D1 (Drizzle), the TreeSession and PoolBank Durable Objects, Better Auth,
                     billing and the open pool, public pages, share routes
apps/web             power app (Angular 22, standalone, signals, zoneless)
apps/simple          Learn
apps/canvas          Canvas (experimental)
apps/admin           admin app
apps/e2e             Playwright end-to-end tests
scripts/             build assembly, lint checks, deploy config, coverage summary
```

`pnpm build` builds the four apps and copies them into `apps/worker/site/` (`scripts/assemble-assets.mjs`): power at `/`, then `learn/`, `canvas/` and `admin/`. `wrangler.jsonc` runs that build before every `wrangler dev` and `wrangler deploy`.

## Documentation

- [CLAUDE.md](CLAUDE.md): commands, module map and the rules for changing this repo (for people and AI sessions alike).
- [docs/user-guide.md](docs/user-guide.md): using the apps.
- [docs/operating.md](docs/operating.md): deploying and running a deployment: Cloudflare and GitHub setup, sign-in, payments, admin, the open pool.
- [docs/configuration.md](docs/configuration.md): every var and secret.
- [docs/DECISIONS.md](docs/DECISIONS.md): the rules the code follows, and why.
- [docs/DEFERRED.md](docs/DEFERRED.md): known gaps, with what fixing them takes.
- [docs/LEGAL.md](docs/LEGAL.md): the legal and compliance checklist.
- [docs/runbooks/](docs/runbooks/): one-off procedures for the owner.
- [docs/archive/](docs/archive/README.md): finished plans and the old decision log, kept as history.

## License

The code is released under the [MIT License](LICENSE), © 2026 Yehuda Ringler. It covers the code only: "Tangent" and the Tangent logo are trademarks and aren't licensed, so a deployment you run yourself must use its own name and logo, and its own privacy policy and terms (the `LEGAL_*` vars; see [docs/LEGAL.md](docs/LEGAL.md)).
