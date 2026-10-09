# Tangent: plan

Tangent is a self-hosted web app for tree-structured LLM conversations. It runs on Cloudflare Workers with D1 and a Durable Object, and has two Angular front ends: the full-featured **power app** at `/` (bring-your-own-key), and the **simple app** ("Learn") at `/learn/`, a tutor on OpenRouter that runs on the learner's own key or on paid credit (§13). Anyone can sign up and switch between the two.

The idea: any message can spawn child **branches**. Each branch sends the model exactly the context its **context mode** allows. The UI is a linear chat of the selected branch's path plus a collapsible outline of the branches.

> The source of truth for contracts is the code in `packages/shared/src` and `packages/core/src/repository.ts`. This document summarizes them and explains why they look the way they do. Research notes, with links to the docs they came from, are in [RESEARCH.md](./RESEARCH.md). One-line decisions are in [DECISIONS.md](./DECISIONS.md).

---

## 1. Architecture

```
Power app  /  (owner)     Simple app  /learn/  (learners)       Anonymous visitor / viewer (phone/desktop)
   │  fetch + SSE (/api/*), Better Auth session cookie              │  GET /, /welcome, /learn/demo, /s/<token>
   ▼                                                                ▼
┌───────────────────────────────── Worker "tangent" (Hono) ──────────────────────────────────┐
│ static assets ./site: power app at / (SPA fallback)                                        │
│ run_worker_first: /api/*, /s/*, /learn, /learn/*, / (exact), /welcome                      │
│ / → no session cookie (and no dev bypass): landing page; else power index.html + CSP       │
│ /welcome → landing page, always (http/landing.ts: Worker-rendered, no JS, hash CSP)        │
│ /learn, /learn/* → simple app files, or its index.html + CSP (http/learn-app.ts)           │
│ /learn/demo → simple app; runs in the browser (in-memory ChatService, no model calls)      │
│ /api/auth/*  → Better Auth (Google, GitHub, magic link, passkey; D1 tables)                │
│ /api/webhooks/:provider → adapter.parseWebhook → apply.ts → ledger         ◄── Polar       │
│ /api/*       → session → account: power `default` | simple `u_<userId>` → owner routes     │
│ /api/billing → balance, usage, checkout, membership, portal, waiver code   ──► Polar       │
│ /s/*         → rate limit → ShareService.checkPublic → edge cache → viewer HTML / JSON     │
│ POST /api/branches/:id/messages ─┐ (402 without membership, or low credit on tangent)      │
│ GET  /api/nodes/:id/stream ──────┼─► Durable Object TreeSession (one per tree)             │
│ POST /api/nodes/:id/cancel ──────┘   owns the generation: provider fetch, buffers          │
│                                      deltas, fans out SSE, persists. Simple accounts:      │
│                                      metered registry → usage_events                       │
│ scheduled (cron */10 * * * *) → reconcile pending usage_events                             │
│ D1 (Drizzle) ◄── D1 repositories, Better Auth adapter, billing ledger                      │
└────────────────────────────────────────────────────────────────────────────────────────────┘
           │ fetch (raw, SSE)                                  optional
           ▼                                                   ▼
   Anthropic Messages API / OpenAI-compatible (OpenAI, OpenRouter, …) ◄─ AI Gateway
   OpenRouter GET /api/v1/generation (cost of streams that ended without one)
```

### Packages (pnpm workspace)

