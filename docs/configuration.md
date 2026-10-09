# Configuration

Every var and secret the Worker reads, in one place. `apps/worker/src/config.ts` is the only module that reads them (`CONFIG_VARS`); a test keeps this page and that list in step.

- **Vars** go in `apps/worker/wrangler.jsonc` under `vars`. It lists only this deployment's own values: a var left out is at its default.
- **Secrets** are set with `npx wrangler secret put <NAME>` (from `apps/worker`) and never appear in `wrangler.jsonc`.
- **Local development** reads `apps/worker/.dev.vars` (copy `.dev.vars.example`), which overrides both.

An empty or unset value is the default. A malformed one (`AUTO_TITLE=yes`, a cap of `lots`, invalid JSON in `MODEL_PRICES`) fails every request with an error naming the var, so a typo never silently means something else. Booleans are `true` or `false` in any case, except `DEV_ALLOW_NO_AUTH`, which must be exactly `true`.

Each entry gives the kind, the default and who needs it.

## A new deployment

To run your own copy with sign-in and bring-your-own-key, set at least:

1. `PUBLIC_BASE_URL`, `EMAIL_FROM`, `TURNSTILE_SITE_KEY` and the `LEGAL_*` vars in `wrangler.jsonc`, and the domain in `routes`.
2. The secrets `BETTER_AUTH_SECRET`, `KEY_ENCRYPTION_SECRET`, `RESEND_API_KEY` and `TURNSTILE_SECRET_KEY`.
3. `ADMIN_USER_IDS` once you have signed in.

Selling Tangent credit adds `BUILT_IN_API_KEY` and Polar (`POLAR_*`); the membership adds `ANNUAL_FEE_ENABLED`; the open pool adds `POOL_ENABLED`. [operating.md](operating.md) walks through each.

## Deployment

- `PUBLIC_BASE_URL`: var; default the request's origin (local dev and tests only); every deployment. The public origin: share links, sign-in callbacks, magic links and the passkey relying party.
- `LEGAL_OPERATOR`: var; default `the operator of <host>`; every deployment. Legal name of whoever runs the deployment (a person or a company), for `/privacy`, `/terms` and page footers ([LEGAL.md](LEGAL.md)).
- `LEGAL_CONTACT_EMAIL`: var; default `privacy@<host>`; every deployment. Where privacy requests, legal notices and copyright complaints go. The mailbox must exist (Cloudflare Email Routing can forward it).
- `LEGAL_JURISDICTION`: var; default empty (where the operator is established); optional. Governing law of the terms, e.g. "the State of New York, USA".
- `DMCA_AGENT_REGISTERED`: var; default `false`; operators who host share links. `true` once a DMCA designated agent is registered ([LEGAL.md](LEGAL.md) §8). Until then public share links are off, except for admins and users allowed on the admin page; anyone can still export a conversation.
- `ADMIN_USER_IDS`: secret; default none; every deployment. Comma-separated Better Auth user ids of the operator's own accounts: they open `/admin/` and `/api/admin/*` and may always share. A user id is not a credential; it is a secret only to keep it out of `wrangler.jsonc`.

## Sign-in and email

