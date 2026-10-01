# Research notes (checked 2026-09-29)

This is a summary of the research that preceded [PLAN.md](./PLAN.md). Every point was checked against official documentation or the npm registry.

## Workers runtime
- **CPU vs wall clock.** CPU is limited to 10 ms per request on Free. On Paid the default is 30 s, configurable up to 5 min. Waiting on `fetch()` does not count as CPU. HTTP Workers have **no wall-clock limit while the client stays connected**, and subrequests have no time limit. — https://developers.cloudflare.com/workers/platform/limits/
- **Client disconnect.** Pending tasks "may be canceled" unless they are in `waitUntil`. With the `enable_request_signal` flag, `request.signal` fires when the client goes away. — https://developers.cloudflare.com/workers/runtime-apis/request/
- **`waitUntil`.** It runs for up to 30 s after the response is sent or the client disconnects. That is fine for a D1 write, but not for finishing an LLM stream. — https://developers.cloudflare.com/workers/runtime-apis/context/
- **SSE.** The pattern is a `TransformStream`, returning `readable` immediately, with headers `Content-Type: text/event-stream` and `Cache-Control: no-cache`. — https://developers.cloudflare.com/workers/examples/openai-sdk-streaming/
- **Durable Objects.**
  - A DO has unlimited wall time while a request, stream or I/O is in flight, and its CPU limit is 30 s by default.
  - It is single-threaded, which makes it the right place to serialize per tree.
  - The Free plan only has SQLite-backed DOs.
  - Sources: https://developers.cloudflare.com/durable-objects/platform/limits/ · https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- **Bundle size.** The limit is 64 MiB uncompressed, and startup must take under 1 s. — https://developers.cloudflare.com/workers/platform/limits/

## D1
- **Engine.** D1 uses SQLite's query engine. `WITH RECURSIVE` is verified locally in `apps/worker/test/smoke.test.ts`. — https://developers.cloudflare.com/d1/sql-api/sql-statements/
- **Limits.**
  - 2 MB per row/string/BLOB.
  - 100 KB per SQL statement.
  - 100 bound parameters per query.
  - 30 s per query.
  - 50 (Free) or 1000 (Paid) queries per invocation.
  - Databases of 500 MB (Free) or 10 GB (Paid).
  - Source: https://developers.cloudflare.com/d1/platform/limits/
- **Transactions.** `db.batch()` is a single transaction that rolls back as a whole. Explicit `BEGIN`/`COMMIT` is not supported. — https://developers.cloudflare.com/d1/worker-api/d1-database/
- **Migrations.**
  - Create a migration with `wrangler d1 migrations create`.
  - Apply with `wrangler d1 migrations apply <DB> --local|--remote`.
  - Set `migrations_dir` in the config.
  - Source: https://developers.cloudflare.com/d1/reference/migrations/
- **Query layer.** Drizzle supports D1, including `batch`, and drizzle-kit generates SQL that Wrangler can apply. `kysely-d1` was last released in April 2025. — https://orm.drizzle.team/docs/connect-cloudflare-d1

## LLM providers
- **Anthropic streaming.**
  - Events arrive in the order `message_start` → `content_block_start` → `content_block_delta` (`text_delta`) → `content_block_stop` → `message_delta` (cumulative `usage.output_tokens`) → `message_stop`, with `ping` events possible at any point.
  - Errors can arrive mid-stream as `event: error`.
  - Input tokens are in `message_start.message.usage`.
  - Requests use `anthropic-version: 2023-06-01`.
  - Sources: https://platform.claude.com/docs/en/build-with-claude/streaming · token counting: https://platform.claude.com/docs/en/build-with-claude/token-counting
  - Current models: `claude-opus-5-5` (default), `claude-sonnet-5-5`, `claude-fable-5-1`, and `claude-haiku-4-5` (cheap, used for summaries). Opus/Sonnet 5.5 reject `temperature` and assistant prefill, so neither is ever sent.
- **OpenAI Chat Completions.** With `stream_options.include_usage`, a final chunk with `choices: []` and usage arrives before `[DONE]`. — https://cookbook.openai.com/examples/how_to_stream_completions
- **OpenRouter.**
  - It sends `: OPENROUTER PROCESSING` comments.
  - The final usage chunk has **one** empty-delta choice.
  - Usage is always included.
  - Mid-stream errors come as a top-level `error` with HTTP 200.
  - Sources: https://openrouter.ai/docs/api-reference/streaming · https://openrouter.ai/docs/use-cases/usage-accounting
