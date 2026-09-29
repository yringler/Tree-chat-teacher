# Tangent: plan

Tangent is a self-hosted, single-user web app for tree-structured LLM conversations. It runs on Cloudflare Workers with D1 and a Durable Object, and has an Angular front end.

The idea: any message can spawn child **branches**. Each branch sends the model exactly the context its **context mode** allows. The UI is a linear chat of the selected branch's path plus a collapsible outline of the branches.

> The source of truth for contracts is the code in `packages/shared/src` and `packages/core/src/repository.ts`. This document summarizes them and explains why they look the way they do. Research notes, with links to the docs they came from, are in [RESEARCH.md](./RESEARCH.md). One-line decisions are in [DECISIONS.md](./DECISIONS.md).

---

## 1. Architecture

```
Browser (Angular 22, zoneless, signals)          Anonymous viewer (phone/desktop)
   │  fetch + SSE (/api/*)                            │  GET /s/<token>[/data.json]
   ▼                                                  ▼
Cloudflare Access (whole host)  ──── path app /s/* with a Bypass policy ────┐
   │ Cf-Access-Jwt-Assertion                                                │ (no JWT)
   ▼                                                                        ▼
┌──────────────────────────── Worker "tangent" (Hono) ────────────────────────────┐
│ static assets (Angular build; SPA fallback)   run_worker_first: /api/*, /s/*     │
│ /api/*  → verify Access JWT (jose, JWKS) → owner routes                          │
│ /s/*    → rate limit (ratelimits binding) → ShareService.checkPublic →           │
│           edge cache (Cache API, versioned key) → viewer HTML / JSON DTO         │
│ POST /api/branches/:id/messages ─┐                                               │
│ GET  /api/nodes/:id/stream ──────┼─► Durable Object TreeSession (one per tree)   │
│ POST /api/nodes/:id/cancel ──────┘   owns the generation: provider fetch,        │
│                                      buffers deltas, fans out SSE, persists      │
│ D1 (Drizzle) ◄── D1 repositories (the only D1-aware code)                        │
└──────────────────────────────────────────────────────────────────────────────────┘
           │ fetch (raw, SSE)                         optional
           ▼                                          ▼
   Anthropic Messages API / OpenAI-compatible (OpenAI, OpenRouter, …) ◄─ AI Gateway
```

### Packages (pnpm workspace)

| Package | Runtime deps | Contents |
|---|---|---|
| `packages/shared` (`@tangent/shared`) | zod | Domain types, `ContextPlan`, provider interface, `SharePayload` DTO, and the HTTP/SSE API contract with zod request schemas |
| `packages/core` (`@tangent/core`) | shared | **Context assembly** (pure), prompt rendering, token estimation, sync SHA-256, tree utilities (outline, paths, keyboard navigation), share projection, repository ports, and the `ChatService`/`ShareService` application services |
| `packages/providers` (`@tangent/providers`) | shared | SSE parser, Anthropic provider, OpenAI-compatible provider, `FakeProvider`, config-driven registry |
| `packages/render` (`@tangent/render`) | shared, core, markdown-it, highlight.js | Safe markdown → HTML, the self-contained viewer page (used for both public shares and HTML export), and Markdown export |
| `apps/worker` (`@tangent/worker`) | all packages, hono, drizzle-orm, jose | Hono app, D1 repositories, the `TreeSession` Durable Object, Access JWT, share routes, edge cache, rate limit |
| `apps/web` (`@tangent/web`) | shared, core, render, Angular | The owner UI |

Workspace packages export their TypeScript sources directly (`"exports": "./src/index.ts"`). There is no build step: Wrangler's esbuild, Vite/Vitest and the Angular builder all compile TS from the workspace.

### Request flows

**Send a message** (`POST /api/branches/:branchId/messages {content}`):
1. The Worker verifies the JWT, validates the body and looks up the branch's tree. It forwards the request to `TREE_SESSION.idFromName(treeId)`.
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

---

## 2. Data model (D1)

Schema: `apps/worker/src/db/schema.ts`. Migration: `apps/worker/migrations/0000_init.sql`, generated by drizzle-kit and applied with `wrangler d1 migrations apply`.