| Package                                       | Runtime deps                                                                      | Contents                                                                                                                                                                                                                                                                           |
| --------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` (`@tangent/shared`)         | zod                                                                               | Domain types, `ContextPlan`, provider interface, `SharePayload` DTO, and the HTTP/SSE API contract with zod request schemas                                                                                                                                                        |
| `packages/core` (`@tangent/core`)             | shared                                                                            | **Context assembly** (pure), prompt rendering, token estimation, sync SHA-256, tree utilities (outline, paths, keyboard navigation), share projection, repository ports, and the `ChatService`/`ShareService` application services                                                 |
| `packages/providers` (`@tangent/providers`)   | shared                                                                            | SSE parser, Anthropic provider, OpenAI-compatible provider, `FakeProvider`, config-driven registry                                                                                                                                                                                 |
| `packages/render` (`@tangent/render`)         | shared, core, markdown-it, highlight.js                                           | Safe markdown → HTML, the self-contained viewer page (used for both public shares and HTML export), and Markdown export                                                                                                                                                            |
| `packages/web-shared` (`@tangent/web-shared`) | shared, core, render, better-auth (+ passkey client); Angular as a peer  | Angular code both apps use: `ApiClient`, `AuthService` (paths from the `APP_PATHS` token), `BillingClient` (membership checkout and billing portal through `/api/billing`), SSE parsing and `runStream`, `MarkdownService`, `Icon`/`Modal`/`Turnstile`, `LoginPage`, `styles/base.css`                                      |
| `apps/worker` (`@tangent/worker`)             | all packages, hono, drizzle-orm, better-auth, `@polar-sh/sdk@1.0.2` (only in `src/billing/providers/polar/`) | Hono app, D1 repositories, the `TreeSession` Durable Object, Better Auth sign-in, email (Resend behind an interface), share routes, edge cache, rate limit, simple mode (`simple-mode.ts`), billing (`src/billing/`), the `/learn/` server (`http/learn-app.ts`), the cron handler |
| `apps/web` (`@tangent/web`)                   | shared, core, render, web-shared, Angular                                         | The power app, served at `/`                                                                                                                                                                                                                                                       |
| `apps/simple` (`@tangent/simple`)             | shared, core, render, web-shared, Angular                                         | The simple "Learn" app, built with `baseHref: '/learn/'` and served at `/learn/`                                                                                                                                                                                                   |
| `apps/canvas` (`@tangent/canvas`)             | shared, core, render, web-shared, Angular                                         | The experimental Canvas app (every branch a lane on one zoomable surface, parallel streams, variants, lineage), a view of the power account built with `baseHref: '/canvas/'` and served at `/canvas/`                                                                             |

Workspace packages export their TypeScript sources directly (`"exports": "./src/index.ts"`). There is no build step: Wrangler's esbuild, Vite/Vitest and the Angular builder all compile TS from the workspace. That includes the Angular library `@tangent/web-shared`, which each app's builder compiles AOT.

**Build and serve.** The root `pnpm build` runs `ng build` for `apps/web`, `apps/simple` and `apps/canvas`, then `scripts/assemble-assets.mjs` copies `apps/web/dist/web/browser/**` to `apps/worker/site/` and `apps/simple/dist/simple/browser/**` to `apps/worker/site/learn/`. `wrangler.jsonc` points `assets.directory` at `./site` (git-ignored except `.gitkeep`). The power app uses the assets' SPA fallback. The simple app can't, because the fallback always serves the root `index.html`, so `/learn` and `/learn/*` run the Worker first: `/learn` redirects to `/learn/`, a path whose last segment contains a `.` is passed to `ASSETS` as is, and every other path gets the simple app's `index.html`. The Worker sets the CSP on those responses itself (the login policy on `/learn/login`), because `_headers` doesn't apply to Worker-generated responses. `/` (exact path) and `/welcome` also run the Worker first, for the landing page (`http/landing.ts`); see "Landing page and demo" below.

### Request flows

**Send a message** (`POST /api/branches/:branchId/messages {content}`):

1. The Worker checks the session, validates the body and looks up the branch's tree. It forwards the request to `TREE_SESSION.idFromName(treeId)`.
2. The DO calls `ChatService.beginSend`. This atomically inserts the user node and a `streaming` assistant node in one D1 batch. A unique `(branch_id, seq)` index rejects a racing append with 409; the DO also serializes sends per tree. The DO then emits `start`.
3. The DO starts `ChatService.runGeneration` as a detached task. That task loads the ancestor slice with a recursive CTE and runs `assembleContext`. It then generates any missing summaries (emitting `status` events), stores them in D1 and re-plans. It renders the plan and streams the provider.
4. Every event is appended to an in-memory buffer and fanned out to all SSE subscribers. The POST response is the first subscriber.
5. On `done`/`error` the node is persisted once (content, status, usage), with a single D1 write. Auto-titling runs after the first assistant reply.
6. A browser that disconnects can reconnect with `GET /api/nodes/:id/stream`. The response starts with a `snapshot` (content so far) and then continues live. If the generation has finished, it returns `snapshot` + `done` straight from D1.
7. `POST /api/nodes/:id/cancel` aborts the provider fetch. The partial content is persisted with status `error` and the message "cancelled".

Why a DO rather than `waitUntil`: `waitUntil` only lasts 30 s after the client disconnects, but a long generation must survive a closed tab. A DO has no wall-clock limit while it has I/O in flight. It is also the natural per-tree serialization point. Nodes left `streaming` by a DO restart (eviction, redeploy) are marked `error: interrupted` lazily: on the first request a fresh DO instance serves (`recoverInterrupted`), and by the reconnect endpoint when it finds a `streaming` node with no running generation.

**Context plan** (`GET /api/branches/:id/context?nodeId=&resolve=`): this runs in the Worker without the DO. It uses `ChatService.planContext`, which returns the plan, the exact rendered prompt, the provider/model and, when supported, an exact token count.

**Public share** (`GET /s/:token`):

1. The rate limiter (keyed by `CF-Connecting-IP`) rejects excess requests with 429.
2. `ShareService.checkPublic` does one indexed D1 read. A revoked or expired share returns 410 and an unknown token returns 404. This check runs on every request, which is how revocation takes effect at once without relying on a global purge.
3. The edge cache is keyed by `https://share-cache.internal/<token>/v<version>/<variant>`. Snapshots are cached for 1 day. Republishing bumps `version`, which changes the key, and `cache.delete` best-effort purges the local colo on revoke/republish. Live shares are never cached.
4. On a cache miss the Worker loads the stored snapshot or projects the live payload. It renders the viewer page with Open Graph tags and a hash-based CSP.
5. `recordView` runs in `waitUntil`.

**Send on the built-in provider** (same route, a metered call: Learn on credit (the account's `payer`), or a power branch whose `funding` is `credit`; the provider id is the endpoint `openrouter` either way, see §13):

1. The Worker resolves the branch through the account (404 if foreign), checks the model against the built-in provider config (any well-formed id in power, where it is `openModels`), then `assertCanSpend(env, account, funding)`: for a metered call (`callPayer(account, funding)`: Learn by the request's payment, power by the branch's funding), billing must be configured and the user's `available = balance − pending holds` (on `account.billingAccountId`, `u_<userId>`) must cover one more `USAGE_HOLD_MICROS`, otherwise **402 `payment_required`**. It applies the per-user rate limit (`billing:<billingAccountId>`) and forwards the account to the DO in the `/send` body.
2. In the DO, `chatService(env, account, { defer: ctx.waitUntil })` wraps the registry on the operator's key (Learn's one registry on credit, or power's Tangent credit registry, `creditProviders`) in the usage meter; the user's own-key registry is never wrapped. Every `stream()` on it (the reply, summaries, the title) first inserts a `pending` `usage_events` row with the hold, the markup and the OpenRouter fee rate (`OPENROUTER_FEE_BPS`) in force (awaited), then taps `billing` events (generation id, `usage.cost`) and `usage` events.
3. At `done`/`error` the row is settled inline when the cost is known: `charge = ceil(costNanos × (10000 + fee_bps) × (10000 + markup_bps) / 10¹¹)` micro-USD, the row's stored rates: the reported cost grossed up by OpenRouter's credit-purchase fee (the true cost), then marked up. With only a generation id (abort, truncation), `GET https://openrouter.ai/api/v1/generation?id=` is polled in the background (1, 3, 10, 30 s). With neither, the call never reached OpenRouter and settles at 0.

**Usage cron** (`scheduled`, `*/10 * * * *`): pending rows older than 2 minutes with a generation id are settled from OpenRouter; rows without one after 10 minutes settle at 0; rows still pending after 24 hours become `unresolved` at 0 and are logged.

**Payments** go through one port (`src/billing/payments/port.ts`, docs/polar-migration/03-architecture.md); the active adapter is Polar (`PAYMENT_PROVIDER=polar`, `src/billing/providers/polar/`), the merchant of record.

**Top-up** (`POST /api/billing/checkout {amountCents, target?}`, $5–$500, same-origin only): `startTopUpCheckout` validates the amount, then asks the provider for a hosted checkout. Polar: `checkouts.create` on `POLAR_CREDITS_PRODUCT_ID` with an ad-hoc tax-exclusive USD price, `external_customer_id` = the user id, and metadata `{ kind: 'credits', target: 'personal', accountId, userId, v }`, returning to the calling app's billing page.

**Membership** (`ANNUAL_FEE_ENABLED` `"true"`, default off, and the provider sells it, `POLAR_MEMBERSHIP_PRODUCT_ID`): `POST /api/billing/membership/checkout` opens the yearly product's checkout (a paying member gets the portal); `POST /api/billing/portal` opens the provider's billing portal (404 `no_customer` while there is none). `membershipFor` reads `billing_subscriptions`.

**Payment webhook** (`POST /api/webhooks/:provider`, before the session middleware): the adapter verifies the signature (Polar: Standard Webhooks via the SDK's `validateEvent`) and maps the delivery to normalised events, which `billing/payments/apply.ts` applies:

- `payment.succeeded` (Polar `order.paid`), credits → `fulfilPurchase`: `net_amount − fee`, personal only, idempotent on `polar:order:<id>`; membership (`subscription_create` / `subscription_cycle`) → nothing on the ledger (its included credit and the pool's revenue share were removed 2026-10).
- `refund.succeeded` (Polar `refund.created/updated` once `succeeded`) → personal: the refunded pre-tax amount in full; a legacy pool purchase: the share of what the purchase credited, clamped by `PoolBank.debit`; membership: its included credit (if any) once, and the refunded proportion of the pool share.
- `membership.changed` (Polar `subscription.*`) → the `billing_subscriptions` snapshot, newest `version` wins.
- Disputes (Polar has no dispute webhooks) are polled by the 10-minute cron (`CronJobs.paymentDisputes`) and applied the same way.

A bad signature answers 403, nothing to apply 202, and any failure 500 so the provider redelivers (logged `payment_webhook_failed`; Polar disables an endpoint after 10 consecutive failures).

---

## 2. Data model (D1)

Schema: `apps/worker/src/db/schema.ts`. Migrations (`apps/worker/migrations/`, generated by drizzle-kit and applied with `wrangler d1 migrations apply`) start from one baseline, `0000_baseline`, which creates the whole schema; a database made before it is converted with `apps/worker/scripts/d1-baseline/convert.sql` (docs/runbooks/d1-baseline.md).

| Table                      | Key columns                                                                                                                                                                                                                                                                                                                                                                                    | Notes                                                                                                                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account_settings`         | `account_id` PK, `system_prompt` (nullable), `updated_at`                                                                                                                                                                                                                                                                                                                                      | Per-account settings, written on the first save (`PATCH /api/settings`); no row = the defaults. `system_prompt` null = the built-in default prompt. No FK, like the other `account_id` columns                                                                                  |
| `trees`                    | `id` PK, `account_id`, `title`, `system_prompt`, `trunk_branch_id`                                                                                                                                                                                                                                                                                                                             | The trunk is created with the tree, in the same batch. Branches, nodes and summaries inherit ownership through `tree_id`                                                                                                                                                        |
| `branches`                 | `id` PK, `tree_id` FK cascade, `parent_branch_id`, `branch_point_node_id`, `context_mode`, `anchor_quote`, `title`, `title_source`, `is_private`, `provider_id`, `model`, `funding`                                                                                                                                                                                                                     | A branch is a linear chain of nodes. The trunk has null parent and null branch point                                                                                                                                                                                            |
| `nodes`                    | `id` PK, `tree_id`, `branch_id` FK cascade, `parent_id`, `seq`, `role`, `content`, `status`, `error`, `provider_id`, `model`, `input_tokens`, `output_tokens`                                                                                                                                                                                                                                  | `UNIQUE(branch_id, seq)` serializes appends. Indexes on `parent_id` and on `tree_id` (partial index for `status='streaming'`)                                                                                                                                                   |
| `node_links`               | `id` PK, `tree_id` FK cascade, `source_node_id` and `target_node_id` (FK → `nodes` cascade), `pair_key` UNIQUE, `note` (nullable), `origin` (`user`\|`ai`, default `user`), `created_at`, `updated_at` | Cross-links between two messages of the same tree (§17). `pair_key` is `min\|max` of the two node ids, so a pair is linked once whichever way round; `CHECK(source_node_id <> target_node_id)`. Indexes on `tree_id` and both node columns, so the cascades from `nodes` don't scan |
| `summaries`                | PK `(anchor_node_id, source_hash, model)`, `provider_id`, `tree_id`, `content`                                                                                                                                                                                                                                                                                                                 | Lazy cache. A changed path gives a new hash, so it is a cache miss                                                                                                                                                                                                              |
| `shares`                   | `id` PK, `token` UNIQUE, `account_id`, `tree_id`, `scope`, `target_node_id`, `include_ancestors`, `mode`, `title`, `expires_at`, `revoked_at`, `published_at`, `version`, `view_count`                                                                                                                                                                                                         |                                                                                                                                                                                                                                                                                 |
| `share_snapshots`          | PK `(share_id, chunk)`, `data`                                                                                                                                                                                                                                                                                                                                                                 | The snapshot JSON is chunked at 256K chars to stay under D1's 2 MB row limit, and replaced atomically in a batch                                                                                                                                                                |
| `auth_users` (Better Auth) | … plus `membership_waived` (integer boolean, default 0), `membership_waived_at` (ISO text, nullable) and the pool columns |
| `billing_subscriptions`    | `ref` PK (`polar:subscription:<id>`), `provider`, `user_id`, `kind` (`membership`), `status` (normalised), `provider_status`, `current_period_end`, `cancel_at_period_end`, `ended_at`, `version`, `updated_at`; `billing_customers` (`provider`, `user_id`) PK, `customer_ref` |
| `credit_grants`            | `id` PK, `account_id`, `kind` (`purchase`\|`subscription`\|`refund`\|`adjustment`\|`contribution`), `amount_micros` (signed, net of fees or of the pool margin), `gross_micros`, `fee_micros`, `margin_bps`, `user_id`, `provider_ref` UNIQUE, `note`, `created_at` | Every credit or debit except usage. Idempotent on `provider_ref` (`<provider>:<object>:<id>`, `admin:`/`dev:` keys; null for SQL adjustments). `account_id` is the user's ledger id `u_<userId>` (`default_simple` in the dev bypass), the same for both modes (credit is per user), or the community pool's id. Indexes on `account_id`, `(user_id, kind)` and `(account_id, created_at)` |
| `usage_events`             | `id` PK, `account_id`, `tree_id`, `node_id`, `branch_id`, `user_id`, `funding` (`personal`\|`pool`), `ip_key`, `tier`, `purpose`, `provider_id`, `model`, `generation_id` UNIQUE, `status` (`pending`\|`settled`\|`unresolved`), `hold_micros`, `markup_bps`, `fee_bps`, `cost_nanos`, `charge_micros`, `overage_micros`, `settle_reason`, `input_tokens`, `output_tokens`, `created_at`, `dispatched_at`, `settled_at` | One row per metered provider call (the built-in provider, from either mode), on the user's ledger id `u_<userId>` like `credit_grants`, or on the pool's id for pool calls. Indexes on `(account_id, created_at)`, `(account_id, status, created_at)`, the pool's per-user, per-network and per-tier `(account_id, …, created_at)`, and a partial index on pending rows. No FK to trees: billing history outlives deleted trees |

