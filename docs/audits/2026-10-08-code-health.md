# Code health audit — 2026-10-08

Snapshot: `master` at `3a71bdc` (PR #48). ~64k lines of source, ~48k lines of tests, 239 commits (shallow clone; visible history 2026-09-29 → 10-08).

## How this was done

Nine auditors ran in parallel. Six covered one area each: worker money, worker platform, core packages, `apps/web`, canvas+admin, and Learn+web-shared. Three covered the whole repo: duplication and dead code, tests and tooling, and scope, docs and history.

- They read the code and ran tools: jscpd, knip, madge, `pnpm typecheck`/`lint`/`test`/`coverage`/`build`/`e2e`, and a TypeScript-API function-length scan.
- They wrote throwaway tests to reproduce suspected bugs. None of those tests are committed.
- Every High finding below was then re-checked by hand against the source. The **Verified** column says how.

## Verdict

Line by line, the code is good. TypeScript is strict with `noUncheckedIndexedAccess`. Source has zero `any`, `@ts-ignore` or `eslint-disable`. Every JSON body is validated with zod schemas from `packages/shared`. Worker tests run in real workerd with real D1 and Durable Objects, and reach 95.5% line coverage. Package layering is clean, and there is very little dead code.

The problems are structural, and they compound:

1. **Scope is roughly 3–4× what a pre-launch product needs.** Most of it is monetization: about 14 money concepts, ~24k lines of code and tests, and pricing rewritten 9 times in 7 days, each rewrite leaving residue behind. Every feature then has to work across *app × payer × membership × provider × purpose × grounding × context mode*.
2. **The frontend state engine is copied three times.** `tree-store`, `canvas-store` and `lesson-store` are 55–72% identical. Features get built three times, and the copies have already drifted into bugs.
3. **A few files concentrate everything:** `ChatService` (2,060 lines, 16 responsibilities, 9 product-mode flags), the three stores, `routes/api.ts`, `MessageItem`. Every PR touches them.
4. **There are no guardrails for an AI-written codebase.**
   - PRs of 13–19k lines were merged minutes after their last commit.
   - Deploys aren't gated on CI, and D1 migrations are applied by hand.
   - There is no CLAUDE.md.
   - Docs total ~900 KB and work as a changelog; 12 of the 28 doc claims checked were wrong.

Because of (1), (2) and (3), a "small" feature lands in 30–110 files. Because of (4), nothing pushes back on that.

| Area | Grade | One line |
|---|---|---|
| Core packages (core/providers/shared/render) | C+ | `assembleContext` and the layering are A-grade; `ChatService` and silent context-loss bugs pull it down |
| Worker — money (billing/pool/byok) | C- | Sound ledger primitives, over-built composition, two live money bugs |
| Worker — platform (routes/db/auth/DO/http) | C+ | Access control is excellent; one auth-config hole, a DO race, and ~30–40% over-scope |
| apps/web | C+ | Careful components inside a god-object store and a 548-line message component |
| apps/canvas | C | The view is worth keeping; ~70% of its store is a drifting fork of web's |
| apps/admin | B | Thin and safe; specs only mirror the templates |
| apps/simple + web-shared | C | Good primitives; payment logic sprawl; the library shares widgets but not logic |
| Whole repo (duplication, types, cycles) | B- | Strong foundations; frontend copy-forks; 11 import cycles in the worker |
| Tests / CI / tooling | B | Excellent backend tests; weak frontend tests; deploys ungated; master red |
| Scope / docs / process | D | Scope is 3–4× need; docs drift; no guardrails |

---

## 1. Fix now: live bugs

Ordered by impact. Effort: S = hours, M = a day or two, L = more.

| # | Sev | Bug | Where | Effort | Verified |
|---|---|---|---|---|---|
| 1 | **H** | **The open pool refuses every reply as configured.** See note 1 below. | `do/tree-session.ts:309`, `pool/pricing.ts:109-115`, `pool/pool-bank.ts:367`, `wrangler.jsonc:289,316` | S | Hand-computed + read code path |
| 2 | **H** | **Tangent-credit overdraft race.** See note 2 below. | `billing/service.ts:67-83`, `usage-store.ts:41-72` | M | Reproduced (probe) + code read |
| 3 | **H** | **OAuth links unverified emails to existing accounts.** See note 3 below. | `auth/auth.ts:218` | S | Better Auth source + repro test |
| 4 | **H** | **Deploys are ungated and migrations are manual.** Workers Builds deploys every push to master whatever CI says, and runs no `d1 migrations apply`. Master is red right now. 19 migrations landed Oct 5–8. A merge carrying a migration ships code before its schema. | README "Deploying from Git"; `wrangler.jsonc:70` | S | README deploy command read |
| 5 | M | **Stop on a finished reply marks other branches' live replies as failed.** `cancel` with no live run calls the tree-wide `recoverInterrupted`, which errors every `streaming` node in the tree, including other branches still streaming in the same DO. The next send on such a branch then passes the "already streaming" guard, and the branch gets overlapping exchanges. | `do/tree-session.ts:477-482`, `chat-service.ts:1726` | S | Code read; repro test by auditor |
| 6 | M | **Three paths silently drop context.** See note 6 below. | `chat-service.ts:163,912-921,961-990`, `assemble.ts:611-651`, `registry.ts:421` | S each | (a), (b) code read; all three reproduced |
| 7 | M | **Web: a stale tree load can land after you leave the tree.** `setRoute(null)` clears `detail` without bumping `detailSeq`, and `startConversation` doesn't bump it either. A slow `getTree(X)` can then resolve onto the home page, or onto a new conversation Y. In the second case the next composer send goes to X's trunk. | `apps/web/.../tree-store.ts:497-511,579-625` | S | Code read; repro test by auditor |
| 8 | M | **Canvas drift bugs.** (a) The branch dialog pre-fills the parent's locked own-key route; web has the `usable` fallback, canvas doesn't. Result: an empty, read-only lane and a hidden draft. Tangents and the `b` shortcut ignore `locked()` too. (b) The canvas keys dialog dropped web's disclosure "you are trusting this server not to log it". | `apps/canvas/.../branch-dialog.ts:220-230`, `keys-dialog.ts:134` vs `apps/web/.../branch-dialog.ts:137-149`, `api-keys.ts:139` | S–M | Both diffs read |
| 9 | M | **Deleting a tree doesn't go through its DO.** Running generations keep billing credit or the pool for discarded text. Held Compare candidates (question plus answers) sit in DO storage forever after tree or account deletion, which contradicts `/privacy` ("Deleting is immediate"). | `routes/api.ts:188-191`, `do/tree-session.ts:345-356`, `auth/delete-account.ts` | S–M | Auditor |
| 10 | M | **BYOK cookie survives sign-out and isn't bound to a user.** On a shared browser, the next user generates on the previous user's provider keys. | `byok/keys.ts:162-166`, `web-shared/core/auth.ts:140` | S | Auditor |
| 11 | M | **Unbounded import.** `treeBackupSchema` has no `.max` on branches or nodes. Node content can be 1M characters. Import and copy-to-learn have no rate limit. Any signed-up user can write tens of MB per request into the only database. | `shared/api.ts:692,715`, `routes/api.ts:198-222` | S | Auditor |
| 12 | M | **Learn loses the refused message across a real top-up.** The draft lives in a memory signal. Checkout is a full-page redirect. The comment promising it is "offered back after a top-up" is false. | `lesson-store.ts:734-741,890`, `chat-page.ts:175` | S | Auditor |
| 13 | M | **Edit dialogs compare a stale form against the live input.** Saving tree or branch settings during or after the first reply reverts the auto-title and pins it as user-set. With Back while open, the save goes to the wrong branch. | `apps/web/.../branch-settings.ts:168-207`, `tree-settings.ts:77-101` | S | Auditor |
| 14 | M | **"Check sources" on an ancestor's last reply streams into a branch you can't see**, a paid web-searched reply. | `tree-store.ts:755-778`, `message-item.ts:352-365` | S | Auditor |
| 15 | M | **CI: master is red from a 5s-timeout flake** (`multi-user.test.ts:273`). `pnpm -r` bails at the first failure, so the 5 frontend packages and `pnpm build` never ran. | worker `vitest.config.ts`, root `package.json` | S | CI run 37831540896 |
| 16 | — | **Privacy mailbox mismatch.** `docs/LEGAL.md:16,148` says to watch `yrappdev@gmail.com` for privacy requests, which have 30-day deadlines. The live `/privacy` page sends people to `privacy@tangentailearning.com`. Confirm that mailbox exists and forwards. | `wrangler.jsonc:128` | S | Both read |

**1. The pool's ceiling hold.** Before the prompt exists, a pool reply reserves its *ceiling hold*: a full `price.contextTokens` of input plus the output cap. Commit `13c5ae7` (today) moved the pool to V4.1 Flash, which has a 1,048,576-token context. That gives (1,048,576 × $0.15 + 8,192 × $0.60)/M × 1.055 ≈ **$0.171**. The per-user daily cap `POOL_SPEND_MICROS_PER_DAY` is **$0.10**, so `0 + hold > cap` returns `cap_spend` on every user's first reply. The tests miss it because `vitest.config.ts` prices the pool model with an 8k context. Fix: bound the ceiling's input by what the pool actually allows (`min(contextTokens, POOL_MAX_INPUT_TOKENS + margin)`), add a config invariant that the ceiling hold is no more than the per-user cap, and add a test that loads the real wrangler vars.

**2. The credit overdraft race.** `assertCanSpend` reads `balance − held` and `pendingCalls`. The pending row is inserted later, in the tree's DO, unconditionally. A probe granted exactly one hold's worth and sent on 5 trees: one at a time gave `[200,402,402,402,402]`; in parallel it gave `[200,200,200,200,200]`. The real bound is the fail-open 30/min rate limiter, not `USAGE_MAX_PENDING=3`. The flat $0.02 hold applies to *any* OpenRouter model on power credit, so the overdraft can reach hundreds of dollars. Fix: make the pending insert one conditional statement, `INSERT … SELECT … WHERE balance−held ≥ hold AND pending < max`, the same pattern as `grantTowardCap`. Price the hold per model, or allowlist the credit models.

**3. OAuth linking.** `trustedProviders: ['google','github']` turns off Better Auth's check that the provider verified the email (`link-account.mjs:139`: `!isTrustedProvider && !userInfo.emailVerified`). A Google or GitHub identity reporting `email_verified:false` for a victim's address gets linked to the victim's account; the auditor reproduced this with the repo's Google mock. Both providers already report the flag, so trusting them adds nothing. Fix: delete `trustedProviders`, keep `enabled: true`, and add a regression test.

**6. The three context-loss paths.**
- **(a) Cache hits use up resolve rounds.** `MAX_RESOLVE_ROUNDS=4`, and each nested summary level's cache *hit* uses a round. At 5 or more nested summary branches, the outer summary stays `pending` forever and the branch effectively runs `independent`.
- **(b) A keyless summary provider is never treated as unusable.** `registry.get()` returns an `unavailableProvider` wrapper, never `undefined`, so `summaryTarget` never falls back. Setting `SUMMARY_PROVIDER_ID` as the README suggests means every user without that provider's key gets no summaries, no titles, and no compaction.
- **(c) A failed compaction summary drops more than truncation would** (2k tokens kept vs ~4.4k) and records no truncation.

Core has no logging port, so none of these is visible in production.

Lower-severity bugs, all S effort:
- `ExpiryPicker`'s effect rewrites an existing share's expiry when the editor opens. It can re-activate a share that expired earlier today (`ui/expiry-picker.ts:66-80`).
- Learn's `gateForced` latches until reload (`account-store.ts:55-73`).
- A malformed backup imports successfully, then every send fails with an internal id in the error (`chat-service.ts:1756-1809`).
- Canvas reloads the whole tree list after every finished reply, six times on a 6-way fan-out, with no sequence guard (`canvas-store.ts:1144-1169`).
- Body-less destructive routes rely only on SameSite=Lax. `sameOriginOnly` is applied route by route (9 of ~30 mutating routes).

---

## 2. Scope: what the code supports that it shouldn't

This is the biggest finding and mostly a product call, so the recommendations are framed as decisions for you.

### 2.1 Monetization is about a quarter of the codebase

The money concepts:
- membership
- waiver flag and waiver code
- included membership credit (configured as 0)
- prepaid credit
- markup, OpenRouter fee pass-through and Polar fee deduction
- flat holds and the pending cap
- refunds, polled disputes, reinstatements and capped clawbacks
- admin adjustments
- simulated purchases
- the open pool ledger: DO reservations, overage breaker, expiry alarm, checkpoint
- revenue share from membership and markup, with reversals
- pool caps per user, per IP and global, plus per-minute limits
- pool access gates: Turnstile, identity hashing, account age, consent versions, suspension
- per-branch vs per-request funding with automatic fallback to the pool
- daily price sync
- the impact feed

That comes to **49 billing/pool env knobs**, ~24k lines of code and tests, and 390 KB of billing docs. "pool" appears in ~160 of 524 TS/HTML files, membership in 130, funding/own-key in ~170.

Pricing was rewritten **9 times in 7 days**: Stripe markup → credit in both modes → membership required → pool purchases → Stripe→Polar → revenue-funded pool → Free/Member → BYOK free in Learn → anyone spends credit → membership for own keys only. Each turn left code behind. The prior payment audit's decisions N1, N2, N4–N7 and N10 (`docs/polar-migration/06-payment-audit.md` §3) are still open.

### 2.2 The generate-path matrix

A reply's behaviour depends on:
- app: power, Learn, Canvas
- payer: own-key, credit, pool
- membership: not required, member, waived, lapsed, past_due
- provider: 4
- purpose: send, resolve, review, compare
- grounding: operator policy (4) × branch setting (3) × capability
- overflow mode: 2
- context mode: 4

On the client, web's entitlement rules alone form about 72 combinations, which drive 9 UI variants. 53% of `tree-store.spec.ts` tests that matrix. On the server, `AccountContext` is loose flags, about 48 combinations of which about 8 are meaningful. Who pays is spelled with **four different enums**: `BranchFunding`, `LearnPayment`, `FundingSource` and `UsageFunding`, where `credit` and `personal` are synonyms that switch at layer boundaries. This is why links touched 85 files and Compare plus the tier rebrand touched 113.

### 2.3 Feature verdicts

The auditors' recommendation, not a decision:

| Feature | Footprint | Verdict |
|---|---|---|
| Tree chat, 4 context modes, summaries, inspector, reviewer, export, BYOK, auth, TeX, prompt caching | — | **Keep.** This is the product. |
| Impact feed: taxonomy, LLM classifier on *every* new pool branch, weekly snapshot, k-anonymity, admin queue, public pages | ~9k lines incl. tests | **Cut.** Marketing analytics for a pool with no users, at the cost of a model call per branch. |
| Revenue share into the pool: daily cron, 31-day catch-up, clawback | ~260 + tests | **Cut.** An admin top-up already does this. |
| Featured conversations stub | 17 files; 404 either way | **Cut.** |
| Included membership credit, configured as 0 | Drives the hardest retry logic in `apply.ts` | **Cut.** |
| Legacy pool-purchase and Stripe-era paths, `MARKUP_PREPAID_BPS`, `tier`/`margin_bps` columns, `model_price_history` (write-only) | ~600–900 source + ~500 test lines | **Cut.** Pre-launch, never had data. |
| Power-mode Normal/Max tiers | Another route-resolution path | **Cut candidate.** Power users already pick any model. |
| Open pool as a bank (PoolBank DO, IP caps, identity holders, consent versions) | ~5.3k source + 6.1k tests | **Simplify** to a capped daily allowance, or turn off until launch. |
| Membership vs credit | — | **Pick one lever for launch.** |
| Canvas | 7.8k source; 14% of frontend | **Freeze**, or fold into `apps/web` as a lazy route (see §3). |
| Links between messages | One 85-file, 10k-line commit; not sent to the model | **Freeze** as experimental. |
| Shares: 3 scopes × snapshot/live | Off for all but allowlisted users (DMCA flag false) | **Freeze.** |
| Grounding | 4 policies × 3 branch modes × engine | **Keep; simplify** to on/off. |
| Power input limit, reply length, overflow mode | Custom 1k–2M token range | **Simplify** to presets. |
| Demos ×3 (`/demo`, `/learn/demo`, `/canvas/demo`) | 2.7k; fakes every API | **Keep the Learn demo only.** |

**Estimated removable:** ~10–15k lines from scope cuts, plus ~1.5–2k from de-duplicating the stores, plus ~4k test lines (§6).

### 2.4 Compat code for data that never existed

`docs/DECISIONS.md:498` says there are no users besides the owner. Migration 0016 says "Pre-launch". Even so, every rename gets a shim across several packages, a data migration and upgrade tests:

- The legacy `tangent` provider id: about 20 sites in 11 files, mapped three different ways (`shared/route.ts:19-66`, `api.ts:354,414,429`, `review.ts`, `compare.ts`, `chat-service.ts:1798,1925`, `learn-import.ts`, demo, `settings-store.ts:75`).
- `SIMPLE_SMART_MODEL`, `MARKUP_PREPAID_BPS` ("for one release"), and pre-tier overrides.
- Demo `sessionStorage` migrations, for state that lives only as long as one browser tab.
- `migrations-upgrade.test.ts` (690), `migrations-node-links.test.ts` (185) and `fake-provider-retired.test.ts` (114). Each stops guarding anything once your DB has migrated.
- 27 migrations, 19 of them added Oct 5–8, with undo/rename pairs (0002→0008, 0015/0016, 0019, 0021, 0025).

If production D1 holds only test data, export it, squash to one baseline migration, and delete the shims and upgrade tests. Then adopt the rule **"no backward compat before launch."** To check:
```
wrangler d1 execute DB --remote --command "SELECT COUNT(*) FROM auth_users; SELECT COUNT(*) FROM credit_grants WHERE kind='purchase'"
```

### 2.5 Config surface

- wrangler has **75 vars**, and 63 of them restate the code default. 27 of the 28 numeric knobs in `config.ts` are set to exactly their default. Only ~12 carry deployment-specific values: URLs, legal, Turnstile, Polar ids, the two feature flags, and model prices. Across the whole history, none of the ~25 pool timings or caps has ever changed. 26 vars were added and removed within 10 days.
- `config.ts:1` says it is "the one config module", but ~30 env vars bypass it. Booleans are parsed four ways: `boolVar` (trim and lowercase), `=== 'true'`, `!== 'false'`, and `.trim().toLowerCase() === 'true'`. So `AUTO_TITLE="False"` means **true**.
- Each var is documented in five places: wrangler comments, the README table (55 KB, 37% of the README), env.ts, config.ts, and `.dev.vars.example`. Four of the doc-drift errors come from that duplication.
- Root cause: the code is written for a hypothetical third-party "operator". There's one operator. **Decide: hosted product or self-hostable OSS.** If hosted, collapse the knobs into constants and keep ~12–20 vars.

### 2.6 Public pages written for every config

`pricing-page.ts` (698 lines, 70 ternaries) and `landing.ts` (624 lines, 34 ternaries) assemble each claim from the config matrix. They have no shared layout (four hand-copied document shells), ~10 KB of CSS lives in strings, and escaping is manual. `public-copy-config.test.ts` (525 lines) pins deployments that don't exist, such as "credit on another endpoint than OpenRouter" and "the pool on the Max model". 25% of all commits touched these pages. Once pricing is frozen, write the copy for the one deployment and interpolate only the numbers. Moving to `hono/jsx` with one `Layout` would give escaping by default.

---

## 3. Duplication: the frontend state engine exists three times

| Pair | Identical (method diff / LCS) |
|---|---|
| `canvas-store` ↔ `tree-store` | 62–72% of code lines |
| `lesson-store` ↔ `tree-store` | 55–58% |
| `lesson-store` ↔ `canvas-store` | ~49% |

- **What's copied.** 18 primitives exist once per app, including `upsertById`, `index`/`chain`/`path`, `loadTree` (with the `detailSeq` guard), `send`, `resumeStreaming`, the 46-line `apply` stream reducer, `finish`, `markError`, `applyNodes`/`applyBranch`, `removeBranches`, `setLive`/`patchLive`/`dropLive` and links CRUD. Web and canvas also share ~200 lines of credit, membership and key logic.
- **What it costs.** Features get built three times: links added 133, 129 and 147 lines to the three stores; "never lose a refused message" added 39, 117 and 95; "Check sources" added 71 and 86. 12 of the 38 non-merge store commits had to edit two or three stores. 10 of canvas-store's 14 commits also edited tree-store.
- **Drift is already producing bugs:**
  - bug 8 above;
  - web's single `sendingBranchId` slot vs canvas's per-lane `Set`: a second send clears branch A's busy flag;
  - Learn's `UnsentDraft` drops the send options, so a resume loses `ground`.
- **More forks.** The keys dialog (89% similar, minus the security sentence), the composer (×3), the keyboard dispatcher (×2), the passkeys dialog, the toast system (×3), the `ModelPicker` rule (canvas `model-field.ts:9` says "A copy of the power app's ModelPicker rule"), context-mode labels, and 373 duplicated CSS lines.
- **web-shared shares the wrong things.** It holds the cheap widgets but not this logic. Its barrel exports 159 names, 70 of which no app imports, and it doesn't declare `sideEffects: false`. That is why the 1.3k-line admin app ships highlight.js (880 KB `main`).

**Recommendation.** Extract a framework-light `ConversationStore` (or `StreamTracker`) into `web-shared`: detail/index, live state, the `apply` reducer, resume/finish, branch and link CRUD, and load/route sync. Each app supplies hooks: `onError`, `sendExtras`, `onBranchesRemoved`, `askForKey`. Add an `AccountStore`/`Entitlements` that exposes one `routeState(route)` enum. Learn already did this split (`account-store.ts`, `payment-store.ts`), so follow its shape. Start from canvas's `Set`-based sending. The first step, `apply` + `resumeStreaming` + live state (~120 lines), changes no behaviour. Then move `ApiKeys`, `ModelPicker`, the composer core, toasts and the keyboard table into web-shared. The alternative is to **freeze canvas** and stop porting features to it, or make it a lazy route inside `apps/web` so it uses `TreeStore` directly. The current middle ground pays for the duplication and still drifts.

Other cross-boundary copies:
- The demo backend's billing constants and float charge formula (it charges 1 µ$ where prod charges 0).
- `REMEMBER_COOKIE`.
- `MEMBERSHIP_KIND` (×2).
- `isOpenRouter`, a verbatim copy of `isOpenRouterBaseUrl`.
- `escapeHtml` (×2).
- The title limit `200` as a literal 27 times.
- Four markdown-to-plain-text functions and ~12 ellipsis clippers. Some aren't surrogate-safe; `clipAnchorQuote` can split an emoji.
- Three hand-written `LlmProvider` decorators. A new optional member added to the interface gets silently dropped by whichever wrapper forgets it.

---

## 4. Sprawl: god objects and their natural seams

| Unit | Size | What it does | Split |
|---|---|---|---|
| `packages/core/src/services/chat-service.ts` | 2,060 lines; 30 public + 24 private methods; 16 dep fields, 9 of them product-mode flags; 28 commits | 16 jobs: ownership, tree/branch/link CRUD, settings, route resolution, context loading, budgets, the summary loop, send, streaming with search retry, grounding, titles, review, compare, backup import/export with Learn adaptation. The reply pipeline is copy-pasted 3–4×, and a 12-field `ChatNode` literal is built 5× | `services/ownership.ts` (the 4 `requireOwned*`), `services/routing.ts` (a `RouteResolver` taking `GenerationProfile = {kind:'power'\|'learn'\|'pool',…}` in place of the 9 flags), `tree-service.ts`, `backup.ts`, `generation/{context-resolver,reply,send,review,compare,titler}.ts` with one `prepareReply()`. Keep a thin facade so the DO and routes barely change. Order: ownership/routing → backup → compare/review. |
| `apps/web/.../state/tree-store.ts` | 1,311 lines; 22 signals, 25 computeds, 47 public methods; injected in 30 of ~38 files | 14 jobs, including a global API-error policy (`fail`) and 11 different `UiStore` writes | `AccountStore` (shared), `TreeListStore`, `OpenTreeStore`, `SelectionService`, `GenerationStore` (shared engine), `ApiErrorPolicy`. Move UI side effects out. |
| `apps/canvas/.../canvas-store.ts` | 1,305 lines; 40 public methods, 30 `UiStore` writes | Same as above, plus lineage and fan-out (~220 canvas-specific lines) | Shrinks to ~300 lines (lineage + fanOut) after §3 |
| `apps/simple/.../lesson-store.ts` | 1,106 lines; 34 public methods; opens 4 dialogs and raises 15 toasts | 10 jobs | Shared engine + `LessonLibrary` + `LessonNav` + `SendRecovery` + a ~200-line facade |
| Learn "who pays" | `payment-store.ts` (55% comments) + `account-store.ts` + the server's `gate.ts:71-87` | A 7-rule client resolver that *predicts* the server's silent credit→pool switch. Facts are mirrored between two stores to dodge a DI cycle. Four credit predicates, none shared. Three "switch payment" paths that behave differently. 25 commits in 6 days | One `LearnFunding` service with one owner per fact and one `switchTo()`. Put the default rule in `@tangent/shared`, also called by `gate.ts`. **Have the server report the funding it actually used** on the `start` event. |
| `apps/web/.../chat/message-item.ts` | 548 lines; 250-line inline template, 27 computeds, 17 `@if` | ~8 features | `MessageActions`, `MessageStatus`, `TangentNav`, `ForkList`, `ReviewChip` |
| `apps/worker/src/routes/api.ts` | 33 routes in one 490-line function; the most-churned worker file | 11 responsibilities. The SSE pump is copy-pasted. Ownership is checked twice per request (extra D1 round trips) | `routes/{trees,branches,generation,links,shares,export}.ts`, one `sseFromAsyncIterable` helper, a `do/tree-session-client.ts` |
| `apps/worker/src/services.ts` | 537 lines; imported by 18 modules | A composition root mixed with env availability predicates. The predicates are what close the worker's import cycles | `availability.ts` (pure, leaf) + `registries.ts` |
| `billing/meter.ts` (662), `payments/apply.ts` (576), `pool/pool-bank.ts` (754) | — | meter = stream wrapper + personal + pool + call log; apply = 17 imports, legacy branches; pool-bank = SQL helpers + reserve + checkpoint + rate window + test seams in production code | Seams listed in the money auditor's report: `meter/{stream,personal,call-log}`, `pool/{meter,day-usage,checkpoint,rate-window}` |
| Dialog/overlay state, in all three apps | 11 (web), 11 (canvas) and 8 (Learn) independent booleans | Hand-ordered `closeTop` chains. `anyDialogOpen` is incomplete, so shortcuts fire behind modals | One `dialog` discriminated-union signal (or a stack) per app |

---

## 5. Maintainability

- **The API contract is maintained by hand in four places:**
  - the Hono routes (57);
  - `ApiClient` (60 methods with string paths; `JSON.parse(text) as T`, so nothing ties `GET /trees` to `TreeSummary[]`);
  - the demo's 32–43 regex matchers;
  - a 135-line prose comment in `shared/api.ts`, which is already stale (`tangent` vs `openrouter`).

  Renaming a route compiles and breaks only at runtime. Fix: a typed route table in `@tangent/shared` (or Hono `hc<AppType>`) consumed by the client, plus an exhaustive `Record<RouteName, Handler|'unsupported'>` in the demo.
- **The demo backend is a second backend.** Reusing the real `ChatService` was the right call. But `demo/backend.ts` (1,018 lines, 23 commits) re-implements the router, the DO's run fan-out, candidate hold/commit and the billing math. It also hand-copies the ChatService config and misses `groundingAllowance`/`creditProviders`. **25 of the 38 e2e tests run against it**, so Learn's real send, Compare and links flows are never e2e-tested through the Worker, the DO and the billing gate. Fix:
  - give the e2e Worker a fake built-in provider;
  - move `chargeMicros` and the defaults into `shared`;
  - extract a runtime-neutral `GenerationHub` used by both the DO and the demo.
- **Two repository implementations with no contract test.** Memory repos (used by 390 core tests *and* by the production demo, under the name `@tangent/core/testing`) and D1 repos already differ: memory `listTrees` has no `id` tie-break. Fix: one `describe.each([memory, d1])` suite, and rename the subpath to `@tangent/core/memory`.
- **Money tables are reached only through raw SQL.** About 95 raw `prepare()` calls across 26 files, with 50 unchecked `.first<T>()` casts. `credit_grants` and `usage_events` are Drizzle tables, but a column rename produces no type error in the ledger or meter. At minimum, type the rows as `typeof usageEvents.$inferSelect`. `admin.ts:68-80` re-implements the balance formula.
- **11 runtime import cycles in the worker:** `services ↔ billing/gate ↔ auth/account ↔ membership ↔ payments/apply`, `reconcile ↔ pool/expiry`, `model-prices ↔ model-windows ↔ params`. None crashes today. Add `madge --circular` (type-only imports skipped) to `pnpm lint`.
- **Provider contract shaped by OpenRouter.** `engine`, `maxResults`, `effort`, `providerOrder` and `upstream` are honoured only by openai-compatible; Anthropic ignores `reasoning` and `mode:'required'`. `kind === 'fake'` changes *production* behaviour (no auto-title), and the demo declares `kind:'openai-compatible'` to dodge it. Fix: move the OpenRouter knobs into provider config, and use capability flags instead of kind checks.
- **Error kinds are stored as English sentences.** "Continue" and stopped-reply detection compare `node.error` against copy strings, so rewording a message breaks stored nodes. Fix: add an `errorKind` column.
- **Observability:**
  - core has six bare `catch {}` and no logger port;
  - the worker has 81 `console.*` calls, about half of them free text;
  - IDs are generated two ways.

  Add an optional `log(event, fields)` dependency to core and one `logEvent` helper in the worker.
- **Comments narrate history and plans:** 91 references to plan sections (`PLAN §2.4`, `§S8b`, `03 §2.3`), "it was 'Smart'", "for one release", and orphaned docblocks in at least 6 places. Keep the *why* and delete the history.
- **Naming drift.** `simple` means Learn, but the `SIMPLE_*` env prefix configures credit for power too. `SIMPLE_MAX_MODEL` is the Max tier, while `SIMPLE_MAX_INPUT_TOKENS` is a maximum. Test and demo model ids are `simple`/`smart` for Normal/Max ("smart" appears 160 times). "Community pool" was renamed "open pool", but not everywhere. Agents pattern-match on names. Do one rename pass while you're pre-launch.

---

## 6. Tests, CI and tooling

| Check | Result | Time |
|---|---|---|
| `pnpm typecheck` | pass | 1m14s |
| `pnpm lint` | pass | 13s |
| `pnpm test` | pass locally (2,111 tests) | 7m12s; worker setup is 969s vs 100s of test time, cumulative |
| `pnpm coverage` | core 96.6%, providers 95.1%, render 98.3%, worker 95.5%, shared 79.6%, web-shared 68.8%, simple 50.2%, web 34.7%, canvas 31.0%, admin 13.4% (lines) | 7m37s |
| `pnpm build` | pass; budgets too loose to catch anything | 50s |
| `pnpm e2e` | 38/38 pass | 2m35s |
| `prettier --check .` | fails on 379 files (16 tracked TS); not in CI | — |
| CI on master `3a71bdc` | **red**: timeout flake | — |

**Strong:**
- Real integration tests in workerd, with every outbound call mocked in one place.
- Money paths tested for idempotency, refunds and disputes.
- PoolBank concurrency tests.
- A cross-user IDOR matrix (21 routes × 3 modes).
- Invariant-based core tests.
- No `.only`/`.skip`.
- Role-based e2e locators.

**Weak:**
- **No rendered component tests.** 100 components, zero TestBed. Instead, **163 assertions string-match template source** through Angular's private `__annotations__`, with a `templateOf` helper copy-pasted into 18–21 files (e.g. `toContain('(click)="remove(t)"')`). They break on reformatting and pass on broken bindings. Several 0%-coverage files: web `chat-page.ts` and `message-item.ts`, canvas `canvas-page.ts`. Fix: a happy-dom/jsdom vitest project with TestBed for the ~15 components that have logic. Keep `FORBIDDEN_POOL_COPY` as a lint.
- **Coverage hid both money bugs.** No test exercises concurrent personal-credit sends. The test env prices the pool model with an 8k context, so the infeasible ceiling never shows. Add one "as shipped" test that loads `wrangler.jsonc` vars, and concurrency tests for every money guard.
- **Copy-pinning tests.** ~1.7k lines assert whole marketing sentences and HTML (`'<h3>Free</h3>\n<p class="price">$0</p>'`). `pool-pages.test.ts` changed in 17 commits. Production model ids appear 58 times in tests although constants exist. Keep the invariants (CSP, script-free pages, note numbering, forbidden phrases) and drop the sentences.
- **Duplicated helpers:**
  - 13 worker files have their own SSE parser;
  - 7 have their own `call()`;
  - 24 define `BASE`;
  - a full `Branch` literal is hand-built in 22 files;
  - store-spec suites are duplicated (canvas spec: 313 of 766 lines identical to web's).
- **The IDOR matrix is hand-written** and misses 4 id-taking routes. Generate it from Hono's `app.routes` and fail when a route is neither covered nor explicitly exempt.
- **Worker suite speed:** ~90% of its time is per-file `cloudflare:test` initialisation (24s with it vs 1.7s without, for two pure files). ~15 files never touch D1. Split them into a plain Node vitest project.
- **CI:**
  - no `testTimeout`, so CI flakes;
  - `pnpm -r` bails, so a worker failure hides all frontend results;
  - Prettier isn't enforced, and there's no `.prettierignore`, so `pnpm format` would rewrite vendored skills and generated files;
  - lint isn't type-aware (a run with `no-floating-promises` found 1 issue);
  - no knip/madge;
  - no Dependabot;
  - the vitest-pool-workers runtime (workerd 1.20260815) differs from dev/deploy (1.20260926).

About 4k test lines (~8%) can be deleted or consolidated without losing protection. The rest earns its keep.

---

## 7. Process: guardrails for an AI-written codebase

- **PR size and review.** Before merge:
  - #20 was 19.5k lines;
  - #48 was 15.8k;
  - #7 was 15.3k, merged **2 minutes** after its last commit;
  - #22 was 13.7k, merged in **under 1 minute**.

  The p75 PR is 3k lines. 162 of the 177 non-merge commits are by Claude; yours are config flips. In practice the code is reviewed only by the agent that wrote it, against tests the same agent wrote. Example: an "audit fixes" commit rewrote README:262 to say the fee "ships false" one day after you set it to true.
- **No CLAUDE.md.** The project's real rules exist only as habit: update README and DECISIONS on every change (63% of commits do), the provider-neutral lint, migrations before deploy, no donation wording. `.agents/skills` holds 16 vendored Cloudflare skills (2.3 MB). About 9 are irrelevant: nextjs, sandbox ×3, cloudflare-one ×2, k2, basin, agents-sdk.
- **Docs:**
  - README.md is 150 KB, with 15 lines over 1,000 characters. It is a spec, runbook, test catalogue and changelog all at once, and has been edited by 47% of commits.
  - DECISIONS.md is 186 KB, append-only, with 15+ "Superseded" banners. Finding the current membership rule means reconciling four sections.
  - `docs/polar-migration/` (296 KB) and `docs/pool/{PLAN,SPEC}.md` describe completed work. Code cites these docs ~90 times, which pins them in place.
  - **12 of the 28 claims checked were wrong.** Paths and endpoints were accurate; defaults and status claims weren't.

---

## 8. What's done well — keep it

- `assembleContext` is pure, synchronous and deterministic, with content-addressed summary keys and 128 stable tests.
- Package layering: no wrong-direction imports, `shared` is a leaf, and core depends only on provider *types*.
- zod at every HTTP boundary, reused by the demo. Strict TS with zero `any`, `@ts-ignore` or `eslint-disable`.
- The ledger primitives:
  - the balance is a derived sum;
  - grants use `ON CONFLICT(provider_ref) DO NOTHING`;
  - settles are conditional on `status='pending'`;
  - `grantTowardCap` is race-safe;
  - money math is exact BigInt that rounds in the operator's favour.
- PoolBank's explicit lock, which correctly reasons that DO input gates don't hold across D1 I/O.
- `guardStream` (never throws, exactly one terminal event), an SSE parser that handles split CRLF and UTF-8, and AES-GCM BYOK sealing with AAD in a `__Host-` HttpOnly cookie.
- Centralised ownership checks plus the IDOR matrix. Admin answers 404 to non-admins.
- Frontend: OnPush and zoneless throughout, effects use `untracked` correctly, no `bypassSecurityTrust*`, and live stream text kept out of `detail`.
- The store specs test through public APIs, and so do the D1 repository tests.

---

## 9. Recommended plan

**Phase 0 — this week (each item S):**
1. Bugs 1–4 in §1: pool ceiling, credit race, OAuth `trustedProviders`, deploy gating plus migrations.
2. Bugs 5–16.
3. Set the worker `testTimeout` to 30s and add `--no-bail` so master goes green.

**Phase 1 — guardrails (S):**
1. Write a ~60-line `CLAUDE.md` with the commands, the module map and these hard rules:
   - PRs ≤ ~1.5k lines of non-generated diff;
   - money and schema changes in their own small PR;
   - no new env var without a deployment-specific value;
   - no compat shims before launch;
   - no new feature in canvas or links (scope freeze list);
   - which single doc to update.
2. Deploy from GitHub Actions after CI passes, running `wrangler d1 migrations apply --remote` before `wrangler deploy`.
3. Tooling: `prettier --check` with a `.prettierignore`, type-aware lint (`no-floating-promises`, `no-misused-promises`, `await-thenable`), madge and knip in lint, real bundle budgets, and `sideEffects: false` on web-shared.
4. Prune the irrelevant vendored skills.

**Phase 2 — your product decisions.** These gate Phase 3:
1. One monetization lever at launch: credit, membership, or both?
2. Pool: keep PoolBank, collapse to a capped daily allowance, or turn off until launch?
3. Cut the impact feed and the revenue share?
4. Canvas: freeze, fold into `apps/web`, or invest in the shared store?
5. Links: freeze as experimental?
6. Hosted product or self-hostable OSS? This decides the config surface.
7. Is production D1 only test data? If yes, squash migrations and drop the shims.

**Phase 3 — deletion pass (M), following those answers:**
- compat shims and legacy money paths;
- the featured stub and `model_price_history`;
- never-changed knobs turned into constants, with every env read going through `config.ts` and one boolean parser;
- copy for the one deployment;
- README cut to ≤150 lines, with operating and config docs split out;
- DECISIONS rewritten as current rules;
- `polar-migration/` and `pool/` moved to `docs/archive/`;
- copy-pinning and template-source tests deleted.

**Phase 4 — structure (L, in M-sized PRs):**
1. The shared conversation engine and account store in web-shared, starting with `apply`/`resumeStreaming`/live.
2. Split `ChatService` behind a facade, starting with ownership and routing.
3. Split `api.ts` and `services.ts`, which also breaks the import cycles.
4. A typed route table.
5. The repository contract suite.
6. Rendered component tests for the ~15 components that have logic.
7. One `Payer` type end to end, and `AccountContext` as a discriminated union.

## Limitations

- The clone is shallow; history before 2026-09-29 is cut off.
- Production D1, the Cloudflare account and Polar were not queried. Whether Workers Builds is still connected, and whether `privacy@` exists, are inferred from repo evidence only.
- The reproduction tests were throwaway and are not committed. Each bug above names where to add the permanent regression test.