| Table | Key columns | Notes |
|---|---|---|
| `accounts` | `id` PK, `name` | Owner of trees and shares. Seeded with the single `default` account (single-user for now; see DECISIONS "Accounts") |
| `trees` | `id` PK, `account_id`, `title`, `system_prompt`, `trunk_branch_id` | The trunk is created with the tree, in the same batch. Branches, nodes and summaries inherit ownership through `tree_id` |
| `branches` | `id` PK, `tree_id` FK cascade, `parent_branch_id`, `branch_point_node_id`, `context_mode`, `anchor_quote`, `title`, `title_source`, `is_private`, `provider_id`, `model` | A branch is a linear chain of nodes. The trunk has null parent and null branch point |
| `nodes` | `id` PK, `tree_id`, `branch_id` FK cascade, `parent_id`, `seq`, `role`, `content`, `status`, `error`, `provider_id`, `model`, `input_tokens`, `output_tokens` | `UNIQUE(branch_id, seq)` serializes appends. Indexes on `parent_id` and on `tree_id` (partial index for `status='streaming'`) |
| `summaries` | PK `(anchor_node_id, source_hash, model)`, `provider_id`, `tree_id`, `content` | Lazy cache. A changed path gives a new hash, so it is a cache miss |
| `shares` | `id` PK, `token` UNIQUE, `account_id`, `tree_id`, `scope`, `target_node_id`, `include_ancestors`, `mode`, `title`, `expires_at`, `revoked_at`, `published_at`, `version`, `view_count` | |
| `share_snapshots` | PK `(share_id, chunk)`, `data` | The snapshot JSON is chunked at 256K chars to stay under D1's 2 MB row limit, and replaced atomically in a batch |

**Branch and node invariants**
- The first node of branch B has `parentId = B.branchPointNodeId` (`null` for the trunk). Node `seq=k>0` has the node at `seq=k-1` as its parent.
- A normal reply appends to the branch leaf. "Branch from here" on any node creates a new branch, even from the leaf, for example to switch mode or model.
- `branchPointNodeId` always belongs to `parentBranchId`.

**Ancestor lookup.** A recursive CTE walks `parent_id` from the target. Each level is a primary-key lookup, so the cost is O(depth). A second CTE walks `parent_branch_id` for the branch chain. Neither needs extra write-time bookkeeping, and both were verified on D1/miniflare (`apps/worker/test/smoke.test.ts`). A materialized path or a closure table would speed up subtree queries. We don't need that: subtrees are only computed when sharing or exporting, and those load the whole tree with `WHERE tree_id = ?`.

---

## 3. Interfaces

The code is the source of truth. The signatures are abbreviated here.

### Domain (`packages/shared/src/domain.ts`)

```ts
type Role = 'user' | 'assistant' | 'system';
type NodeStatus = 'streaming' | 'complete' | 'error';
type ContextMode = 'path' | 'summary' | 'independent';
interface TokenUsage { inputTokens: number; outputTokens: number }
interface Tree { id; title; systemPrompt: string | null; trunkBranchId; createdAt; updatedAt }
interface Branch { id; treeId; parentBranchId: string | null; branchPointNodeId: string | null;
  contextMode: ContextMode; anchorQuote: string | null; title; titleSource: 'default'|'auto'|'user';
  isPrivate: boolean; providerId; model; createdAt; updatedAt }
interface ChatNode { id; treeId; branchId; parentId: string | null; seq: number; role: Role; content;
  status: NodeStatus; error: string | null; providerId: string | null; model: string | null;
  usage: TokenUsage | null; createdAt }
interface SummaryRecord { anchorNodeId; sourceHash; providerId; model; content; treeId; createdAt }
interface Share { id; token; treeId; scope: 'tree'|'subtree'|'path'; targetNodeId: string | null;
  includeAncestors: boolean; mode: 'snapshot'|'live'; title: string | null; expiresAt: string | null;
  revokedAt: string | null; createdAt; updatedAt; publishedAt: string | null; version: number; viewCount: number }
```

### Context plan (`packages/shared/src/context-plan.ts`)