**Branch and node invariants**

- The first node of branch B has `parentId = B.branchPointNodeId` (`null` for the trunk). Node `seq=k>0` has the node at `seq=k-1` as its parent.
- A normal reply appends to the branch leaf. "Branch from here" on any node creates a new branch, even from the leaf, for example to switch mode or model.
- `branchPointNodeId` always belongs to `parentBranchId`.

**Balance.** It is computed, never cached: `Σ credit_grants.amount_micros − Σ charge_micros of settled usage_events`, and the held amount is `Σ hold_micros of pending usage_events` (`billing/ledger.ts`, one query). Money is integer micro-USD (provider cost in nano-USD); every write is a single idempotent statement, and a usage row settles at most once (`UPDATE … WHERE status = 'pending'`).

**Ancestor lookup.** A recursive CTE walks `parent_id` from the target. Each level is a primary-key lookup, so the cost is O(depth). A second CTE walks `parent_branch_id` for the branch chain. Neither needs extra write-time bookkeeping, and both were verified on D1/miniflare (`apps/worker/test/smoke.test.ts`). A materialized path or a closure table would speed up subtree queries. We don't need that: subtrees are only computed when sharing or exporting, and those load the whole tree with `WHERE tree_id = ?`.

---

## 3. Interfaces

The code is the source of truth. The signatures are abbreviated here.

### Domain (`packages/shared/src/domain.ts`)

```ts
type Role = 'user' | 'assistant' | 'system';
type NodeStatus = 'streaming' | 'complete' | 'error';
type ContextMode = 'path' | 'summary' | 'message' | 'independent';
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}
interface Tree {
  id;
  title;
  systemPrompt: string | null;
  trunkBranchId;
  createdAt;
  updatedAt;
}
interface Branch {
  id;
  treeId;
  parentBranchId: string | null;
  branchPointNodeId: string | null;
  contextMode: ContextMode;
  anchorQuote: string | null;
  title;
  titleSource: 'default' | 'auto' | 'user';
  isPrivate: boolean;
  providerId;
  model;
  createdAt;
  updatedAt;
}
interface ChatNode {
  id;
  treeId;
  branchId;
  parentId: string | null;
  seq: number;
  role: Role;
  content;
  status: NodeStatus;
  error: string | null;
  providerId: string | null;
  model: string | null;
  usage: TokenUsage | null;
  createdAt;
}
interface SummaryRecord {
  anchorNodeId;
  sourceHash;
  providerId;
  model;
  content;
  treeId;
  createdAt;
}
interface Share {
  id;
  token;
  treeId;
  scope: 'tree' | 'subtree' | 'path';
  targetNodeId: string | null;
  includeAncestors: boolean;
  mode: 'snapshot' | 'live';
  title: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt;
  updatedAt;
  publishedAt: string | null;
  version: number;
  viewCount: number;
}
```

### Context plan (`packages/shared/src/context-plan.ts`)

```ts
interface ChatMessage { role: 'user' | 'assistant'; content: string }
type InclusionReason = 'tree-system-prompt' | 'system-node' | 'path-ancestor' | 'branch-point-message'
  | 'branch-message' | 'branch-summary' | 'budget-compaction' | 'anchor-quote';
// Every segment has: id, kind, reason, explanation, sourceNodeIds[], viaBranchId, tokens
type ContextSegment =
  | SystemSegment          { kind: 'system'; text }
  | AncestorMessageSegment { kind: 'ancestor'; role; nodeId; text }
  | BranchMessageSegment   { kind: 'branch'; role; nodeId; text }
  | SummarySegment         { kind: 'summary'; purpose: 'branch'|'compaction'; key: SummaryKey;
                             status: 'ready'|'pending'|'failed'; text: string | null }
  | AnchorSegment          { kind: 'anchor'; text };
interface SummaryKey { anchorNodeId: string; sourceHash: string }
interface SummaryRequest { key; purpose; sourceNodeIds; transcript: ChatMessage[]; focus: string | null }
interface ContextPlan { treeId; targetBranchId; targetNodeId: string | null; mode: ContextMode;
  chain: ChainLink[]; segments: ContextSegment[]; budget: { maxInputTokens; usedTokens };
  compaction: CompactionRecord | null; truncation: TruncationRecord | null;
  pendingSummaries: SummaryRequest[]; complete: boolean }
interface RenderedPrompt { system: string | null; messages: ChatMessage[] }
```

### Provider (`packages/shared/src/provider.ts`)

```ts
type ProviderKind = 'anthropic' | 'openai-compatible' | 'fake';
interface ProviderCapabilities {
  maxContextTokens;
  maxOutputTokens;
  supportsSystemPrompt: boolean;
  supportsTokenCount: boolean;
}
type UsagePurpose = 'reply' | 'summary' | 'title' | 'review' | 'other';
interface UsageTag {
  purpose: UsagePurpose;
  treeId: string;
  nodeId: string | null;
} // attribution for billing
interface GenerateRequest {
  model: string;
  system: string | null;
  messages: ChatMessage[];
  maxOutputTokens?: number;
  signal: AbortSignal;
  usageTag?: UsageTag;
}
type ProviderEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; usage: Partial<TokenUsage> }
  | { type: 'billing'; generationId?: string; costUsd?: number } // OpenRouter id / reported cost; may repeat
  | { type: 'done'; stopReason: string | null }
  | {
      type: 'error';
      error: { code: ProviderErrorCode; message: string; status?: number; retryable: boolean };
    };
interface LlmProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly label: string;
  models(): ModelInfo[];
  defaultModel(): string;
  capabilities(model: string): ProviderCapabilities;
  stream(request: GenerateRequest): AsyncIterable<ProviderEvent>; // never throws; ends with done|error
  countTokens?(
    request: Omit<GenerateRequest, 'signal'> & { signal?: AbortSignal },
  ): Promise<number>;
}
interface ProviderConfig {
  id;
  kind;
  label;
  baseUrl?;
  apiKeySecret?;
  headers?;
  extraHeaderSecrets?;
  models: ModelInfo[];
  defaultModel;
  openModels?; // models are suggestions; any id matching OPEN_MODEL_ID_PATTERN is allowed (isModelAllowed)
  maxContextTokens?;
  maxOutputTokens?;
  supportsSystemPrompt?;
  options?;
}
interface ProviderRegistry {
  get(id): LlmProvider | undefined;
  list(): ProviderInfo[];
  defaultProviderId(): string;
}
// packages/providers/src/registry.ts
const PROVIDER_FACTORIES: Record<
  ProviderKind,
  (config: ProviderConfig, env: ProviderEnv) => LlmProvider
>;
function createProviderRegistry(
  configs: readonly ProviderConfig[],
  env: ProviderEnv,
): ProviderRegistry;
```

