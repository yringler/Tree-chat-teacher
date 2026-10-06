# Research notes (checked 2026-09-29)

This is a summary of the research that preceded [PLAN.md](./PLAN.md). Every point was checked against official documentation or the npm registry.

> **Payments moved to Polar (2026-10).** The Stripe sections below are historical; the research behind the move is in [polar-migration/01-polar-research.md](./polar-migration/01-polar-research.md).

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

## Simple mode and billing (checked 2026-10-01)

Research for the simple "Learn" app and its billing ([PLAN.md](./PLAN.md) §13). Package internals were read from the published tarballs; prices were fetched live on this date.

### Better Auth Stripe plugin

- **Version.** `@better-auth/stripe@1.7.7` matches `better-auth@1.7.7`. Peer dependencies: `stripe` `^18 || ^19 || ^20 || ^21 || ^22`, `better-call` 1.4.0, `@better-auth/core` `^1.7.7`. **`stripe@latest` is 23.0.0, outside that range**, so we pin `stripe@^22.6.2` (the newest 22.x), which pins API version `2026-08-26.dahlia`. — https://www.npmjs.com/package/@better-auth/stripe · https://better-auth.com/docs/plugins/stripe
- **Server options.** `stripe({ stripeClient, stripeWebhookSecret, createCustomerOnSignUp?, onEvent?, subscription: { enabled, plans, requireEmailVerification?, getCheckoutSessionParams?, … } })`. A plan has `name`, `priceId` or `lookupKey`, and optionally `prorationBehavior` (`create_prorations` by default, `always_invoice` or `none`), `lineItems`, `freeTrial`, `limits`, `group`.
- **Client.** `stripeClient({ subscription: true })` adds `subscription.upgrade`, `list`, `cancel`, `restore` and `billingPortal` (returns `{ url }`). Success, cancel and return URLs go through Better Auth's origin check, so relative same-origin URLs work.
- **Webhook.** `POST {basePath}/stripe/webhook`, so ours is `/api/auth/stripe/webhook`. The plugin verifies the raw body with `webhooks.constructEventAsync`, handles `checkout.session.completed` and `customer.subscription.created|updated|deleted` itself, then calls `onEvent(event)` for **every** event. If `onEvent` throws, it answers 400 and Stripe retries.
- **Schema.** `user.stripeCustomerId`, plus a `subscription` table (`id, plan, referenceId, stripeCustomerId, stripeSubscriptionId, status, periodStart, periodEnd, trialStart, trialEnd, cancelAtPeriodEnd, cancelAt, canceledAt, endedAt, seats, billingInterval, stripeScheduleId`). The docs also list `priceId`/`metadata`, but the 1.7.7 code doesn't define them.
- **Customers.** With `createCustomerOnSignUp: false`, `subscription.upgrade` finds or creates the customer (metadata `{ userId, customerType: 'user' }`) and stores `user.stripeCustomerId`. The billing portal needs that id.
- **Subscription Checkout.** `mode`, `customer`, `line_items` and the URLs are fixed by the plugin; everything else (e.g. `automatic_tax`, `tax_id_collection`, `billing_address_collection`) can be set through `getCheckoutSessionParams`. It already passes `customer_update: { name: 'auto', address: 'auto' }` for user customers.
- **No one-time payments** (docs), so prepaid credit needs our own `mode: 'payment'` Checkout Session, fulfilled from `onEvent`. **Quirk:** for a payment-mode `checkout.session.completed`, the plugin still calls `subscriptions.retrieve(session.subscription)` with `null`; that fails, is caught and logged, and `onEvent` still runs.
- **Metered prices.** The code special-cases them (no `quantity` for `usage_type: 'metered'`), although the docs say usage-based pricing is unsupported.

### stripe-node on Workers