```ts
interface ChatMessage { role: 'user' | 'assistant'; content: string }
type InclusionReason = 'tree-system-prompt' | 'system-node' | 'path-ancestor' | 'branch-message'
  | 'branch-summary' | 'budget-compaction' | 'anchor-quote';
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
interface ProviderCapabilities { maxContextTokens; maxOutputTokens; supportsSystemPrompt: boolean; supportsTokenCount: boolean }
interface GenerateRequest { model: string; system: string | null; messages: ChatMessage[]; maxOutputTokens?: number; signal: AbortSignal }
type ProviderEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; usage: Partial<TokenUsage> }
  | { type: 'done'; stopReason: string | null }
  | { type: 'error'; error: { code: ProviderErrorCode; message: string; status?: number; retryable: boolean } };
interface LlmProvider {
  readonly id: string; readonly kind: ProviderKind; readonly label: string;
  models(): ModelInfo[]; defaultModel(): string; capabilities(model: string): ProviderCapabilities;
  stream(request: GenerateRequest): AsyncIterable<ProviderEvent>;   // never throws; ends with done|error
  countTokens?(request: Omit<GenerateRequest, 'signal'> & { signal?: AbortSignal }): Promise<number>;
}
interface ProviderConfig { id; kind; label; baseUrl?; apiKeySecret?; headers?; extraHeaderSecrets?;
  models: ModelInfo[]; defaultModel; maxContextTokens?; maxOutputTokens?; supportsSystemPrompt?; options? }
interface ProviderRegistry { get(id): LlmProvider | undefined; list(): ProviderInfo[]; defaultProviderId(): string }
// packages/providers/src/registry.ts
const PROVIDER_FACTORIES: Record<ProviderKind, (config: ProviderConfig, env: ProviderEnv) => LlmProvider>;
function createProviderRegistry(configs: readonly ProviderConfig[], env: ProviderEnv): ProviderRegistry;
```

Adding a provider **kind** means one module plus one `PROVIDER_FACTORIES` entry. Adding a provider **instance** (OpenRouter, a local server, an AI Gateway route) is config only: the `PROVIDERS` JSON var plus a secret.

### Repositories (`packages/core/src/repository.ts`)

`TreeRepository` has these methods:
- Trees: `listTrees`, `getTree`, `createTree`, `updateTree`, `deleteTree`
- Branches: `getBranch`, `listBranches`, `getBranchChain`, `createBranch`, `updateBranch`
- Nodes: `getNode`, `listNodes`, `listBranchNodes`, `getAncestorPath`, `appendNodes`, `updateNode`, `listStreamingNodes`
- Backup: `importTree`

`SummaryRepository` has `getSummary(anchorNodeId, sourceHash, model)` and `putSummary(record)`.

`ShareRepository` has `listShares`, `getShare`, `getShareByToken`, `createShare(share, snapshotJson)`, `updateShare(id, patch, snapshotJson?)`, `getSnapshot`, `incrementViewCount`.

### Services (`packages/core/src/services`)

```ts
class ChatService { constructor(deps: { repos: Repositories; providers: ProviderRegistry; settings: ChatSettings; clock?; newId? })
  listTrees(); createTree(req); getTreeDetail(id); updateTree(id, req); deleteTree(id);
  createBranch(req); updateBranch(id, req);
  planContext(branchId, nodeId | null, { resolveSummaries, signal? }): Promise<ContextPlanResponse>;
  beginSend(branchId, content): Promise<{ branch; userNode; assistantNode }>;
  runGeneration(begin, signal): AsyncIterable<StreamEvent>;       // never throws; persists final state
  recoverInterrupted(treeId); exportBackup(treeId); importBackup(backup) }
// packages/core/testing: createMemoryRepositories() — in-memory reference implementation of the ports
class ShareService { constructor(deps: { repos; publicBaseUrl; clock?; newId?; newToken? })
  list(); create(req); update(id, req); republish(id); revoke(id);
  checkPublic(token); resolvePublic(token); recordView(shareId) }
```

### HTTP API and SSE (`packages/shared/src/api.ts`)

The full route table is in the file header. SSE frames are `event: <type>\ndata: <json>\n\n`, where `StreamEvent` is one of `start | snapshot | status | delta | usage | done | error`. The order is `start` → `status*` → (`delta`|`usage`)* → exactly one of `done` or `error`. Clients parse SSE from `fetch()` (POST bodies rule out `EventSource`).

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
  'independent' → []                                    // hard boundary