The OpenAI-compatible provider yields `billing` with the `X-Generation-Id` header (or the first `gen-…` chunk id) and with `usage.cost` from the final chunk, and accepts `options.extraBody` (merged into the request body; it can't override `model`, `messages`, `stream` or the max-tokens parameter). The Fake provider reports a fixed `options.costUsd`. `ChatService` ignores `billing` events; the Worker's usage meter consumes them. `fetchOpenRouterGeneration(id, key)` looks up the cost of a finished generation.

Adding a provider **kind** means one module plus one `PROVIDER_FACTORIES` entry. Adding a provider **instance** (OpenRouter, a local server, an AI Gateway route) is config only: the `PROVIDERS` JSON var plus a secret.

### Repositories (`packages/core/src/repository.ts`)

`TreeRepository` has these methods:

- Trees: `listTrees`, `getTree`, `createTree`, `updateTree`, `deleteTree`
- Branches: `getBranch`, `listBranches`, `getBranchChain`, `createBranch`, `updateBranch`
- Nodes: `getNode`, `listNodes`, `listBranchNodes`, `getAncestorPath`, `appendNodes`, `updateNode`, `listStreamingNodes`
- Links: `listLinks`, `getLink`, `createLink(link, treeUpdatedAt)` (an already linked pair, either way round, returns the existing link with `created: false`), `updateLink(id, { note, updatedAt })`, `deleteLink`. `deleteBranches` and `deleteTree` drop the links touching their nodes
- Backup: `importTree(tree, branches, nodes, links?)`

`SummaryRepository` has `getSummary(anchorNodeId, sourceHash, model)` and `putSummary(record)`.

`ShareRepository` has `listShares`, `getShare`, `getShareByToken`, `createShare(share, snapshotJson)`, `updateShare(id, patch, snapshotJson?)`, `getSnapshot`, `incrementViewCount`.

`SettingsRepository` has `getSettings(accountId)` (null until the first save) and `putSettings(accountId, { systemPrompt }, updatedAt)` (an upsert).

### Services (`packages/core/src/services`)

```ts
class ChatService { constructor(deps: { repos: Repositories; accountId?; providers: ProviderRegistry; settings: ChatSettings; defaultSystemPrompt?; clock?; newId? })
  getOwnedBranch(id); getOwnedNode(id);                               // 404 for another account's ids
  listTrees(); createTree(req); getTreeDetail(id); updateTree(id, req); deleteTree(id);
  getSettings(); updateSettings(req);     // createTree without a prompt: saved one, else defaultSystemPrompt
  createBranch(req); updateBranch(id, req);
  createLink(req): Promise<{ link; created }>; updateLink(id, req); deleteLink(id);   // §17
  planContext(branchId, nodeId | null, { resolveSummaries, signal? }): Promise<ContextPlanResponse>;
  beginSend(branchId, content): Promise<{ branch; userNode; assistantNode }>;
  runGeneration(begin, signal): AsyncIterable<StreamEvent>;       // never throws; persists final state
  recoverInterrupted(treeId); exportBackup(treeId); importBackup(backup) }
// packages/core/memory: createMemoryRepositories() — in-memory reference implementation of the ports
class ShareService { constructor(deps: { repos; publicBaseUrl; clock?; newId?; newToken? })
  list(); create(req); update(id, req); republish(id); revoke(id);
  checkPublic(token); resolvePublic(token); recordView(shareId) }
```

### HTTP API and SSE (`packages/shared/src/api.ts`)

The full route table is `API_ROUTES` in `packages/shared/src/api-routes.ts`. `GET /api/settings` and `PATCH /api/settings` (`{ systemPrompt: string | null }`) read and write the account's settings; both answer `SettingsResponse { systemPrompt: string | null; defaultSystemPrompt: string }`, where `defaultSystemPrompt` is the built-in prompt the server would use (with Learn's `LEARN_SYSTEM_PROMPT` applied). `POST /api/trees` without a non-blank `systemPrompt` gives the tree the account's saved prompt, else that built-in one. Every owner request names its app with `x-tangent-mode` (`simple`; absent = power), and Learn requests their payment with `x-tangent-payment` (`own-key` | `credit`). Billing adds `GET /api/billing` (`BillingSummary`, with `builtInCredit`), `GET /api/billing/usage?cursor=&limit=` (`UsageListResponse`, newest first) and `POST /api/billing/checkout` (`{ amountCents }` → `{ url }`) and `POST /api/billing/membership/waiver` (`{ code }` → `MembershipInfo`), in both modes on the user's ledger, plus `POST /api/billing/membership/checkout`, `POST /api/billing/portal` and the public `POST /api/webhooks/:provider`. `MeResponse` carries `mode`, `operatorKeys` (the dev bypass), `builtInCredit` (the built-in provider is sold as credit) and `membership` (`MembershipInfo`), and the error codes `payment_required` and `membership_required` map to HTTP 402. The billing types are in `packages/shared/src/billing.ts`. SSE frames are `event: <type>\ndata: <json>\n\n`, where `StreamEvent` is one of `start | snapshot | status | delta | usage | done | error`. The order is `start` → `status*` → (`delta`|`usage`)* → exactly one of `done` or `error`. Clients parse SSE from `fetch()` (POST bodies rule out `EventSource`).

### Share DTO (`packages/shared/src/share.ts`)

`SharePayload { v: 1; title; description; scope; generatedAt; context: ShareMessage[] | null; rootBranchKey; branches: ShareBranch[] }`. Here `ShareBranch` is `{ key, parentKey, forkMessageKey, title, anchorQuote, messages }` and `ShareMessage` is `{ key, role, content }`. Keys are `b<n>`/`m<n>`, assigned per payload. The payload carries no ids, usage, models or modes.

---

## 4. Context assembly (`packages/core/src/context/assemble.ts`)

`assembleContext(input: AssembleInput): ContextPlan` is **pure**: no I/O, no clock, no randomness. It is synchronous; SHA-256 is implemented in TypeScript. Its input is:

- the tree's system prompt;
- the branches (at least the trunk→target chain);
- the nodes (at least the root→target ancestor path);
- the target branch and node (`null` means the branch leaf, or nothing yet for an empty branch);
- the summaries available (`Map<"anchor:hash", text>`) and a set of failed keys;
- the budget and a token estimator.

### 4.1 Effective context: recursive definition