- `BETTER_AUTH_SECRET`: secret; required. Signs session cookies (`openssl rand -base64 32`); rotating it signs everyone out. Unset, every `/api/*` request fails closed, unless `DEV_ALLOW_NO_AUTH` applies.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: secrets; optional. Google sign-in, offered only when both are set (redirect URI `<origin>/api/auth/callback/google`).
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`: secrets; optional. GitHub sign-in, offered only when both are set (callback URL `<origin>/api/auth/callback/github`).
- `TURNSTILE_SITE_KEY`: var; default none; every deployment. Cloudflare Turnstile site key for the magic-link form and the first-sign-in check.
- `TURNSTILE_SECRET_KEY`: secret; required for magic links. Without it, magic-link requests are refused.
- `EMAIL_PROVIDER`: var; default `resend`. `resend`, or `log`, which prints emails to the console and is allowed on localhost only.
- `EMAIL_FROM`: var; required with `resend`. Sender of magic links; its domain must be verified in Resend.
- `RESEND_API_KEY`: secret; required with `resend`.

## Power mode and the user's own keys

- `KEY_ENCRYPTION_SECRET`: secret; every deployment. 32 random bytes, base64 (`openssl rand -base64 32`). Seals the API keys users paste into their cookie; unset, bring-your-own-key is off, and so no membership is required or sold. Rotating it revokes every stored key.
- `PROVIDERS`: var; default anthropic, openai and openrouter; optional. JSON array of power mode's own-key provider configs ([Providers](#providers)). The default openrouter lists Learn's two tier models first and takes any model id.
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`: secrets; local dev only. Server keys the default provider configs name; only the local dev bypass uses them, since every signed-in user brings their own. Leave them unset in production.
- `AI_GATEWAY_TOKEN`: secret; optional. For an authenticated AI Gateway ([AI Gateway](#ai-gateway)).
- `SUMMARY_PROVIDER_ID`, `SUMMARY_MODEL`: vars; default empty (the branch's own model); optional. A cheaper model for power's summaries and titles, e.g. `anthropic` + `claude-haiku-4-5`. A user without a key for that provider gets them on the branch's own route and model instead, so on a Tangent credit branch they are billed to credit at that model's price.
- `AUTO_TITLE`: var; default `true`. `false` turns automatic branch and tree titles off in power mode.

## Web search

Grounding runs through OpenRouter's search tool, on the built-in provider and on OpenRouter with the user's own key ([DECISIONS.md](DECISIONS.md#web-search-grounding)).

- `GROUNDING`: var; default `auto`. `auto` (offered on turns a free check picks; the model decides), `always-offer`, `explicit` (only **Check sources**) or `off`.
- `GROUNDING_MAX_RESULTS`: var; default `5`; 1 to 25. Results per search. OpenRouter's Exa fee covers up to 10.
- `GROUNDING_ENGINE`: var; default `exa`. OpenRouter's search engine: `exa` (predictable price), `parallel`, or `auto` (the model's native search where it has one).
- `GROUNDING_AUTO_DAILY_CAP`: var; default `40`. Automatic searches per user per UTC day on Tangent credit; `0` = no cap. **Check sources** is never capped.

## The built-in provider and Learn's tiers

The built-in provider is OpenRouter on the operator's key (the endpoint `openrouter`). It is Learn's provider, power's **Tangent credit** and the open pool's endpoint; who pays is the request's funding, never the provider. `BUILT_IN_*` configures that provider, `LEARN_*` Learn's two tiers (Normal and Max, which power also suggests first), and `BACKGROUND_*` the model of Learn's summaries and titles, which the pool defaults to.

- `BUILT_IN_API_KEY`: secret; required to sell credit or run the pool. The OpenRouter key the built-in provider spends. Give it a credit limit in OpenRouter. There is no fallback to `OPENROUTER_API_KEY`, and no user's own provider can reach it.
- `BUILT_IN_PROVIDER`: var; default OpenRouter with Learn's tiers; optional. One `ProviderConfig` as JSON (id `openrouter`) that replaces the built-in provider: offline development, an AI Gateway, `options.extraBody` (e.g. `{"provider": {"data_collection": "deny"}}`). Its models name their tiers with `"tier": "normal"` or `"max"`, and carry their own `effort` and `providerOrder`; the `LEARN_*` request settings don't apply to it.
- `BUILT_IN_MAX_INPUT_TOKENS`: var; default `60000`. Input-token cap of one call in Learn and on Tangent credit in power; it bounds what one request can cost. Output is capped at 16,384 tokens on reasoning models (4,096 otherwise).
- `LEARN_NORMAL_MODEL`: var; default `deepseek/deepseek-v4.1-flash`. Learn's Normal tier, its default.
- `LEARN_MAX_MODEL`: var; default `anthropic/claude-sonnet-5.5`. Learn's Max tier (the name of the tier, not a maximum).
- `LEARN_NORMAL_EFFORT`, `LEARN_MAX_EFFORT`: vars; default the default model's evaluated effort while the tier runs it (Normal `high`, Max none), else none sent. How hard the tier's model thinks: `none` (thinking off), `low` or `high`, sent as OpenRouter's `reasoning`. `max` and `xhigh` are refused: at its top effort a model is far more verbose and almost never admits it doesn't know.
- `LEARN_NORMAL_REPLY_TOKENS`, `LEARN_MAX_REPLY_TOKENS`: vars; default 16,384 on a reasoning model, 4,096 otherwise; at most 16,384. A tier's reply cap, thinking and answer together. A reply that hits it is kept, marked cut off, with **Continue**; every metered call logs its finish reason (`llm_call`).
- `LEARN_NORMAL_PROVIDER_ORDER`, `LEARN_MAX_PROVIDER_ORDER`: vars; default `streamlake/fp8,deepinfra/fp8` while Normal runs V4.1 Flash, else OpenRouter's routing. OpenRouter provider slugs the tier's model is tried on first, comma-separated, fallbacks allowed. One provider keeps the prompt cache warm. Don't pin `deepseek`: OpenRouter drops DeepSeek's own endpoint for an account that denies paid-data training, and the fallbacks then scatter across ~28 providers and lose the cache.
- `LEARN_SYSTEM_PROMPT`: var; default `DEFAULT_SYSTEM_PROMPT` (`packages/shared`). Built-in prompt of new Learn trees, the tutor prompt every Learn reply sends first, and of the pool when `POOL_SYSTEM_PROMPT` is empty. Power users set their own.
- `BACKGROUND_MODEL`: var; default `deepseek/deepseek-v4.1-flash`. Learn's summaries and titles, and the pool's model when `POOL_MODEL` is empty. Not a tier: today it is Normal's model, asked differently.
- `BACKGROUND_EFFORT`: var; default `low` on the default background model, else the model's own. The effort of summaries and titles, in Learn and on the pool. They run on Normal's (or the pool's) listing of the model, so they share its pinned providers.
- `MODEL_PRICES`: var; default the built-in table (`DEFAULT_MODEL_PRICES` in `config.ts`). JSON merged over the price table, micro-USD per million tokens: `{"<model>": {"in": 150000, "out": 600000, "context": 1048576, "feeBps": 550, "cacheRead": 3000, "cacheWrite": 0}}` (`feeBps` defaults to `OPENROUTER_FEE_BPS`, the cache prices to the input price). A daily cron syncs OpenRouter's list prices; an entry here wins over the synced price. Credit and the pool hold each call at its model's price, so a model without one can't run on either. The shipped `wrangler.jsonc` pins V4.1 Flash at its pinned providers' price ($0.15 / $0.60): OpenRouter's model-level list price is no route's price, and as the pool's `max_price` it would admit only fp4 endpoints.

## Credit, membership and payments

How pricing works is in [operating.md](operating.md#how-pricing-works).

- `MARKUP_BPS`: var; default `1000` (+10%). Margin on the true provider cost of a call on Tangent credit.
- `OPENROUTER_FEE_BPS`: var; default `550` (5.5%). OpenRouter's fee on credit purchases, added to each call's reported cost before the markup. Raise it if you top OpenRouter up in amounts under ~$15, where its $0.80 minimum fee is more than 5.5%.
- `PERSONAL_CREDIT_ENABLED`: var; default `false`. `true` lets personal credit (e.g. granted by an admin) be spent before payments are configured; with payments it always may.
- `ANNUAL_FEE_ENABLED`: var; default `false`. `true` charges the yearly membership: with `POLAR_MEMBERSHIP_PRODUCT_ID` and `KEY_ENCRYPTION_SECRET` set, generating on the user's own keys needs one, in Learn, power and Canvas alike. Tangent credit and the pool never do.
- `MEMBERSHIP_PRICE_CENTS`: var; default `1000` ($10.00). The yearly price users are shown; Polar charges its product's price.
- `MEMBERSHIP_WAIVER_CODE`: secret; default none (no code redemption); optional. A code users enter to have the membership waived. Change it if it leaks.
- `PAYMENT_PROVIDER`: var; default `polar`. The payment adapter (`apps/worker/src/billing/providers/`).
- `POLAR_ACCESS_TOKEN`: secret; required for payments. A Polar organization access token (`polar_oat_…`). Payments are on only when this and `POLAR_WEBHOOK_SECRET` are set; sandbox and production tokens differ.
- `POLAR_WEBHOOK_SECRET`: secret; required for payments. Signing secret (`whsec_…`) of the webhook endpoint `/api/webhooks/polar`.
- `POLAR_SERVER`: var; default `sandbox`. `production` or `sandbox`. The default means a missing value never charges real cards.
- `POLAR_CREDITS_PRODUCT_ID`: var; default none (no top-ups). The one-time product credit top-ups are sold as; each checkout sets its own USD price, tax exclusive.
- `POLAR_MEMBERSHIP_PRODUCT_ID`: var; default none (no membership sold). The yearly membership product ($10, tax exclusive).
- `POLAR_FEE_BPS`, `POLAR_FEE_FIXED_CENTS`: vars; default `500` and `50` (Polar's Starter plan, 5% + 50¢). Polar's fee as an estimate, used only when an order reports no usable fee (logged `fee_estimated`).

## The open pool

Free credit the operator funds with admin adjustments, for Learn users who can't pay, within daily caps that are the same for everyone ([operating.md](operating.md#the-open-pool)). A pool reply's ceiling hold (`POOL_MAX_INPUT_TOKENS` in and `POOL_MAX_OUTPUT_TOKENS` out at the model's price) must fit under every daily spend cap, or the pool reports itself off and logs `pool_misconfigured`.

- `POOL_ENABLED`: var; default `false`. `true` turns the pool on; off, nothing spends from it.
- `POOL_MODEL`: var; default `BACKGROUND_MODEL`. The one model pool replies use. It must have a price.
- `POOL_EFFORT`, `POOL_PROVIDER_ORDER`: vars; default `low` and `streamlake/fp8,deepinfra/fp8` while the pool runs V4.1 Flash, else none. The pool model's effort and pinned providers, as for Learn's tiers; pinning merges with the pool's `max_price`.
- `POOL_SYSTEM_PROMPT`: var; default `LEARN_SYSTEM_PROMPT`, else the built-in prompt. The locked system prompt of pool replies.
- `POOL_MAX_INPUT_TOKENS`: var; default `16000`. Input-token cap of one pool call.
- `POOL_MAX_OUTPUT_TOKENS`: var; default `8192`. Output cap of one pool call, thinking included.
- `POOL_MAX_MESSAGE_CHARS`: var; default `4000`. The longest message a pool send accepts.
- `POOL_REQUESTS_PER_DAY`, `POOL_SPEND_MICROS_PER_DAY`: vars; default `30` and `100000` ($0.10). Per user and UTC day: replies, and spend (settled charges plus pending holds).
- `POOL_IP_REQUESTS_PER_DAY`, `POOL_IP_SPEND_MICROS_PER_DAY`: vars; default `60` and `300000` ($0.30). The same per network (IPv4 address or IPv6 /64), all users together.
- `POOL_DAILY_GLOBAL_MICROS`, `POOL_DAILY_GLOBAL_BPS`: vars; default `5000000` ($5) and `2000` (20%). What the pool may spend per UTC day, all users together: the lower of this amount and this share of the pool's balance at 00:00 UTC plus what was added since.
- `POOL_USER_PER_MINUTE`, `POOL_IP_PER_MINUTE`: vars; default `6` and `20`. Pool replies per minute, per user and per network.
- `POOL_MIN_ACCOUNT_AGE_MS`: var; default `0` (none). How old an account must be before its first pool reply.

The pool's ledger id (`pool`), its reservation timings and its overage breaker (refuse every reservation while settled charges exceeded their holds by more than $0.20 in a day) are constants in `apps/worker/src/pool/params.ts` and `config.ts`, not configuration.

## Local development

These belong in `.dev.vars` only, never in a deployment.

- `DEV_ALLOW_NO_AUTH`: var; default off. Exactly `true` skips sign-in, honoured only while `BETTER_AUTH_SECRET` is unset: every app acts as the `default_simple` account, power mode may use the server keys, and the bypass is an admin. Any other value but `false` or empty is an error.
- `DEV_PURCHASES_ENABLED`: var; default `false`. `true` lets admins credit a user as a purchase would, without a payment (`POST /api/admin/credit`, mode `simulated_purchase`). Never on in production: it is spendable credit nobody paid for.

## Bindings and triggers

Declared in `wrangler.jsonc`, not set per deployment beyond the ids:

- **`DB`**: the D1 database. Create it with `npx wrangler d1 create tangent` and copy its id into `d1_databases`.
- **`ASSETS`**: the built apps in `./site` (`scripts/assemble-assets.mjs`). `assets.run_worker_first` lists the paths the Worker sees before static assets: `/api/*`, `/s/*`, `/learn*`, `/canvas*`, `/admin*`, `/` (an exact path, or every asset request would run the Worker), `/welcome`, `/privacy`, `/terms`, `/pool`, `/pricing` and `/verify`. In local dev with `DEV_ALLOW_NO_AUTH=true`, `/` is the app; open `/welcome` for the landing page.
- **`TREE_SESSION`**, **`POOL_BANK`**: Durable Objects. One `TreeSession` per tree owns its generations; one `PoolBank` per pool serialises reservations against its balance.
- **Rate limiters**: `SHARE_RATE_LIMITER` (120/min), `CHAT_RATE_LIMITER` (30/min per key cookie, or per user on Tangent credit), `KEY_RATE_LIMITER` (10/min per account: each key save makes one verification call) and `IMPORT_RATE_LIMITER` (10/min per account: each import writes a whole tree).
- **`triggers.crons`**: every 10 minutes, the backstops (usage whose cost the stream didn't report, stale pool reservations, the pool's balance checkpoint, Polar's disputes, which have no webhook); daily at 03:23 UTC, OpenRouter's prices and model windows. `src/cron.ts` dispatches on the schedule.
- **`build`**: `pnpm -w build` runs before every `wrangler deploy` and `wrangler dev`, so a bare deploy can't ship an empty assets directory. The GitHub deploy builds once, then uploads with a copy of the config without `build` (`scripts/deploy-config.mjs`).
- **`observability`**: logs never contain users' API keys, because nothing logs request headers or bodies. Keep it that way.

## Providers

Each provider instance in `PROVIDERS` has `id`, `kind` (`anthropic` | `openai-compatible`; `fake`, a scripted provider, is for tests and offline development only), `label`, `models`, `defaultModel` and `apiKeySecret`. It can also take `baseUrl`, `headers`, `extraHeaderSecrets`, `maxContextTokens`, `maxOutputTokens`, `supportsSystemPrompt`, `options` and `openModels`. With `"openModels": true`, `models` are only suggestions and any model id the upstream knows (letters, digits and `_ . - : /`, up to 200 characters) may be used, e.g. any OpenRouter model; an unlisted model gets the provider-level limits. `apiKeySecret` and `extraHeaderSecrets` name secrets, and a provider reads only the secrets its config names. Any OpenAI-compatible endpoint is config only:

```json
[
  {
    "id": "anthropic",
    "kind": "anthropic",
    "label": "Anthropic",
    "apiKeySecret": "ANTHROPIC_API_KEY",
    "defaultModel": "claude-opus-5-5",
    "models": [
      { "id": "claude-opus-5-5", "label": "Claude Opus 5.5" },
      { "id": "claude-haiku-4-5", "label": "Claude Haiku 4.5" }
    ]
  },
  {
    "id": "openrouter",
    "kind": "openai-compatible",
    "label": "OpenRouter",
    "baseUrl": "https://openrouter.ai/api/v1",
    "apiKeySecret": "OPENROUTER_API_KEY",
    "defaultModel": "anthropic/claude-sonnet-5.5",
    "models": [{ "id": "anthropic/claude-sonnet-5.5", "label": "Claude Sonnet 5.5" }]
  }
]
```

### AI Gateway

It gives you logging, analytics and retries. Point `baseUrl` at the gateway:

- Anthropic: `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic`
- OpenRouter: `…/openrouter/v1`

For an authenticated gateway, add `"extraHeaderSecrets": { "cf-aig-authorization": "AI_GATEWAY_TOKEN" }` and store `Bearer <token>` in that secret. Gateway caching does not apply to streamed chat, so it is off.