anchor(Bi) = Bi.anchorQuote ? [AnchorSegment] : []      // in every mode
plan.segments = [treeSystemPrompt?] ++ ctx(k)           // then the budget pass
```

Resulting semantics:
- **The trunk stays trim.** `ctx(i)` only ever looks up the chain, never at siblings or descendants.
- **`path` is compositional.** A `path` branch continues exactly what its parent branch would have sent at the branch point. It does not re-expand content that an ancestor `summary` or `independent` branch deliberately dropped. For example, a `path` branch under a `summary` branch under the trunk sends [summary of trunk up to P1] + [anchor1] + [summary-branch messages up to P2] + [anchor2] + [own messages].
- **`summary` summarizes the parent's effective context**, which may itself contain a summary. Nested summaries therefore compose, and the inner one is simply part of the transcript being summarized.
- **`independent`** sends only the anchor quote (the topic) and its own messages. The tree's system prompt is still included, because it is tree-wide configuration, not conversation content.
- **System-role nodes** on the path become `system` segments (reason `system-node`) where they are inherited. They are never summarized.
- Nodes with status `streaming`/`error` and empty content are skipped. This covers an in-flight or failed reply.

### 4.2 Segment typing and provenance

- Nodes of the target branch become `branch` segments (reason `branch-message`). Inherited nodes become `ancestor` segments (reason `path-ancestor`, `viaBranchId` = the owning branch).
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
2. **Compaction.** Find the shortest *oldest-first prefix* P of the candidates such that `total − tokens(P) + compactionSummaryTokens (default 1024) ≤ budget`. Replace P with one compaction summary segment. Its key is `{ anchorNodeId: last node in P, sourceHash: hash(flatten(P)) }` and it has `reason: budget-compaction`. Record `CompactionRecord { compactedNodeIds, tokensBefore, tokensAfter, key }`. P may include inherited summaries and anchors; they are re-summarized.
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
- budget: fits, compaction with the tail kept, compaction including inherited summaries, the truncation fallback, and compaction with a ready summary;
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
- **Why not reuse Angular for viewers?** Anonymous viewers would need the Angular bundle to be reachable without Access, which means bypassing assets too. They would also run owner code. A self-contained page needs only the single `/s/*` bypass rule, loads fast on phones, and doubles as the offline export.
- **Exports**: `/api/export?format=md|html&scope=…` builds the payload with `projectShare`. Owners may pass `includePrivate=true`. It then calls `payloadToMarkdown` or `renderViewerPage({ variant: 'export' })`. The JSON backup/restore (`/api/trees/:id/backup`, `/api/import`) is owner-only and includes everything.
- **Later (designed for, not built)**:
  - *Fork this share into my tree*: `POST /api/import-share {token}` would map a `SharePayload` back to branches and nodes. Keys make this lossless for content, and modes default to `path`.
  - *Share passwords*: a `password_hash` column on `shares` and a `/s/<token>/unlock` form that sets a signed, token-scoped cookie. `checkPublic` already centralizes access decisions.

---

## 6. Access control

- Two Access applications cover one hostname. The first protects `tangent.example.com` (allow: the owner's email). The second covers `tangent.example.com/s/*` with a **Bypass** policy; the more specific path wins.
- The Worker verifies `Cf-Access-Jwt-Assertion` on every `/api/*` request using `jose.createRemoteJWKSet(https://<team>.cloudflareaccess.com/cdn-cgi/access/certs)`, with `issuer` = team domain and `audience` = AUD tag. So even a direct `*.workers.dev` hit cannot use the API.
- If `ACCESS_AUD` is empty, the Worker refuses all `/api/*` requests with 500 "not configured". The exception is `DEV_ALLOW_NO_AUTH=true` (in `.dev.vars` only), which lets local dev run without auth. The Worker fails closed.
- `/s/*` never checks a JWT. Because it bypasses Access, it gets no identity, and it serves only allow-listed DTOs.
- Static assets are protected by Access at the edge. They contain no data; the API is what is gated. Once a custom domain is set, `workers_dev` should be set to false (README).
- The alternative was a separate share hostname. That gives stronger origin isolation but requires a second domain. We chose the path bypass because the viewer is self-contained, under a strict CSP, and holds no credentials: the owner app's cookies are Access cookies, and the viewer page runs no owner code. See DECISIONS.

---

## 7. Front end (Angular 22)

The app uses standalone components, signals, zoneless change detection (the default in v21+) and the `@angular/build:application` builder. Its output (`apps/web/dist/web/browser`) is served as Workers Static Assets with an SPA fallback.

- **Layout**: a left sidebar holds the tree list and the outline of the selected tree (collapsible, and a drawer on phones). The main pane is the chat. The Context Inspector is a toggleable right panel.
- **Chat view**: breadcrumbs (trunk › … › branch), the messages of the branch path rendered with `renderMarkdown` and highlight.js, and a composer. Each message has:
  - a **Branch from here** action, which opens a dialog with the mode picker, the selected text as the anchor quote, an optional title, and the provider/model inherited from the parent;
  - an "**N branches**" indicator that expands to a list of child branches;
  - a return-to-parent link on the first message of a branch.
- **State**: a `TreeStore` built on signals holds the tree detail, the `TreeIndex`/outline (`@tangent/core`), the selected branch/node, and live streams. An `ApiClient` wraps `fetch`, and an SSE reader built on `ReadableStream` handles reconnects.
- **Keyboard**: `Alt+↑` or `[` moves to the parent branch (focusing the branch point), `Alt+←/→` moves to the previous/next sibling, `Alt+↓` or `]` moves to the first child, `j/k` moves between messages, `b` branches from the focused message, `/` focuses the composer and `i` toggles the inspector. The logic lives in `navigate()` in `@tangent/core`, where it is unit-tested.
- **Branch settings**: title (auto or edited), mode, anchor quote, private toggle, provider/model.
- **Shares page**: create (scope, mode, include ancestors, title, expiry), copy link, republish, revoke. **Export menu**: Markdown, HTML and JSON backup; Import restores a backup.

---

## 8. Milestones

Each milestone ends green on `pnpm test`, `pnpm typecheck` and `pnpm lint`, and is checked under `wrangler dev`.

1. **Foundation**: monorepo, shared contracts, D1 schema and migration, `FakeProvider`, and context assembly with exhaustive tests.
2. **Worker API**: D1 repositories, `ChatService`, Hono routes, the `TreeSession` DO with SSE, reconnect and cancel, the context-plan endpoint, and Access JWT middleware.
3. **Real providers**: SSE parser, Anthropic, OpenAI-compatible (OpenRouter), registry, secrets, and optional AI Gateway `baseUrl`.
4. **Angular UI**: sidebar outline, chat view with streaming, branch dialog, breadcrumbs, navigation.
5. **Summary mode end to end**: the resolve loop, D1 cache, invalidation by hash, and the summary model setting.
6. **Inspector, auto-titles and polish**.
7. **Sharing**: scopes, snapshot/live, private exclusion, viewer, revoke/expiry, rate limit, edge cache.
8. **Publishing**: Markdown and HTML export on the viewer renderer.
9. **Deployment**: README (D1 create, migrations, secrets, Access apps and bypass, deploy), JSON backup/import.

Execution: the contracts (§3) were frozen first. Implementation then fanned out to parallel worktree agents: (a) context assembly, rendering and hashing; (b) providers; (c) tree utilities, share projection and the render package; (d) Worker, repositories and services; (e) the Angular UI. After that came integration, milestone verification and polish.

---

## 9. Test strategy

- **Pure unit tests** (Vitest, Node): context assembly (§4.6), rendering, SHA-256 against known vectors, tree utilities and navigation, share projection (scopes, private exclusion, no id leakage), markdown sanitization (XSS corpus: `<script>`, `javascript:` links, raw HTML, `onerror`), the viewer page (CSP hashes match the inline script/style), and Markdown export.
- **Provider tests** (Vitest, Node, injected `fetch`): the SSE parser (chunk boundaries, CRLF, comments, multi-byte UTF-8), Anthropic event mapping (usage, mid-stream error, HTTP errors → codes, abort), OpenAI/OpenRouter (both usage shapes, `[DONE]`, in-stream error, abort), FakeProvider determinism, and the registry (availability and config parsing).
- **Worker integration tests** (`@cloudflare/vitest-pool-workers`, real D1 and DO in workerd): repositories (CTE, batch atomicity, snapshot chunking); the API (CRUD, branching, validation, 404s); the send → SSE → persisted flow with FakeProvider; reconnect, cancel and 409 on a concurrent send; the context-plan endpoint; summary mode with cache hits; Access middleware (JWT signed with a local JWKS, missing/invalid → 401/403, fail-closed); and shares (snapshot immutability after new messages, republish, revoke → 410, expiry, private exclusion in the payload, rate limit → 429, view count, cache-version bump).
- **Angular**: pure logic lives in `@tangent/core` and is tested there. A small set of Vitest tests covers the SSE client parser and the store reducers without a DOM. `ng build` runs in CI as a compile check (strict templates).
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
- Access JWT verification. It is the same `jose` code if the app stays behind Access (e.g. via Cloudflare Tunnel). Otherwise swap in a reverse-proxy auth.
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
- **Not verified against live accounts.** The real Anthropic and OpenAI-compatible providers are tested against recorded-style SSE streams with an injected `fetch`, not live APIs, because this environment has no keys. Likewise, the Cloudflare Access setup, the rate-limit binding and the Cache API have not been exercised against a real Cloudflare account. The JWT check is tested with locally signed tokens.
- **Missing automated tests.** Share-route rate limiting (429) has no automated test; the limiter fails open when unavailable, and that behaviour is tested. The Angular components have no DOM tests; they were checked through Playwright walkthroughs.
- **Deferred by design:** regenerate, edit-and-resend (as a sibling branch), delete subtree, search, "fork this share into my tree", and share passwords. §5 describes how the last two slot in.