Let `chain = [B0 = trunk, B1, …, Bk = target branch]`. Let `own(Bi)` be the nodes of `Bi` on the ancestor path (for `i<k` that is up to and including `B(i+1)`'s branch point). Then:

```
ctx(0)  = own(B0)
ctx(i)  = prefix(i) ++ anchor(Bi) ++ own(Bi)          for i ≥ 1
prefix(i) = match Bi.contextMode
  'path'        → ctx(i-1)                              // transparent: inherit what the parent saw
  'summary'     → [ summary( flatten(ctx(i-1)), focus = Bi.anchorQuote ) ]
  'message'     → [ last(own(B(i-1))) ]                 // the branch-point node only
  'independent' → []                                    // hard boundary
anchor(Bi) = Bi.anchorQuote ? [AnchorSegment] : []      // in every mode
plan.segments = [treeSystemPrompt?] ++ ctx(k)           // then the budget pass
```

Resulting semantics:

- **The trunk stays trim.** `ctx(i)` only ever looks up the chain, never at siblings or descendants.
- **`path` is compositional.** A `path` branch continues exactly what its parent branch would have sent at the branch point. It does not re-expand content that an ancestor `summary` or `independent` branch deliberately dropped. For example, a `path` branch under a `summary` branch under the trunk sends [summary of trunk up to P1] + [anchor1] + [summary-branch messages up to P2] + [anchor2] + [own messages].
- **`summary` summarizes the parent's effective context**, which may itself contain a summary. Nested summaries therefore compose, and the inner one is simply part of the transcript being summarized.
- **`message`** sends only the branch-point node as the parent saw it (an `ancestor` segment, reason `branch-point-message`), then the anchor quote and its own messages. Nothing else from the chain survives, so a summary-mode ancestor needs no summary call. A skipped branch point (in-flight or failed reply) sends nothing.
- **`independent`** sends only the anchor quote (the topic) and its own messages. The tree's system prompt is still included, because it is tree-wide configuration, not conversation content.
- **System-role nodes** on the path become `system` segments (reason `system-node`) where they are inherited. They are never summarized.
- Nodes with status `streaming`/`error` and empty content are skipped. This covers an in-flight or failed reply.

### 4.2 Segment typing and provenance

- Nodes of the target branch become `branch` segments (reason `branch-message`). Inherited nodes become `ancestor` segments (reason `path-ancestor`, or `branch-point-message` for the node a `message` branch forks from; `viaBranchId` = the owning branch).
- A branch summary is a `summary` segment with purpose `branch`, `viaBranchId` = the summary-mode branch, and `sourceNodeIds` = every node the summarized transcript came from.
- A compaction summary is a `summary` segment with purpose `compaction`.
- Each segment has an `explanation` string for the inspector, e.g. "Inherited from ‘Trunk’ via path mode".

### 4.3 Summary keys and lazy caching

- `flatten(segments)` → `ChatMessage[]`: message segments map to themselves; an inner summary becomes a `user` message "[Summary of earlier conversation] …"; an anchor becomes a `user` message "[Focus excerpt] …". System segments are excluded.
- `sourceHash = sha256Hex(JSON.stringify({ transcript, focus }))`.
- The key is `{ anchorNodeId: branchPointNodeId, sourceHash }` for branch summaries and `{ anchorNodeId: lastCompactedNodeId, sourceHash }` for compaction. The D1 cache key adds the summary model.
- If a key is missing from `summaries`, the segment is `pending` and a `SummaryRequest` is emitted. An inner summary that is still pending makes the outer transcript unknown. In that case the outer summary is `pending` **without** a request, and the caller's re-plan loop resolves them inner-first.
- Any edit to the path (a new branch message upstream, a changed anchor quote or a changed mode) changes the hash. The next plan then misses the cache and regenerates. That is "invalidation" with no bookkeeping. Old rows are harmless and are deleted with the tree.
- If a key is in `failedSummaries`, the segment becomes `failed`. It is omitted from the rendered prompt and `complete=false`. The service still sends and warns via a `status` event.

`ChatService.resolvePlan` loop: plan → for each request, generate with `buildSummaryPrompt` using the configured summary provider/model and store it → re-plan. It stops when the plan is complete, when no progress is made, or after 4 rounds.

### 4.4 Token budget and compaction

`maxInputTokens = min(providerContext − reservedOutput, settings.maxInputTokens ?? ∞)`. Tokens are estimated as `ceil(chars/3.5)` plus 4 per message. That is deliberately conservative; exact usage is recorded from provider `usage` events afterwards.

When the total exceeds the budget:

1. **Candidates.** The candidates are the non-system body segments in order, excluding the last `minTailMessages` (default 2) message segments. The target message is never a candidate.
2. **Compaction.** Find the shortest _oldest-first prefix_ P of the candidates such that `tokens(P) ≥ ⌈(total − budget) / step⌉ · step + compactionSummaryTokens (default 1024)`, where `step = ⌊budget · (1 − compactionTarget)⌋` (`compactionTarget` default 0.5): the overflow rounded up to whole steps, so a compaction brings the context down to about half the budget and P stays the same (same key, same cached summary, same prompt prefix) until the context outgrows the budget by another step. If no prefix reaches that but all the candidates together make the context fit (`total − tokens + compactionSummaryTokens ≤ budget`), P is all of them; a later turn, with more candidates, moves to the step boundary once. `compactionTarget: 1` gives the shortest prefix that fits, which compacts one more segment (a new summary) on every turn over the budget. Replace P with one compaction summary segment. Its key is `{ anchorNodeId: last node in P, sourceHash: hash(flatten(P)) }` and it has `reason: budget-compaction`. Record `CompactionRecord { compactedNodeIds, tokensBefore, tokensAfter, key }`. P may include inherited summaries and anchors; they are re-summarized.
3. **Truncation.** Truncation applies if no prefix fits (the tail alone is too large), or if the resolved compaction summary is larger than estimated and still overflows. In that case, drop the oldest non-system segments (never the target) until the total fits, or until only system segments plus the target remain. Record `TruncationRecord`. This is the last resort, and the inspector shows it.

Compaction only exists because the plan is over budget. It therefore applies to any mode, not only `path`; in practice it triggers for long `path` chains. Compaction summaries are cached exactly like branch summaries.

### 4.5 Rendering (`renderPlan(plan, { supportsSystemPrompt })`)

- `system` = tree system prompt + system nodes + ready summaries ("## Summary of the earlier conversation") + anchors ("## The user branched off to focus on this excerpt"), in segment order. This keeps summaries out of the message list, so role alternation is never broken.
- `messages` = the ancestor and branch segments in order. Consecutive same-role messages are merged. If the list starts with an assistant message, a synthetic `user` "(Conversation continues.)" is prepended.
- A provider without system-prompt support gets the system text prepended to the first user message.

### 4.6 Test matrix (`packages/core/test/context/*.test.ts`)

The tests cover:

- the trunk only;
- each mode as a direct child of the trunk;
- every two-level nesting (3×3), plus selected three-level chains;
- an empty branch, and a mid-branch target node;
- sibling isolation (siblings and their descendants never appear), and the trunk not seeing children;
- the anchor quote in each mode, and the anchor as summary focus;
- a pending summary producing a request, and a ready summary being used;
- nested pending (inner-first);
- hash stability and sensitivity (edit upstream → new hash; edit in own branch → same branch-summary hash);
- a failed summary;
- budget: fits, compaction with the tail kept, compaction by whole steps and its stability over several turns, compaction including inherited summaries, the truncation fallback, and compaction with a ready summary;
- system nodes;
- streaming/error nodes skipped;
- validation errors;
- the render rules (merge, leading assistant, system folding).

---

## 5. Sharing and publishing

- **Projection** (`projectShare`) is a pure allow-list builder shared by live shares, snapshots and exports.
  - Private branches, and every branch below them, are removed before anything is serialized.
  - Creating a share whose target is effectively private is rejected with 400.
  - A live share whose target later becomes private returns 410.
- **Snapshot**: the payload is projected at creation and stored as chunked JSON. **Republish** re-projects it in place: same token, and `version++` busts the edge cache. **Live**: projected on each view, never cached.
- **Links**: `/s/<token>`, where the token is 192 random bits in base64url. Shares support an optional title, an optional expiry and instant revocation (checked on every request). The Shares page lists scope, mode, created/updated/published times, state and view count.
- **Viewer**: a server-rendered, self-contained page from `@tangent/render`. It uses a hash-based strict CSP, an inline constant script/style, and messages pre-rendered with the shared markdown renderer. Its outline, breadcrumbs and linear view work offline. The **same function** produces the HTML export, so the two cannot diverge. `/s/<token>/data.json` returns the DTO.
- **Why not reuse Angular for viewers?** Viewers would run owner code, and the page would have to work without a session. A self-contained page has its own strict CSP, loads fast on phones, and doubles as the offline export.
- **Exports**: `/api/export?format=md|html&scope=…` builds the payload with `projectShare`. Owners may pass `includePrivate=true`. It then calls `payloadToMarkdown` or `renderViewerPage({ variant: 'export' })`. The JSON backup/restore (`/api/trees/:id/backup`, `/api/import`) is owner-only and includes everything.
- **Later (designed for, not built)**:
  - _Fork this share into my tree_: `POST /api/import-share {token}` would map a `SharePayload` back to branches and nodes. Keys make this lossless for content, and modes default to `path`.
  - _Share passwords_: a `password_hash` column on `shares` and a `/s/<token>/unlock` form that sets a signed, token-scoped cookie. `checkPublic` already centralizes access decisions.

---

## 6. Access control

- Sign-in is [Better Auth](https://better-auth.com), mounted at `/api/auth/*`, with its tables in D1 (`auth_*`, migration 0002). Methods: Google, GitHub, magic link (email, via the `EmailSender` interface; Resend today) and passkeys. There are no passwords.
- Anyone with a verified email may sign up; unverified users are never created (a `user.create.before` hook), and the session middleware re-checks verification on every `/api/*` request. Turnstile and rate limits guard the magic-link form.
- The account middleware (`auth/account.ts`) resolves the caller and the app (`x-tangent-mode`) to the user's account for that mode (`p_<userId>` or `u_<userId>`) and creates its row on first use. Every branch or node id is resolved through `ChatService.getOwnedBranch`/`getOwnedNode` before the Worker acts on it or calls the Durable Object, so another account's ids are 404. The DO trusts the account the Worker passes on its internal routes.
- The operator's keys are spent only through the built-in provider (`callPayer`: Learn on credit or the pool, and power's credit routes where credit is offered), metered per call, or, for the power configs' secrets, by the local dev bypass (`operatorKeys`). Otherwise `registryFor` withholds them and the user's own key is needed (401 `key_required`).
- Calls on the built-in provider are rate limited per user across both apps and can't start without enough credit (402). Learn on credit ignores the key cookie; power always reads it for its other providers. Learn on the user's own key uses the cookie's `openrouter` entry and never touches the ledger. `/api/billing/*` answers in both modes, on the user's ledger.
- Every `/api/*` route except `/api/auth/*` and `/api/login-options` requires a session (`auth/session.ts`). The lookup never refreshes the session; the web app's startup call to `GET /api/auth/get-session` does, because only that path re-issues the cookie.
- If `BETTER_AUTH_SECRET` is unset, the Worker refuses all `/api/*` requests with 500 "not configured". The exception is `DEV_ALLOW_NO_AUTH=true` (in `.dev.vars` only), which lets local dev run without auth. The Worker fails closed.
- The magic-link endpoint is protected by Cloudflare Turnstile (Better Auth's captcha plugin) and rate limited (5/min per IP, in D1). Turnstile's script runs only in the `/login` document, which gets its own CSP (`public/_headers`); the app moves to and from it by full page loads.
- "Remember me" covers every method: sessions start remembered (30 days, rolling) and an after-hook shortens them to a browser-session cookie and a 1-day session when the login page asked for that.
- `/s/*` never looks at the session. It gets no identity and serves only allow-listed DTOs.
- The payment webhook is public but signature-verified by the provider's adapter (`POLAR_WEBHOOK_SECRET`).
- Static assets contain no data; the API is what is gated. `workers_dev` is false so sign-in only happens on `PUBLIC_BASE_URL`.
- Shares stay on the same hostname as the app. The viewer is self-contained, under a strict CSP, and runs no owner code; session cookies are HttpOnly. See DECISIONS.

## 7. Front end (Angular 22)

All three apps use standalone components, signals, zoneless change detection (the default in v21+) and the `@angular/build:application` builder. Code they share lives in `packages/web-shared` (§1). The power app's output is served at `/` with an SPA fallback; the simple app's under `/learn/` by the Worker (§1, _Build and serve_). Each shows a Power | Learn switch (`ModeSwitch`) that links to the other; the simple app sends `x-tangent-mode: simple` and its payment choice on every API call (`API_HEADERS`).

The rest of this section describes the power app (`apps/web`).

- **Layout**: a left sidebar holds the tree list and the outline of the selected tree (collapsible, and a drawer on phones). The main pane is the chat. The Context Inspector is a toggleable right panel.
- **Chat view**: breadcrumbs (trunk › … › branch), the messages of the branch path rendered with `renderMarkdown` and highlight.js, and a composer. Each message has:
  - a **Branch from here** action, which opens a dialog with the mode picker, the selected text as the anchor quote, an optional title, and the provider/model inherited from the parent;
  - an "**N branches**" indicator that expands to a list of child branches;
  - under a finished assistant reply, the **tangents** it ends with (its `<tangents>` block, kept out of the rendered text, even while streaming): one click makes a `path` branch titled after the tangent and sends the title as its first message, as in Learn;
  - a return-to-parent link on the first message of a branch.
- **State**: a `TreeStore` built on signals holds the tree detail, the `TreeIndex`/outline (`@tangent/core`), the selected branch/node, and live streams. An `ApiClient` wraps `fetch`, and an SSE reader built on `ReadableStream` handles reconnects.
- **Keyboard**: `Alt+↑` or `[` moves to the parent branch (focusing the branch point), `Alt+←/→` moves to the previous/next sibling, `Alt+↓` or `]` moves to the first child, `j/k` moves between messages, `b` branches from the focused message, `/` focuses the composer and `i` toggles the inspector. The logic lives in `navigate()` in `@tangent/core`, where it is unit-tested.
- **Branch settings**: title (auto or edited), mode, anchor quote, private toggle, provider/model.
- **Shares page**: create (scope, mode, include ancestors, title, expiry), copy link, republish, revoke. **Export menu**: Markdown, HTML and JSON backup; Import restores a backup. Shares and exports show a reply's tangents as a plain "Where next?" list.
- **Settings**: the account's **default system prompt** (server-side, `/api/settings`; "Use default" copies the built-in prompt into the editor, an empty editor means the built-in one) and the default reviewer (this browser). A conversation's own system prompt (Conversation settings) overrides the default.
- **Read-only without a membership**: where one is required and the user has none, a branch whose funding needs it (`MeResponse.membershipNeededFor`, the server's `needsMembership`: the user's own keys) shows a notice instead of the composer (`ReadOnlyComposer` in `@tangent/web-shared`): **Renew membership** (`/billing`), **Create a copy in Learn** (`POST /api/trees/:treeId/copy-to-learn`, then `/learn/t/<id>`) and, while credit can pay, **Continue with Tangent credit**. Branching, reviews, tangents and summary resolves are held back where they would be refused; reading, export and management stay. Canvas does the same per lane. See docs/DECISIONS.md "Read-only power without a membership".

**The simple app** (`apps/simple`, `baseHref: '/learn/'`) has its own lean `LessonStore` on `runStream` and the `@tangent/core` tree utilities. Routes:

- `/learn/`: the lesson list (each lesson with Export, the JSON backup power uses, and Delete), "New lesson" and Import (a backup from either app, adapted to Learn on the server: `adaptBackupForLearn`);
- `/learn/t/:treeId[/b/:branchId]`: the chat with streaming, a Smart/Simple toggle, "Ask about this" (a `path` branch from selected text), the tangents each reply ends with (buttons parsed from the reply's `<tangents>` block; one tap makes a `path` branch titled after the tangent and sends the title as its first message) and a simple branch list;
- `/learn/billing`: the shared billing page (`BillingPage` in `@tangent/web-shared`, also power's `/billing`): the membership (status, Subscribe, "Have a code?", "Manage billing" in the Customer Portal) and, where credit is sold, balance, top-ups and recent usage; while the membership blocks generating, the shared `MembershipGate` panel covers the rest of the app;
- `/learn/login`: the shared `LoginPage`.

There is no inspector, reviewer, shares, Markdown or HTML export, BYOK, context-mode or model picker, or system prompt editor (the API's `/api/settings` works for Learn accounts too, but the app has no UI for it). A 402 sends the user to the billing page.

**The canvas app** (`apps/canvas`, `baseHref: '/canvas/'`, experimental) is a third view over the **power** account: it sends no mode header, so it reads and writes the same trees as `apps/web` on the same key cookie. Routes: `/canvas/` (the list and "New conversation"), `/canvas/t/:treeId[/b/:branchId]` (the canvas; the URL names the selected lane), `/canvas/login`, and `/canvas/demo/…` over the power demo's in-browser backend (`demoProviders('canvas')`). Its pieces:

- **Layout** (`layout/layout.ts`, pure, unit-tested): every branch is a lane of fixed width; a child lane goes one column right of its parent, level with the card it forks from, pushed down (never up) until none of the columns its subtree spans overlap what is already placed (a contour sweep in outline order). Heights come from the DOM: each `Lane` reports its box and card offsets to the `LayoutStore` through a `ResizeObserver`, and the layout is a `computed` over those measurements, so streaming text reflows the map live. Connectors are S-curves styled by context mode; a folded lane is a capsule and its subtree is left out.
- **Viewport**: pan by drag or wheel, zoom with Ctrl/⌘+wheel or pinch, fit, and "centre on lane" (the selection and the `?m=` focus animate the world transform); a minimap mirrors the layout.
- **State** (`CanvasStore`): the same `runStream` reconnect logic as the other stores, but `live` is a map of every running reply and `busyBranches` a set, so any number of lanes stream at once. `fanOut` creates N sibling branches off one message (each its own mode and model) and sends one message to all. The **lineage** of the selected lane is `GET /api/branches/:id/context?resolve=false`, cached per leaf and refreshed after each completion; its segments sort cards into verbatim, summarized (branch summary or compaction) and dropped, and the lane head shows the budget.
- **Not there**: reviewer, shares, export, backups, system prompt editor. Those stay in the power app, which shows the same conversations.

---

## 8. Milestones

Each milestone ends green on `pnpm test`, `pnpm typecheck` and `pnpm lint`, and is checked under `wrangler dev`.

1. **Foundation**: monorepo, shared contracts, D1 schema and migration, `FakeProvider`, and context assembly with exhaustive tests.
2. **Worker API**: D1 repositories, `ChatService`, Hono routes, the `TreeSession` DO with SSE, reconnect and cancel, the context-plan endpoint, and the auth middleware (Better Auth since the sign-in migration).
3. **Real providers**: SSE parser, Anthropic, OpenAI-compatible (OpenRouter), registry, secrets, and optional AI Gateway `baseUrl`.
4. **Angular UI**: sidebar outline, chat view with streaming, branch dialog, breadcrumbs, navigation.
5. **Summary mode end to end**: the resolve loop, D1 cache, invalidation by hash, and the summary model setting.
6. **Inspector, auto-titles and polish**.
7. **Sharing**: scopes, snapshot/live, private exclusion, viewer, revoke/expiry, rate limit, edge cache.
8. **Publishing**: Markdown and HTML export on the viewer renderer.
9. **Deployment**: README (D1 create, migrations, secrets, sign-in setup, deploy), JSON backup/import.

Execution: the contracts (§3) were frozen first. Implementation then fanned out to parallel worktree agents: (a) context assembly, rendering and hashing; (b) providers; (c) tree utilities, share projection and the render package; (d) Worker, repositories and services; (e) the Angular UI. After that came integration, milestone verification and polish.

---

## 9. Test strategy

- **Pure unit tests** (Vitest, Node): context assembly (§4.6), rendering, SHA-256 against known vectors, tree utilities and navigation, share projection (scopes, private exclusion, no id leakage), markdown sanitization (XSS corpus: `<script>`, `javascript:` links, raw HTML, `onerror`), the viewer page (CSP hashes match the inline script/style), and Markdown export.
- **Provider tests** (Vitest, Node, injected `fetch`): the SSE parser (chunk boundaries, CRLF, comments, multi-byte UTF-8), Anthropic event mapping (usage, mid-stream error, HTTP errors → codes, abort), OpenAI/OpenRouter (both usage shapes, `[DONE]`, in-stream error, abort), FakeProvider determinism, and the registry (availability and config parsing).
- **Worker integration tests** (`@cloudflare/vitest-pool-workers`, real D1 and DO in workerd): repositories (CTE, batch atomicity, snapshot chunking); the API (CRUD, branching, validation, 404s); the send → SSE → persisted flow with FakeProvider; reconnect, cancel and 409 on a concurrent send; the context-plan endpoint; summary mode with cache hits; sign-in (magic link end to end, Google callback against a mocked token endpoint, remember me, verified-email gating, captcha, passkey gating, fail-closed); accounts across users and modes (`multi-user.test.ts`: every tree, branch, node and share route 404s for another user, Learn on own key vs paid credit, server-key gating, the default system prompt and `/api/settings` per account and mode); and shares (snapshot immutability after new messages, republish, revoke → 410, expiry, private exclusion in the payload, rate limit → 429, view count, cache-version bump).
- **Angular**: pure logic lives in `@tangent/core` and is tested there. The stores and helpers are tested in Node (`*.spec.ts`); components are rendered with TestBed in happy-dom and driven by role, text and user events (`*.dom.spec.ts`, set up in `packages/web-shared/src/testing/`). `ng build` runs in CI as a compile check (strict templates).
- **Manual/E2E**: `scripts/smoke.sh` runs against `wrangler dev` with curl: create, send, branch, plan, share, public view, revoke → 410, export. The UI was also walked through in headless Chromium (Playwright) under `wrangler dev`: chat, branch dialog in all three modes, inspector, outline, breadcrumbs, keyboard navigation, share → logged-out phone view → revoke. The same was done for the viewer/export page (path composition, no CSP violations, mobile drawer).

---

## 10. Portability (Node/Docker port)

**Runtime-agnostic (no Workers imports; only `fetch`, `ReadableStream`, `TextEncoder/Decoder`, `AbortSignal`, `crypto.getRandomValues`, `btoa`):**

- `@tangent/shared`: types, zod schemas and the API contract.
- `@tangent/core`: context assembly, rendering, tree utilities, share projection, `ChatService`, `ShareService` and the repository **interfaces**.
- `@tangent/providers`: all providers and the registry. Secrets are passed in as a plain map.
- `@tangent/render`: markdown, the viewer page and Markdown export (no DOM).

**Workers-specific (apps/worker only):**

- Hono wiring. Hono itself runs on Node via `@hono/node-server`, so the routes port nearly unchanged.
- The D1 repositories (`src/db/*`). Replace them with better-sqlite3 or Postgres implementations of the same interfaces. The SQL, including the recursive CTEs, is plain SQLite and the Drizzle schema can be reused.
- The `TreeSession` Durable Object. Replace it with an in-process `Map<treeId, TreeSessionState>` that holds the running generation, the event buffer and the subscribers, plus a per-tree async mutex. It calls the same `ChatService.beginSend`/`runGeneration`, and `recoverInterrupted` runs at startup.
- Sign-in. Better Auth runs on Node too; swap the D1 Drizzle instance for a better-sqlite3 or Postgres one, and replace Workers Static Assets' `_headers` CSPs with server headers.
- The edge Cache API and the rate-limit binding. Replace them with an in-memory LRU (or nginx) and a token-bucket middleware.
- `waitUntil`. Replace it with fire-and-forget promises.
- Static assets. Replace them with `serveStatic`, or nginx in front.
- Wrangler migrations. The same SQL files apply with any SQLite migration runner.

---

## 11. Where Workers is a poor fit (and what we do)

- **Long generations after a disconnect.** `waitUntil` caps at 30 s, so a Durable Object owns each generation. On the Free plan (10 ms CPU per request) streaming parse and re-encode is tight; the Paid plan is recommended (README).
- **Global cache purge.** The Cache API is per colo and cannot be purged globally by URL. We avoid needing a purge by doing a per-request validity check plus versioned cache keys. The CDN (`Cache-Control: public`) is never used for share responses.
- **Exact token counts.** There is no tokenizer in the bundle. We use estimates plus the provider's reported usage, and the Anthropic `count_tokens` endpoint in the inspector when available.

---

## 12. Status (end of initial build)

All nine milestones are implemented. `pnpm test` runs 461 tests: providers 93, core 208, render 67, web 16 and worker 77. The worker tests run in workerd against real D1 and a real Durable Object. `pnpm typecheck` (including Angular strict templates) and `pnpm lint` are clean.

Known gaps and follow-ups:

- **Not verified against live accounts.** The real Anthropic and OpenAI-compatible providers are tested against recorded-style SSE streams with an injected `fetch`, not live APIs, because this environment has no keys. Likewise, the rate-limit binding and the Cache API have not been exercised against a real Cloudflare account. Sign-in was exercised end to end in `wrangler dev` (magic link, Turnstile test keys, passkeys with a virtual authenticator); Google/GitHub were tested against mocked token endpoints, not live OAuth apps, and Resend against a stubbed `fetch`.
- **Missing automated tests.** Share-route rate limiting (429) has no automated test; the limiter fails open when unavailable, and that behaviour is tested. The Angular components have no DOM tests; they were checked through Playwright walkthroughs.
- **Deferred by design:** regenerate, edit-and-resend (as a sibling branch), delete subtree, search, "fork this share into my tree", and share passwords. §5 describes how the last two slot in.

---

## 13. Simple mode and billing

Added after the initial build (migration `0003_billing`); the built-in provider and credit were later opened to power mode. Setup and pricing for operators are in the README ("Membership, credit and billing"); the decisions and their reasons are in DECISIONS ("Accounts", "Simple mode and billing", "Unified billing and model access"); the research behind them is in RESEARCH ("Simple mode and billing").

- **Who:** every user, through the Power | Learn switch; Learn acts as their `simple` account `u_<userId>`.
- **Power mode:** the user's own providers, plus, where the server offers it, the built-in provider as **Tangent credit** (`builtInPowerConfig`: the same key and caps, `openModels`, the Learn models as suggestions). Only calls on it are metered (`callPayer(account, funding)`). Its provider id is the endpoint `openrouter`, the same as the user's own OpenRouter; a branch on it stores `funding: 'credit'`, resolved in a registry of its own on the operator's key, and Learn decides its funding per request (DECISIONS, "Funding apart from the provider"); the default `openrouter` config (when `PROVIDERS` is unset) also lists the suggested models first and takes any model id.
- **Credit is per user:** `AccountContext.billingAccountId` (`u_<userId>`, `default_simple` in the dev bypass) is the ledger id of every balance, hold, usage row, grant, checkout and webhook, in both modes. Trees stay per mode account. `/api/billing/*` answers in both modes.
- **What they use:** one provider, the built-in endpoint `openrouter` (OpenRouter; its id was `tangent` before migration 0020), with Smart and Simple tiers, the built-in system prompt shared with power mode (`DEFAULT_SYSTEM_PROMPT` in `packages/shared`: answer first, then a `<tangents>` block of suggested branches; see DECISIONS "Simple mode and billing") and capped input/output per call. It runs on the learner's own OpenRouter key (unmetered) or, on paid credit, on `BUILT_IN_API_KEY`. Paid credit is offered only when payments (Polar) and that key are configured.
- **Membership:** where the operator sets `POLAR_MEMBERSHIP_PRODUCT_ID` (and `ANNUAL_FEE_ENABLED`), generating on the user's own keys, in Learn, power mode and Canvas alike, needs a $10/year membership (a yearly Polar product) or a waiver (`auth_users.membership_waived`, set by hand or by the `MEMBERSHIP_WAIVER_CODE`); otherwise 402 `membership_required`, and own-key power branches show read-only. Nothing else needs it: Tangent credit is bought and spent without one, and the open pool's caps are the same for everyone (`needsMembership` in `src/billing/gate.ts`; DECISIONS "One membership rule: own keys"). Reading, exporting, deleting and settings stay open. `MembershipInfo` is on `/api/me` and `/api/billing`.
- **How they pay (paid credit):** prepaid credit, top-ups of $5–$500 through Polar's hosted checkout, credited net of Polar's actual fee (plus any credit included with the membership; none by default). No membership is needed to buy or spend it. Each provider call is charged the true cost (OpenRouter's reported cost × (1 + its 5.5% credit-purchase fee)) + `MARKUP_BPS` (10%). Polar, the merchant of record, adds tax at checkout.
- **Code:** `apps/worker/src/simple-mode.ts` (provider and settings), `src/billing/` (`pricing`, `ledger`, `meter`, `reconcile`, `usage-store`, `service`, `membership`, `payments/*`, `providers/*`), `src/routes/billing.ts`, `src/http/learn-app.ts`, `src/auth/account.ts`, `packages/web-shared`, `apps/simple`.
- **Not verified against live accounts:** Polar and OpenRouter are exercised against mocks in the Worker tests (signed synthetic Polar deliveries through the real SDK verification, a mocked Polar API and a mocked generation endpoint). The sandbox checks still to run are in docs/polar-migration/04-verification.md.
- **Out of scope (launch blockers first):** terms and privacy pages; account deletion and data export; auto-recharge; free credit; promotion codes; trials; low-balance and membership-lapse emails; multi-currency; metered (postpaid) billing; Managed Payments; an admin UI.

## 14. Landing page and demo

- **Routes:** `GET /welcome` always serves the landing page. `GET /` serves it to anonymous visitors: no `tangent.session_token` / `__Secure-tangent.session_token` cookie and not the dev bypass. Otherwise `/` goes to `ASSETS` (the power app's `index.html`) with the `_headers` `/*` CSP set by the Worker. HEAD is answered like GET; other methods fall through to the 404 handler.
- **Page:** server-rendered by `apps/worker/src/http/landing.ts`. One HTML document under 25 KB, no JavaScript, one constant inline `<style>` allowed by its SHA-256: `default-src 'none'; style-src 'sha256-…'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, plus `Referrer-Policy: same-origin` and `nosniff`. `/` is `no-cache` with `Vary: Cookie`; `/welcome` is `public, max-age=300`. Light and dark follow `prefers-color-scheme` with the base.css palette.
- **Calls to action:** "Try the demo" → `/learn/demo`, "Start learning" → `/learn/login`, "Power users: sign in" → `/login`.
- **Demo:** `/learn/demo` is a route of the simple app that runs against an in-memory `ChatService`, with replies generated from random English sentences (`txtgen`). No sign-in, no model calls, no cost; state lives only in the browser tab (`sessionStorage`). `/demo` is the power app's demo on the same backend (`@tangent/web-shared/demo`); it has no shares, keys or exports, and the Power / Learn switch links the two demos. New conversations in both demos get the built-in prompt, and `/api/settings` works there in memory (kept with the session).
- **Tests:** `apps/worker/test/landing.test.ts` (CSP hash against the inline style, cookie and dev-bypass routing, HEAD, fall-through).

## 15. Community credit pool

Specified in [pool/SPEC.md](pool/SPEC.md) and planned stage by stage in [pool/PLAN.md](pool/PLAN.md); the decisions are in DECISIONS ("Community credit pool"). Built so far:

- **Ledger:** the pool is one more account (`POOL_ACCOUNT_ID`, default `pool`) in `credit_grants` and `usage_events`. Its columns: `credit_grants.user_id` and `usage_events.funding`, `user_id`, `branch_id`, `ip_key`, `dispatched_at`, `overage_micros`, `settle_reason`, with their indexes.
- **PoolBank** (`apps/worker/src/pool/pool-bank.ts`, binding `POOL_BANK`, Durable Object migration `v2`): serialises reservations, checks the daily caps (one set for everyone since DECISIONS "One membership rule: own keys"; earlier free and member tiers), expires stale reservations from its alarm, and keeps the balance checkpoint the cron advances and verifies.
- **Reserve, settle, expire:** the usage meter's pool funding (`createPoolUsageMeter`) reserves each call's worst case (or shrinks a reply's earlier reservation), stamps `dispatched_at`, and settles by `pool/settle-policy.ts`; charges are clamped to the hold, and the overage feeds a breaker.
- **Config:** every cap, price, margin, limit and flag is in `apps/worker/src/config.ts` (`appConfig`); `POOL_ENABLED` is off in `wrangler.jsonc`.
- **Funding-source routing:** Learn's payment header gains `pool`; a Learn `AccountContext`'s `payer` (`own-key`, `credit`, `pool`) and its `pool` (the pool's parameters, resolved Worker-side) decide who pays. One gate (`apps/worker/src/billing/gate.ts`) fronts sends, reviews and `context?resolve`: a Learn send or resolve on spent credit falls back to the pool; reviews never do and are refused on the pool; power never uses it.
- **Pool restrictions:** a generating pool request runs on the pool model only, with the locked system prompt, the pool's input and output caps and a maximum message length, whatever the tree or branch says (`ChatServiceDeps.pinnedModel`/`systemPromptOverride`, `poolProviderConfig`, `pinnedModelRegistry`). The tree's Durable Object reserves the reply before writing any node, so a refusal is a 402 `pool_empty` / 429 `pool_cap_reached` / 403 `pool_unavailable` with `error.pool` details.
- **Tests:** `apps/worker/test/pool-bank.test.ts` (concurrency, caps, expiry, clamp and breaker, checkpoint), `pool-routing.test.ts` (overrides ignored, funding resolution, refusals before any node), `pool-pricing.test.ts`, `config.test.ts`; `packages/core/test/services/pinned-model.test.ts`.
- **Abuse controls:** per-minute rate limits per user and per network in PoolBank (failing closed), on top of the daily caps; account gates in `billing/gate.ts` (suspension, a Turnstile pass on record, one pool identity per normalised mailbox, minimum account age); Turnstile at first sign-in (magic links record their pass, OAuth sign-ins go through the `/verify` interstitial) with `POST /api/pool/verify` as the first-use fallback; the admin suspend flag and consumption report (`PATCH /api/admin/users/:id` `poolSuspended`, `GET /api/admin/pool/usage`). Tests: `pool-abuse.test.ts`, the interstitial in `auth.test.ts`, rate limits in `pool-bank.test.ts`.
- **Funding:** nobody buys pool credit; the operator funds the pool with admin adjustments. (The revenue share and the refunds and disputes of legacy pool purchases were removed 2026-10: DECISIONS, "Money scope cut before launch".) Purchases go through one interface (`apps/worker/src/billing/purchases.ts`): a checkout is personal credit only, and `fulfilPurchase` credits it net of the payment provider's fee. The webhook stays idempotent on the provider's object (`provider_ref`); refunds and disputes debit only purchases on a user's own ledger; disputes of top-ups are automatic, and a lost one suspends the buyer's pool access. Admins credit a user or the pool with `POST /api/admin/credit` (adjustments; simulated purchases, personal only, with `DEV_PURCHASES_ENABLED`). Tests: `pool-funding.test.ts`.
- **Consent and topic tagging:** removed 2026-10 with the pool notice (DECISIONS, "Money scope cut before launch").
- **Weekly impact feed:** removed 2026-10 (DECISIONS, "Money scope cut before launch"). The admin page's **Open pool** panel (`pool-page.ts`, `GET /api/admin/pool`) shows the pool's balance, holds and overage breaker state and tops it up through `POST /api/admin/credit`.
- **Featured conversations:** not built; no flag, route, table, column or UI exists (DEFERRED).
## 16. Grounding (web search)

The decisions are in DECISIONS ("Grounding"), the research in RESEARCH ("Web search"), and operator setup in the README ("How Tangent checks facts").

- **Flow:**
  1. `ChatService.runGeneration` computes the branch depth (`chain.length - 1`) and whether the context was summarized, then calls `decideGrounding` (`packages/core/src/grounding/policy.ts`). It returns `none | auto | required`.
  2. For `auto`/`required`, the request carries `GenerateRequest.webSearch` (`maxResults`, `maxUses` 1, `engine`). `GROUNDING_INSTRUCTIONS` (or `CHECK_SOURCES_INSTRUCTIONS`) is appended through `renderPlan`'s `extraSystem`.
  3. The OpenAI-compatible provider sends the `openrouter:web_search` server tool and maps the stream: `url_citation` annotations become `citations` events, a search tool call becomes `activity` ("Checking sources…" status), and `server_tool_use` becomes `billing.webSearches`.
  4. The reply's sources are stored in `nodes.sources` (JSON; null = didn't search).
- **Check sources:** `POST /api/branches/:id/messages` with `ground: 'required'`. It is a 400 when the branch's provider can't search, and otherwise goes through the same gates as any send.
- **Billing:**
  - OpenRouter folds the search fee into the reported cost, so the meter bills it unchanged.
  - `usage_events.web_searches` records the count: from the reported count, else 1 once a search started, else 1 when `/generation` reports search results.
  - `GROUNDING_AUTO_DAILY_CAP` stops automatic searches on credit (`apps/worker/src/billing/grounding.ts`).
- **Settings:**
  - `GROUNDING`, `GROUNDING_MAX_RESULTS`, `GROUNDING_ENGINE` and `GROUNDING_AUTO_DAILY_CAP` (wrangler vars).
  - `branches.grounding` (power, inherited when branching; Learn ignores it).
  - `ProviderConfig.options.webSearch` (set on the built-in provider and the default `openrouter`).
- **UI:**
  - `SourcesList` (`packages/web-shared/src/ui/sources-list.ts`) under each finished reply in both apps: "Checked against N sources" with chips, or "From the tutor's own knowledge" with Check sources.
  - The grounding select in power's branch settings.
  - "+ web search" on billing usage rows.
  - A Sources list in shares and exports (`sourcesMarkdown`).
  - The in-browser demo simulates searches with example.org sources.
- **Not verified against a live account:** the stream shapes and cost reporting above are from OpenRouter's docs; see RESEARCH for what to check with a real key.

## 17. Links between messages

Cross-links ("this relates to that") between two messages of the same tree, outside the branch structure. The decisions are in DECISIONS ("Links between messages"), the gaps in DEFERRED.

- **Data:** `NodeLink { id, treeId, sourceNodeId, targetNodeId, note, origin, createdAt, updatedAt }` (`packages/shared/src/domain.ts`), table `node_links` (§2). `TreeDetail.links` carries a tree's links, oldest first.
- **API:** `POST /api/links` (`{ fromNodeId, toNodeId, note? }` → `NodeLink`: 201 new, 200 the existing link when the pair is already linked either way round; 400 for a self-link, two trees, a note over `MAX_LINK_NOTE_CHARS` (500) or a tree already at `MAX_LINKS_PER_TREE` (1000); 404 for another account's messages), `PATCH /api/links/:linkId` (`{ note }`, blank = none) and `DELETE /api/links/:linkId` (204). None generates, so there is no gate: read-only power branches can be linked. The demos answer the same routes (`packages/web-shared/src/demo/backend.ts`, kept with the session), and the demos' example lesson (all three demos start with it) has one link, from the main thread to the followed tangent.
- **Lifecycle:** deleting a branch drops the links touching its subtree's messages (explicitly in `deleteBranches`, and by the node FKs' cascade); deleting the tree drops all of them. JSON backups carry them (`TreeBackup.links`, optional so older backups import); import remaps them onto the new message ids and drops a link whose ends aren't both in the backup, a self-link or a repeated pair. Copy to Learn carries them. Shares and Markdown/HTML exports leave them out.
- **Client helpers:** `packages/core/src/links.ts` (also `@tangent/core/links`): `pairKey`, `indexLinks` (by either end), `otherEnd`, `describeEndpoint` (branch crumbs, "Tangent: ‹title›" for a branch's first message, a plain-text snippet), `linkTarget`, `searchNodes` (the link picker's search) and `branchesWithLinks`. `ApiClient.createLink` / `updateLink` / `deleteLink`.
- **Tests:** `packages/shared/src/links.spec.ts`, `packages/core/test/links.test.ts`, `packages/core/test/services/links.test.ts`, `apps/worker/test/links.test.ts` (routes), the `links` suite of `d1-repositories.test.ts`, link routes in `multi-user.test.ts` (another user's ids are 404) and `read-only-power.test.ts`, and the demo backend's link suite.