- **SDKs.** Both official SDKs run on Workers. Raw `fetch` plus one shared SSE parser keeps the providers dependency-free and runtime-agnostic, and handles the OpenRouter quirks explicitly. The Vercel AI SDK is more abstraction than we need.
- **Tokenizers.** js-tiktoken would fit in the bundle, but it only matches OpenAI tokenizers and may exceed the Free CPU limit. We use a `chars/3.5` estimate plus the real usage reported by the provider. — https://github.com/dqbd/tiktoken

## AI Gateway
- **URLs.** Anthropic: `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic`. OpenRouter: `…/openrouter/v1`. Other providers: `…/compat`. — https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/
- **Features.**
  - Free logging and analytics.
  - Retries via `cf-aig-max-attempts`.
  - Authenticated gateways via `cf-aig-authorization`.
  - **Caching does not apply to streamed responses.**
  - Sources: https://developers.cloudflare.com/ai-gateway/features/caching/ · https://developers.cloudflare.com/ai-gateway/configuration/authentication/
- **Decision.** The gateway is optional: set a per-provider `baseUrl`, plus a secret-valued header for authenticated gateways.

## Front end hosting
- **Workers Static Assets.** Workers Static Assets is Cloudflare's recommended platform for new projects; Pages is legacy for this use case. — https://developers.cloudflare.com/pages/
- **Asset config.**
  - Use `assets.not_found_handling: "single-page-application"` and `run_worker_first: ["/api/*", "/s/*"]`.
  - Browser navigations otherwise skip the Worker (`assets_navigation_prefers_asset_serving`).
  - Source: https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/
- **Angular.**
  - Angular 22.2 requires TypeScript `>=6.0 <6.1`; **TS 7 (the Go port) is unsupported**.
  - It needs Node `^22.22.3 || ^24.15 || ^26`.
  - Zoneless has been the default since v21, the builder is `@angular/build:application`, and Vitest is the default test runner.
  - Sources: https://angular.dev/reference/versions · https://angular.dev/guide/zoneless

## Authentication
- **Better Auth on Workers.** It needs `nodejs_compat` (it imports `node:async_hooks`), and the env is per request, so the instance is built from the request's env. The Drizzle adapter works with D1 (it only opens transactions for MySQL). — https://better-auth.com/docs/integrations/hono
- **Captcha plugin.** Checks the `x-captcha-response` header on the listed endpoints before they run; supports Cloudflare Turnstile. — https://better-auth.com/docs/plugins/captcha
- **Passkeys.** `@better-auth/passkey` (SimpleWebAuthn); registering needs a session by default; `rpID` must be the site's host. — https://better-auth.com/docs/plugins/passkey
- **Remember me.** Better Auth only exposes it on email+password sign-in. Internally it means: session row expires in 1 day, cookie without Max-Age, and a signed `dont_remember` cookie that stops refreshes (`setSessionCookie(ctx, session, true)`).
- **Turnstile test keys.** Site key `1x00000000000000000000AA` and secret `1x0000000000000000000000000000000AA` always pass. — https://developers.cloudflare.com/turnstile/troubleshooting/testing/
- **Resend.** `POST https://api.resend.com/emails` with a bearer key and `{ from, to, subject, html, text }`. — https://resend.com/docs/api-reference/emails/send-email
- **`_headers` detach.** A `! Header` line in a more specific rule removes a header set by a broader one, so `/login` can have its own CSP. — https://developers.cloudflare.com/workers/static-assets/headers/

## Sharing
- **Cache API.**
  - It only stores data in the local data center, and `cache.delete` purges only that colo.
  - Global purge by URL doesn't work for custom cache keys.
  - It isn't available on workers.dev previews, so use a custom domain.
  - Sources: https://developers.cloudflare.com/workers/runtime-apis/cache/ · https://developers.cloudflare.com/workers/reference/how-the-cache-works/
- **Rate limiting.** The top-level `ratelimits` binding has a period of 10 or 60 s and is enforced per location, with eventual consistency. — https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- **Sanitization.**
  - DOMPurify needs a real DOM (jsdom).
  - markdown-it with `html: false` escapes raw HTML, and its `validateLink` blocks `javascript:`, `vbscript:`, `file:` and `data:` URLs other than images. It needs no DOM, so it can be shared by Angular and the Worker.
  - Angular's `[innerHTML]` sanitizer is a second layer.
  - Sources: https://github.com/markdown-it/markdown-it · https://angular.dev/best-practices/security
- **Syntax highlighting.** The highlight.js core plus a subset of languages is tens of KB. Shiki's web bundle is 695 KB gzipped. — https://shiki.style/guide/bundles
- **HTMLRewriter.** It is available as the injection point for Open Graph tags. Because our viewer is server-rendered, we emit the tags directly instead. — https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/