- `stripe@22` has `exports` conditions `workerd`, `worker`, `browser` and `deno`, all pointing to `esm/stripe.esm.worker.js`. Its platform layer defaults to a fetch HTTP client and the SubtleCrypto provider, so `new Stripe(key)` works on Workers and `constructEventAsync` needs no extra crypto provider. We still pass `httpClient: Stripe.createFetchHttpClient()` explicitly for vitest-pool-workers. — https://github.com/stripe/stripe-node · https://www.npmjs.com/package/stripe

### Stripe Checkout, Tax and fees

- **Stripe Tax with Checkout.** Set `automatic_tax: { enabled: true }` in payment and subscription mode. Checkout must be able to collect an address (`customer_update: { address: 'auto' }` with an existing customer; we also require the billing address). Prices need `tax_behavior: 'exclusive'` for tax on top (inline for `price_data`), and the product needs a tax code. Registrations and the origin address are set in the Dashboard first. — https://docs.stripe.com/tax/checkout
- **Managed Payments** makes Stripe the merchant of record for digital products (tax in 80+ countries, fraud, disputes) with Checkout and subscriptions, but excludes subscriptions created outside Checkout, one-off invoices and Connect. Not used; noted as an option. — https://docs.stripe.com/payments/managed-payments
- **Meter events** (`POST /v1/billing/meter_events`, `identifier` deduplicated over at least 24 h, `timestamp` within 35 days) only matter for the rejected postpaid option. — https://docs.stripe.com/api/billing/meter-event/create
- **Dahlia shapes.** An invoice's subscription link is `invoice.parent.subscription_details` (`parent.type === 'subscription_details'`), not the legacy `invoice.subscription`; `billing_reason` and `subtotal` remain. The webhook endpoint should use the SDK's pinned API version.
- **Fees (approximate).** Cards about 2.9% + $0.30, Billing about 0.7% of recurring volume, Stripe Tax about 0.5% per transaction, and an Invoicing fee on invoices Checkout creates. — https://stripe.com/pricing

### OpenRouter

- **Usage accounting is always on.** `usage: { include: true }` and `stream_options.include_usage` are deprecated no-ops. When streaming, usage arrives only in the final chunk: `prompt_tokens`, `completion_tokens`, `total_tokens`, `cost` (credits = USD), `cost_details.upstream_inference_cost` (BYOK only), cached and reasoning token details. — https://openrouter.ai/docs/use-cases/usage-accounting
- **Generation id.** In the `X-Generation-Id` response header and as `id: "gen-…"` on every SSE chunk. Cancelling a stream stops billing only for providers that support cancellation; otherwise the whole response is billed. An aborted stream never delivers the usage chunk. — https://openrouter.ai/docs/api/reference/streaming
- **Cost after the fact.** `GET https://openrouter.ai/api/v1/generation?id=gen-…` with a Bearer key returns `data { total_cost, usage, cancelled, native_tokens_prompt, native_tokens_completion, native_tokens_reasoning, finish_reason, model, is_byok }`. In practice it 404s for a few seconds after a generation ends (undocumented), so we retry with backoff. — https://openrouter.ai/docs/api/api-reference/generations/get-generation
- **Credit fee.** OpenRouter charges about 5.5% on credit purchases, with a $0.80 minimum. — https://www.truefoundry.com/blog/openrouter-pricing · https://betonai.net/?p=1131
- **Models and prices** (live from `GET https://openrouter.ai/api/v1/models` on 2026-10-01; they drift, which is why we bill the reported cost):

  | Tier                 | OpenRouter id                | Context   | $/M in  | $/M out | Notes                                                                                                                                                   |
  | -------------------- | ---------------------------- | --------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Smart (default)      | `deepseek/deepseek-v4-pro`   | 1,048,576 | 0.2088  | 0.4176  | DeepSeek V4 Pro 0423, max output 384k. The newer `deepseek/deepseek-v4-pro-0813` costs $0.66 / $1.98                                                    |
  | Simple (default)     | `deepseek/deepseek-v4-flash` | 1,048,576 | 0.04186 | 0.08372 | DeepSeek V4 Flash 0423, max output 131k. Also listed: `deepseek/deepseek-v4.1-flash` ($0.03 / $0.50) and the alias `~deepseek/deepseek-v4-flash-latest` |
  | Simple (alternative) | `openai/gpt-oss-120b`        | 131,072   | 0.037   | 0.17    |                                                                                                                                                         |

  All three are reasoning models (`reasoning`, `include_reasoning` and `reasoning_effort` are supported). Reasoning tokens are billed and count toward `max_tokens`. — https://openrouter.ai/deepseek/deepseek-v4-pro · https://openrouter.ai/deepseek/deepseek-v4-flash · https://openrouter.ai/openai/gpt-oss-120b

