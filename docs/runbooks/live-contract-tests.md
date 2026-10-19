# Live contract tests

A suite that spends a little real money (a few cents a run) to check that the providers still behave as Tangent assumes, and that Tangent's own money code charges correctly against them: the stream contract of each adapter, OpenRouter's reported costs against the price table, web search fees, prompt caching, reasoning effort, the credit and open-pool meters and their settlement, the hosted backend chain (Anthropic's own API first, OpenRouter behind it: settlement by tokens, a stopped reply, the fallback and the circuit breaker), and one Learn reply per funding through the whole Worker. Run it about once a month, and after a change to a provider adapter, the meter or the price table.

It lives in `apps/worker/test/live/` and runs in workerd like the Worker suite, with production's provider and price vars (`wrangler.jsonc`): the harness sets only switches such as the dev sign-in bypass, the fake payment provider and the pool and credit being on (`test/live/bindings.ts`; the preflight fails if it sets any var that chooses a model or a price). The exceptions are the credit scenarios on Anthropic's own API, which put the built-in provider on Anthropic (`BUILT_IN_PROVIDER`, `claude-haiku-5-5` with web search) and price that model (`MODEL_PRICES`: $0.10 / $0.50, cache read $0.01) in their own copy of the env, so the native search fee can be checked through the real meter; and the chain scenarios (`75-chain.live.ts`), which set `BUILT_IN_BACKENDS` to `anthropic,openrouter` and `BUILT_IN_ANTHROPIC_API_KEY` to the run's Anthropic key in their own copy of the env, and price Haiku at its synced list price. It is never part of `pnpm test`.

## Running it

```bash
TANGENT_LIVE=1 TANGENT_LIVE_OPENROUTER_KEY=sk-or-v1-… pnpm test:live
```

| Variable                           | Meaning                                                                                                                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TANGENT_LIVE`                     | Must be `1`: the suite refuses to start otherwise.                                                                                                                                                             |
| `TANGENT_LIVE_OPENROUTER_KEY`      | Required. Reaches the Worker as `BUILT_IN_API_KEY` and `OPENROUTER_API_KEY`.                                                                                                                                   |
| `TANGENT_LIVE_ANTHROPIC_KEY`       | Optional; without it the Anthropic scenarios, direct, on credit and on the backend chain, are SKIPPED (the wrong-key refusal still runs). Reaches the Worker as `ANTHROPIC_API_KEY`.                           |
| `TANGENT_LIVE_OPENAI_KEY`          | Optional, as above, for OpenAI (`OPENAI_API_KEY`).                                                                                                                                                             |
| `TANGENT_LIVE_BUDGET_USD`          | The most the run may spend (default `1.00`, at most 20). Each call reserves its worst case first and a call that would pass the budget is not sent; a reported cost then replaces the worst case.              |
| `TANGENT_LIVE_ALLOW_UNLIMITED_KEY` | `1` lets the run use an OpenRouter key without a credit limit. By default the preflight refuses one, and a key whose remaining limit is under the budget.                                                      |
| `TANGENT_LIVE_RECORD`              | `1` records each scenario's response that met its expectation as a fixture in `packages/providers/test/fixtures/live/`, which `packages/providers/test/recorded.test.ts` replays offline in every `pnpm test`. |

Only the vitest config reads these; the Worker gets the keys under their production secret names and reads them through `config.ts` as it always does.

`pnpm test:live` sets `NODE_USE_ENV_PROXY=1`, so the host's `fetch` uses an `HTTPS_PROXY` where the machine has one (Claude Code's cloud sessions do). The host reaches only `openrouter.ai`, `api.anthropic.com` and `api.openai.com`; Turnstile is answered locally and everything else is refused.

### The key

Use a key of its own for the suite, with a credit limit of a few dollars (openrouter.ai, Settings, API keys). The preflight reads `GET /api/v1/key` and stops the run before any paid call when the key has no limit or less left than the budget.

## Reading the report

`apps/worker/.live/report.md` (git-ignored) has one row per scenario: the adapter and model, the upstream that served it, its tokens, the cost the stream reported, the same tokens at the price credit holds the model at, their ratio, and **PASS**, **WARN**, **FAIL** or **SKIPPED** with notes. Below the table: the budget and what was committed, the key's usage before and after (OpenRouter counts it with a delay, so the postflight only warns on a gap), the shapes OpenRouter's streams had (the `x-generation-id` header, `tool_calls`, `annotations`, any in-stream error chunk), and answers to one-off probes.

- **FAIL**: an assumption the code relies on broke (a field moved, a cost over the price table, a row not settled at its reported cost, a key accepted that should be refused). Read the note; it says what was expected.
- **WARN**: a soft check (a cache miss, effort not changing the thinking, a ratio outside its band, a late generation). Worth a look; not a breach.
- A **SKIPPED** row names the missing key.
- A note `attempt N: rate_limit (HTTP 429), retry-after … ms` is a retryable error the harness retried, with the wait the provider asked for when it named one.
- The credit rows on Anthropic's own API are priced from their tokens plus $0.01 per search Anthropic counted; Anthropic reports no cost, so compare their charges with what the Anthropic Console's usage page billed for the run, by hand.
- The chain scenarios (`75-chain.live.ts`) run Haiku with Anthropic first and OpenRouter behind it:
  - a searched reply over two turns: each row on `anthropic` / `claude-haiku-5-5`, settled by its tokens at the synced price plus $0.01 per search, within its hold; the second turn should read the prompt cache (WARN if not). Compare with the Console by hand, as above.
  - a reply stopped after 50 text deltas: charged its input at the input price plus the streamed text at 3.5 characters a token at the output price, no output recorded (a FAIL that names one output token means message_start's placeholder count was charged). The note gives the text streamed before the stop.
  - an Anthropic overload, faked (a stub of `fetch` answers HTTP 529 with `retry-after: 45`; nothing reaches Anthropic): one row, moved to `openrouter`, settled at OpenRouter's reported cost; the client sees nothing of the refused leg; a `backend_fallback` line is logged; and the next call starts on OpenRouter while Anthropic's breaker is open.

Bands and pins in the scenarios (the per-model cost ratio in `40-reconcile.live.ts`, the search fee in `30-search.live.ts`, the Gemini that refuses an effort of `none` in `60-effort.live.ts`) were set from a run; when one fails because the provider changed, update it in the same change that adapts the code, and say so.

## What it can't check

miniflare passes no cancel on to the host, so an aborted call's upstream generation runs to its end during the suite: the abort scenarios check that the adapter ends at once and that the generation can be billed, not that the upstream stopped.

## Running it monthly from a scheduled task

The owner sets this up once:

1. A Claude Code cloud environment for this repository with:
   - **Network access**: Limited, with `openrouter.ai`, `api.anthropic.com` and `api.openai.com` under Allowed domains (and the package managers left allowed, for `pnpm install`).
   - **Environment variables** (or Network secrets where offered): `TANGENT_LIVE_OPENROUTER_KEY` (the suite's own limited key), and `TANGENT_LIVE_ANTHROPIC_KEY` and `TANGENT_LIVE_OPENAI_KEY` if those adapters should run. Never paste a key into a chat.
2. GitHub access for the repository, so the task can open issues and draft pull requests.
3. A scheduled task in that environment, a fresh session per run, monthly (for example `CRON_TZ=America/New_York 47 8 3 * *`), with this prompt:

> Run the live contract suite of the Tangent repository and report on it. Follow docs/runbooks/live-contract-tests.md.
>
> 1. On a new branch `live-contract/<yyyy-mm-dd>` from `master`: `pnpm install`, then `TANGENT_LIVE=1 TANGENT_LIVE_RECORD=1 TANGENT_LIVE_BUDGET_USD=1.00 pnpm test:live`. The keys are in the environment; never print, echo or write a key anywhere, and never pass one on a command line you show.
> 2. Read `apps/worker/.live/report.md`.
> 3. If any row is **FAIL**: find the open GitHub issue labelled `live-contract` and comment on it, or open one with that label, with the report's table and footer pasted and, for each failure, what the note says broke and where in the code that assumption lives. Don't change money code (billing, credit, the pool, payments, prices) to make a check pass; describe what you'd change instead.
> 4. If the recorded fixtures under `packages/providers/test/fixtures/live/` changed: check every changed file by eye for keys or personal data, run `pnpm --filter @tangent/providers test`, and open a draft pull request with them, linking the issue if there is one. If the suite FAILed, say in the PR that the fixtures came from a failing run.
> 5. Never merge anything. End with a summary: the counts of PASS, WARN, FAIL and SKIPPED, the total spend, and links to the issue and the pull request.

The task needs no permission rules of its own beyond what a session in that environment has. If it runs with permission prompts on, it needs to run `pnpm install`, `pnpm test:live`, `pnpm --filter @tangent/providers test` and `git`, and to use GitHub to comment on issues and open draft pull requests.