### Web search (grounding, checked 2026-10-05)

- **Server tool `openrouter:web_search` (beta).** Request shape: `tools: [{ type: "openrouter:web_search", parameters: { engine, max_results (1–25), max_total_results, search_context_size, allowed_domains, excluded_domains, max_uses } }]`. The model decides whether to search and writes the query; OpenRouter runs the search and loops back to the model on its side. Usage reports `usage.server_tool_use.web_search_requests`. The model must support tool calling; `deepseek/deepseek-v4-flash` and `-pro` list `tools` and `tool_choice`. — https://openrouter.ai/docs/guides/features/server-tools/web-search · https://openrouter.ai/blog/announcements/agentic-web-tools/
- **Plugin `web` (older), and `:online`.** Shape: `plugins: [{ id: "web", engine, max_results (default 5), search_prompt, include_domains, exclude_domains }]`. It runs exactly one search on every request, with the query picked by OpenRouter. Native search exists only for OpenAI, Anthropic, Google, Perplexity and xAI models, so DeepSeek always gets Exa. `web_search_options.search_context_size` applies only to native search. — https://openrouter.ai/docs/guides/features/web-search
- **Price.** Exa is about $0.007 per search request, covering up to 10 results, then $0.001 per extra result; the results' prompt tokens are billed on top. Older pages said $4 per 1,000 results (so $0.02 for 5); the current guide prices per request. — https://openrouter.ai/docs/guides/features/web-search · https://exa.ai/docs/reference/pricing
- **Citations.** `annotations: [{ type: "url_citation", url_citation: { url, title, content, start_index, end_index } }]` on the message, in the same shape for every model. The streaming reference does not say which chunk carries them; we read both `delta.annotations` and `message.annotations`. — https://openrouter.ai/docs/api/reference/streaming
- **Cost reporting.** `usage.cost` is "the total amount charged to your account", and `GET /api/v1/generation` returns `total_cost` plus `num_search_results`, `web_search_engine` and `num_fetches`. So the search fee should be inside the cost we already bill, but neither page says so outright. — https://openrouter.ai/docs/guides/guides/usage-accounting · https://openrouter.ai/docs/api/api-reference/generations/get-generation
- **Not yet verified with a real key** (to run before turning grounding on in production):
  - the chunk shapes of annotations and of the search tool call;
  - that `usage.cost` and `total_cost` include the search fee;
  - whether `tool_choice: "required"` forces the server tool;
  - whether an aborted stream still bills a search that already ran.
- **Brave Search API (considered, not used).** $5 per 1,000 requests (Web and LLM Context endpoints), with $5 of free credit a month. It would need its own provider and metering. — https://brave.com/search/api/

### Cloudflare static assets for a second SPA

- **SPA fallback serves the root `/index.html`** for every unmatched navigation, not the nearest one, so an app under `/learn/` can't rely on `not_found_handling`. `run_worker_first` accepts an array of patterns, including `!` exclusions. — https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/
- **`_headers` rules are not applied to responses generated by Worker code,** so whatever the Worker serves for `/learn*` must set its own CSP. — https://developers.cloudflare.com/workers/static-assets/headers/
