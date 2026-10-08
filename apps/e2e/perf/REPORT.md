# Power mode with a heavy tree: performance report

Scope: the power app (`apps/web`) driven through the in-browser demo at `/demo`, plus Node microbenchmarks of `packages/core` (tree and context code) and `packages/render` (Markdown). No app code was changed.

## TL;DR

At the requested size (5 levels × 2 branches, 63 branches, 208 messages) the app is fast. Every interaction finishes in under 120 ms, no heap or DOM grows over repeated branch switches, and context assembly takes 0.02 ms. There is no O(n²) in the tree or context code.

Three things do scale badly, and they are worth fixing before trees or replies get larger:

1. **Streaming re-renders the whole reply on every delta, so cost is O(n²) per reply.** Per-chunk main-thread time grows linearly with reply length: about 4 ms script at 1 k characters, 24 ms script plus 16 ms layout at 32 k characters. At around 6–8 k characters it no longer fits a 60 fps frame. Markdown alone for a 32 k-character reply costs 27.8 s over the stream.
2. **Every stream delta reaches every message and every outline row.** The cost per chunk grows with the size of the tree: 2.9 ms per chunk with 63 branches, 4.7 ms with 255 branches, for the same reply.
3. **The outline is neither virtualized nor structurally shared.** Expanding it costs 42 ms with 69 rows and 140 ms with 261 rows (long tasks up to 73 ms). Initial load script time grows with the branch count.

The demo only has one more problem: it writes the whole session to `sessionStorage` on every change, which costs 40–50 ms per change at 255 branches.

---

## 1. Setup

|            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App build  | **Production** (`ng build --configuration production --source-map`, output `apps/web/dist/perf-prod`) for all timings. A **development** build (`dist/perf-dev`) was used for readable profile names and for the synthetic long-stream test, which needs Angular's `ng` debug global.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Serving    | `apps/e2e/perf/serve-static.mjs`: a static server with SPA fallback. `/demo` runs entirely in the page, so no Worker is needed. No CSP header is sent; the production CSP (`require-trusted-types-for`) would forbid the harness's in-page `new Function`.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Browser    | Playwright 1.56.1 with its pinned Chromium 1194 (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`), headless, 1440×900 (800 px wide for the drawer test). Runs in a container, so read absolute numbers as relative.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Seeding    | `apps/e2e/perf/seed.ts` runs the demo's own `DemoBackend` (the real `ChatService` over in-memory repositories, with the lorem provider and no pauses) in Node. It drives `POST /api/trees`, `/api/branches` and `/messages`, then takes the backend's sessionStorage mirror (`tangent.power-demo.v1`), which `addInitScript` injects before the app loads. The demo restores it as-is. Grounding is set to `off` on the trunk and inherited by every branch: with `auto`, the lorem provider fakes a 400 ms web search on most replies, which swamped time-to-first-token.                                                                                                                              |
| Tree shape | Trunk of 3 exchanges. From its last reply, 2 branches, each with 1–2 exchanges and 2 branches from its last reply, and so on to depth D. The _spine_ (always the first child) is all `path`, and its leaf has 10 exchanges (the long branch). Off the spine, about 60% `path`, 20% `summary`, 10% `message`, 10% `independent`. Replies come from the real demo generator (txtgen), about 500–1000 characters each.                                                                                                                                                                                                                                                                                     |
| Sizes run  | **d5×2**: 63 branches, 208 messages, 240 KB session, spine-leaf path of 38 messages. **d7×2**: 255 branches, 784 messages, 894 KB session, spine-leaf path of 44 messages.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Method     | Each interaction runs `REPEAT=3` times and the median is reported. **wall** is the in-page clock from the action (an in-page `click()` or `keydown`) to the first frame where the DOM condition holds. **script / layout / style** are CDP `Performance.getMetrics` deltas. **Long tasks** come from a `PerformanceObserver` (over 50 ms). A CPU profile (`Profiler`, 200 µs sampling) is taken for each interaction, and its self time is mapped through the bundles' source maps to repository files. Harness baseline (a no-op interaction): 4 ms wall, 0.1 ms script. CDP `TaskDuration` and the profile's `(program)` bucket include harness overhead (CDP and rAF polling), so they are not used. |
| Caveat     | In `/demo` the backend shares the main thread with the UI. Its costs (`ChatService`, the sessionStorage mirror) appear in the measurements and are reported separately as _demo-backend_. In production that work happens on the Worker.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

---

## 2. Measured interactions (production build, medians)

### UI interactions

| Interaction                                             | d5×2: shallow (D1)                                      | d5×2: deep (D5 spine leaf)                                           | d7×2: shallow (D1)                                                  | d7×2: deep (D7 spine leaf)                                        |
| ------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Load the branch URL** (to all messages rendered)      | 232 ms · script 82 · layout 11 · 0 long tasks (path 10) | 269 ms · script 132 · layout 29 · 1 long task of 115 ms (path 38)    | 228 ms · script 141 · layout 25                                     | 295 ms · script 214 · layout 52 · 1 long task of 108 ms (path 44) |
| **Switch branch from the outline** (from trunk)         | 34 ms · script 11.7 · layout 5.3 · style 3.2            | 89 ms · script 47.7 · layout 18.3 · style 8.7 · 1 long task of 83 ms | 38 ms · script 11.7                                                 | 111 ms · script 53.5 · layout 22.5 · 2 long tasks (max 52)        |
| Switch deep leaf → sibling leaf                         | —                                                       | 27 ms · script 11.1                                                  | —                                                                   | 35 ms · script 12.9                                               |
| Switch → deep leaf, inspector open                      | —                                                       | 91 ms · script 37.6 · layout 16.3 · 1 long task of 59 ms             | —                                                                   | 106 ms · script 39 · layout 21.4                                  |
| **Open the Context Inspector**                          | 33 ms · script 4.6 (11 segments)                        | 48 ms · script 8.5 · layout 10.3 (39 segments)                       | 26 ms · script 5.2                                                  | 69 ms · script 10.5 · layout 12.9 (45 segments)                   |
| Open "Branch from here"                                 | 12 ms · script 2.9                                      | 12 ms · script 3.3                                                   | 19 ms                                                               | 22 ms                                                             |
| **Create the branch** (submit → new empty branch open)  | 47 ms · script 6.9 (demo save ≈ 11 ms)                  | 59 ms · script 7.6 (demo save ≈ 11 ms)                               | 100 ms (demo save ≈ 46 ms)                                          | 115 ms (demo save ≈ 43 ms)                                        |
| **Outline: collapse all / expand all**                  | 5.8 / 41.6 ms, script 3.3 / 20.2 (69 rows)              |                                                                      | 15.6 / 139.8 ms, script 12.3 / 74, 2 long tasks (max 73) (261 rows) |                                                                   |
| Drawer open (800 px window)                             | 11 ms                                                   |                                                                      | 23 ms                                                               |                                                                   |
| **Scroll the long branch** (4 passes, 120 px per frame) |                                                         | frames: mean 16.7 · p95 17.4 · max 33 · 0 over 50 ms (14 259 px)     |                                                                     | mean 16.7 · p95 17.6 · max 33 · 0 over 50 ms (16 628 px)          |
| Page DOM (elements)                                     | ~1.9 k                                                  | ~3.1 k                                                               | ~5.7 k                                                              | ~7.3 k                                                            |

### Streaming a reply (real demo stream; the lorem provider sends one word per delta every 20–40 ms)

|                                                  | d5×2 shallow          | d5×2 deep            | d7×2 shallow                  | d7×2 deep            |
| ------------------------------------------------ | --------------------- | -------------------- | ----------------------------- | -------------------- |
| Time to first token (send → first text)          | 49 ms                 | 57 ms                | 90 ms                         | 85 ms                |
| ↳ send → `start` event (messages appear)         | 31 ms                 | 30 ms                | 64 ms                         | 57 ms                |
| Reply length / chunks                            | 705 chars / 125       | 687 / 117            | 711 / 129                     | 816 / 147            |
| **Script per chunk** (all runs)                  | **2.2 ms** (2.2–2.7)  | **2.9 ms** (2.7–3.1) | **4.3 ms** (3.3–4.3)          | **4.7 ms** (4.7–4.8) |
| Layout / style per chunk                         | 0.7 / 0.5 ms          | 1.0 / 0.6            | 0.8 / 0.6                     | 0.9 / 0.6            |
| Long tasks during the stream                     | 0 (runs: 0–1, max 53) | 0                    | 1 (87–91 ms, at start or end) | 0                    |
| Frames over 50 ms / frame p95                    | 0 / 18.9 ms           | 0 / 19.9             | 2 / 22.0                      | 2 / 22.3             |
| Other message bodies mutated / outline mutations | 1 / 4                 | 1 / 4                | 1 / 4                         | 1 / 4                |

The last row comes from a MutationObserver. Per stream it saw one mutation in another message body (the user's new message appearing) and four outline mutations (the "generating" dot appearing and disappearing). So there is no whole-list or whole-tree _DOM_ re-render per chunk. The per-chunk cost that does grow with tree size is change-detection traversal and signal notification (issue 2).

The development build gives 2.7 (shallow) and 3.3 (deep) ms of script per chunk on the same streams. Dev mode adds roughly 15–25% here, which calibrates the dev-only synthetic numbers below.

### Synthetic long reply, development build

This test streams a long Markdown reply (headings, bold, links, lists, a code block) into the deep branch's last message through `TreeStore.setLive`/`patchLive`, 4 characters per chunk (about one token), one chunk per frame. It measures 40 chunks once the reply has reached each length.

| Reply length | script / chunk | layout / chunk | style / chunk | frame time / chunk | markdown-it | Angular (CD + sanitizer + DOM) |
| ------------ | -------------- | -------------- | ------------- | ------------------ | ----------- | ------------------------------ |
| 1 000 chars  | 4.3 ms         | 1.4 ms         | 0.7 ms        | 16.6 ms            | 0.8 ms      | 2.4 ms                         |
| 4 000        | 5.3            | 3.0            | 0.9           | 16.7               | 1.1         | 2.7                            |
| 8 000        | 8.6            | 5.3            | 1.4           | **24.6**           | 1.7         | 4.3                            |
| 16 000       | 13.5           | 8.5            | 2.2           | **34.6**           | 2.8         | 7.0                            |
| 32 000       | 24.0           | 16.2           | 4.2           | **58.3**           | 5.4         | 11.4                           |

Top self time at 16 k characters, over 40 chunks:

| Self time | Function           | Where                                        |
| --------- | ------------------ | -------------------------------------------- |
| 95 ms     | `setProperty`      | Angular DOM renderer (the `innerHTML` write) |
| 75 ms     | `parseFromString`  | the sanitizer's inert document               |
| 38 ms     | `encodeEntities`   | Angular sanitizer                            |
| 30 ms     | `_defineProperty`  | markdown-it tokens                           |
| 28 ms     | `sanitizeChildren` | Angular sanitizer                            |
| 17 ms     | `exec`             | highlight.js                                 |
| 17 ms     | `_sanitizeHtml`    | Angular sanitizer                            |
| 6.6 ms    | `scrollTo`         | `chat-page.ts:264`                           |

### Memory: repeated branch switches (production build)

The test cycles through 10 branches of mixed depth and mode via the outline. It warms up with 10 switches, then forces GC twice before each reading.

|                          | Heap after GC           | DOM nodes                       | JS listeners | Mean switch time, first 10 → last 10                               |
| ------------------------ | ----------------------- | ------------------------------- | ------------ | ------------------------------------------------------------------ |
| d5×2, after 50 switches  | 11.07 → 11.17 MB (+0.1) | 4217 → 3230 (back on the trunk) | 664 → 466    | 43.7 → 41.2 ms                                                     |
| d5×2, after 50 more      | +0.1 MB                 | 3230 (unchanged)                | 466          | —                                                                  |
| d7×2, after 100 switches | 13.55 → 13.85 MB (+0.3) | 11 046 → 9345                   | 1653 → 1305  | blocks of 10: 75, 73, 73, 80, 65, 65, 72, 64, 69, 79 ms (no trend) |
| d7×2, after 100 more     | +0.2 MB                 | 9345 (unchanged)                | 1305         | —                                                                  |

**No leak.** DOM nodes and listeners return to the same baseline, switch time does not drift, and the small heap rise is consistent with the bounded Markdown cache filling up (300 entries).

---

## 3. Microbenchmarks

### `packages/core`: `pnpm --filter @tangent/core bench`

This builds the same synthetic tree shape in memory, with about 900-character replies. Each cell is the mean time per operation, with the ratio to d5×2 in brackets.

|                                                                                    | d5×2         | d6×2         | d7×2         | d5×3         | d7×3                         |
| ---------------------------------------------------------------------------------- | ------------ | ------------ | ------------ | ------------ | ---------------------------- |
| branches / messages                                                                | 63 / 208     | 127 / 402    | 255 / 784    | 364 / 1112   | 3280 / 9860                  |
| messages ×                                                                         | 1            | 1.9          | 3.8          | 5.3          | 47.4                         |
| `indexTree`                                                                        | 0.096 ms     | 0.157 (×1.6) | 0.323 (×3.4) | 0.485 (×5.1) | 6.82 (×71)                   |
| `buildOutline` + `flattenOutline`                                                  | 0.015        | 0.027 (×1.7) | 0.060 (×3.9) | 0.096 (×6.3) | 1.36 (×90)                   |
| Store recompute per `detail` update (`upsertById` + index + outline + link counts) | 0.097        | 0.20 (×2.1)  | 0.42 (×4.3)  | 0.61 (×6.3)  | 8.99 (×93)                   |
| `branchPath(spine leaf)`                                                           | 0.0021       | ×1.1         | ×1.2         | ×0.9         | ×1.2                         |
| `depthOf` (`branchChain`) for each path message                                    | 0.016        | ×1.1         | ×1.4         | ×0.9         | ×1.4                         |
| `descendantBranches(trunk)` (subtree walk)                                         | 0.006        | ×1.9         | ×5.5         | ×7.3         | 0.60 ms (×97)                |
| **`assembleContext`, deep `path` leaf** (chain + path, as the server calls it)     | **0.020 ms** | ×1.0         | ×1.1         | ×0.9         | ×1.0                         |
| `assembleContext`, deep leaf, given _all_ branches and nodes                       | 0.054        | ×1.8         | ×3.8         | ×5.7         | 3.26 ms (×60)                |
| **`assembleContext` for every leaf** (32 → 2187 leaves)                            | 2.19 ms      | ×2.7         | ×5.3         | ×8.3         | 179 ms (×82, for ×68 leaves) |
| `assembleContext`, deepest `summary` branch (sha256 of the transcript)             | 0.170        | ×0.9         | ×1.0         | ×0.8         | ×1.0                         |

`sha256Hex` (pure JS): 0.13 ms for 10 KB, 1.07 ms for 100 KB, 10 ms for 1 MB.

What this shows:

- Everything is linear in its input, or n log n for the sorts in `indexTree`. The ×1.5 extra at d7×3 is sorting and GC.
- Context assembly for a leaf depends only on its chain and path, not on the size of the tree.
- **Nothing is O(n²).**
- The Node cost of the client store's whole recompute is still under 1 ms at 255 branches. So the UI costs in issues 2–3 come from Angular views, not from this code.

### `packages/render`: `pnpm --filter @tangent/render bench`

This times Markdown rendering for a whole stream, with 4-character deltas.

| Reply length | Deltas | One render | **Whole stream, full re-render each delta (today)** | Whole stream, block-incremental render |
| ------------ | ------ | ---------- | --------------------------------------------------- | -------------------------------------- |
| 1 000 chars  | 250    | 0.38 ms    | 93 ms                                               | 24 ms                                  |
| 2 000        | 500    | 0.74       | 175                                                 | 27                                     |
| 4 000        | 1000   | 0.96       | 524                                                 | 44                                     |
| 8 000        | 2000   | 1.65       | 1 880                                               | 101                                    |
| 16 000       | 4000   | 4.03       | 6 848                                               | 307                                    |
| 32 000       | 8000   | 6.04       | **27 783**                                          | 715                                    |

Each doubling of the length roughly quadruples the total (≈ N²/2c). The block-incremental variant renders finished blocks, split at blank lines outside code fences, once each, and only the growing tail block per delta. That cuts total Markdown time by 4× at 1 k characters and 39× at 32 k.

---

## 4. Issues, ranked

### Confirmed (backed by measurements)

#### 1. Streaming re-renders, re-sanitizes and re-lays-out the whole reply on every delta, so a reply costs O(n²)

- **Where**
  - `apps/web/src/app/chat/message-item.ts:296-303`: `content` → `split` → `html = md.render(split().body, !streaming())`. Every delta re-runs `splitTangents` and markdown-it over the whole reply.
  - `packages/web-shared/src/core/markdown.service.ts:14-24`: no caching while streaming, which is correct, but that means a full render each time.
  - `message-item.ts:118-119`: `[innerHTML]="html()"` replaces the whole body subtree. Angular's sanitizer parses the whole HTML string again on each delta (`parseFromString`, `sanitizeChildren`, `encodeEntities`).
  - `packages/web-shared/src/ui/math.ts:58-63`: `afterRenderEffect` → `typesetMath` → `querySelectorAll` on every delta.
  - Code blocks are re-highlighted on every delta (highlight.js shows up in the profile).
- **Mechanism.** Per-delta work is proportional to the current reply length, so the total for one reply is proportional to length² divided by the delta size. Replacing `innerHTML` also forces a full layout of the message each time, and it drops any text selection inside it.
- **Evidence**
  - Synthetic stream (dev build), per chunk: script 4.3 → 24 ms and layout 1.4 → 16.2 ms from 1 k to 32 k characters. Frame time is 16.6 ms up to 4 k characters, then 24.6 ms at 8 k, 34.6 ms at 16 k and 58 ms at 32 k.
  - At 16 k characters the hot path per chunk is: sanitizer ≈ 4 ms (`parseFromString`, `encodeEntities`, `sanitizeChildren`, `_sanitizeHtml`), the `innerHTML` write ≈ 2.4 ms, markdown-it ≈ 2.8 ms, highlight.js ≈ 1.1 ms, plus 8.5 ms of layout.
  - Node bench, Markdown alone: 93 ms for a 1 k-character stream, 6.8 s for 16 k, 27.8 s for 32 k.
  - The demo's replies (about 700 characters) stay at 2.2–2.9 ms of script per chunk in production. That is why `/demo` feels fine; real LLM answers of 4–16 k characters (code, long explanations) do not.
- **Suggested fix**
  - Render while streaming **per block**: split the body at block boundaries (blank lines outside fences) and keep finished blocks' sanitized HTML (keyed by their source). Render the blocks with `@for` tracked by index, so only the last block's `innerHTML` changes. Layout and sanitizing are then limited to that tail. The bench shows 4–39× less Markdown work.
  - Also coalesce deltas so `html` is recomputed at most once per frame (or every 50–100 ms) while streaming.
  - Typeset math and highlight code only in finished blocks.
  - Keep the full render for the final `done` node, which gets cached.

#### 2. Every delta notifies every message and every outline row, so per-chunk cost grows with the size of the tree

- **Where**
  - `apps/web/src/app/state/tree-store.ts:1090-1098` and `1226-1233`: each `delta` builds a new `Map` (`setLive`/`patchLive`) inside the single `live` signal.
  - Consumers of that signal:
    - `message-item.ts:289`: `live = computed(() => store.live().get(node().id))`, once per rendered message.
    - `apps/web/src/app/sidebar/outline-item.ts:147-151`: `streaming = computed(...)`, which iterates the whole `live` map, once per outline row.
    - The chat page's pin-to-bottom effect (`chat-page.ts:188-193`).
- **Mechanism.** Angular signals push dirtiness to all consumers eagerly; the equality check only happens on pull. So each delta marks every `MessageItem` view and every `OutlineItem` view for traversal. Change detection then walks them all and polls their computeds, even though nothing in them changes. The per-chunk cost is O(path messages + branches).
- **Evidence** (production, same kind of stream, about 700–800 characters):

  |                                                          | 63 branches | 255 branches |
  | -------------------------------------------------------- | ----------- | ------------ |
  | Deep branch, script per chunk                            | 2.7–3.1 ms  | 4.7–4.8 ms   |
  | Shallow branch, script per chunk                         | 2.2–2.7 ms  | 3.3–4.3 ms   |
  | `detectChangesInView` self time per stream               | 37–41 ms    | 124–128 ms   |
  | `consumerPollProducersForChange`                         | 18–24 ms    | 36–46 ms     |
  | `producerNotifyConsumers`                                | 6–26 ms     | 30–40 ms     |
  | `OutlineItem.streaming` computed (`outline-item.ts:147`) | 3.5–8.6 ms  | 11–14 ms     |

  Taken together, that is about 9 µs per outline row per chunk. A tree of 1000 branches would add about 9 ms to every chunk.

- **Suggested fix.** Split the live state.
  - Give each stream's text its own signal, for example a `WritableSignal<string>` created at `start` and kept in a map that is not itself a signal, or a `liveContent(nodeId)` accessor. Only the streaming `MessageItem` reads it.
  - Keep `live`, the stream metadata (node, branch, status), changing only on `start`, `status`, `done` and `error`.
  - Give the outline a `streamingBranchIds` computed with set equality, derived from the metadata only.
  - After this, a delta reaches one view and the scroll effect.
- **Status: fixed** (`LiveReplies` in `packages/web-shared/src/sse/live-replies.ts`, used by all three apps: one signal per reply, and a `branchIds` set that only changes when a reply starts or ends). Same harness, production build, median of 3 streams:

  |                                                     | 63 branches, before → after | 255 branches, before → after |
  | --------------------------------------------------- | --------------------------- | ---------------------------- |
  | Shallow branch, script per chunk                    | 2.6 → 2.0 ms                | 4.3 → 2.2 ms                 |
  | Deep branch, script per chunk                       | 2.9 → 2.1 ms                | 4.3 → 2.4 ms                 |
  | `detectChangesInView` self time per stream, shallow | 22 → 2.4 ms                 | 175 → 4.5 ms                 |
  | `detectChangesInView` self time per stream, deep    | 88 → 3.7 ms                 | 251 → 7.2 ms                 |
  | `OutlineItem.streaming` self time per stream        | 2–5 ms → 0                  | 16–18 ms → 0                 |

  Per-chunk cost no longer grows with the tree. What is left per chunk is issue 1 (Markdown and the sanitizer) and issue 6 (`scrollTo`).

#### 3. The outline renders every branch and is rebuilt as all-new objects on every `detail` change, so cost grows linearly with the branch count

- **Where**
  - `tree-store.ts:158-191`: `index` → `outline` → `flatOutline`, recomputed on any `detail` update (stream start and done, branch create, rename, links).
  - `packages/core/src/tree.ts:94-112`: `buildOutline` allocates a new `OutlineItem` for every branch.
  - `apps/web/src/app/sidebar/sidebar.ts:77` and `outline-item.ts` render it recursively: no virtualization, and everything expanded by default.
- **Mechanism**
  - DOM size and view creation are O(branches): about 16–20 elements per row, and the page grows from 3.1 k elements (63 branches) to 7.3 k (255).
  - Because every `item` input is a new object on every update, every row's computeds and bindings are re-checked even when only one branch changed.
- **Evidence** (production)
  - Expand all: 41.6 ms with 69 rows (script 20) → 139.8 ms with 261 rows (script 74, 2 long tasks up to 73 ms). Collapse: 5.8 → 15.6 ms.
  - Loading the deep branch: script 132 → 214 ms and layout 29 → 52 ms (d5 → d7), while its path only grew from 38 to 44 messages.
  - In Node the recompute is only 0.1 → 0.42 ms (core bench), so the cost is in the Angular views.
  - At about 1000 branches, expect roughly 0.5 s to expand or load.
- **Suggested fix**
  - Virtualize the outline (for example `cdk-virtual-scroll` over `flatOutline`), or render collapsed subtrees lazily and collapse deep levels by default.
  - Share structure: reuse the previous `OutlineItem` object for a branch when the branch, its message count and its children are unchanged. Unchanged rows then keep the same `item` reference and are skipped.

#### 4. Demo only: `DemoBackend.save()` serializes the whole session on every change, and some memory-repository operations scan every node

- **Where**
  - `packages/web-shared/src/demo/backend.ts:754-775`: `JSON.stringify` of all trees, branches and nodes, then a synchronous `sessionStorage.setItem`. It is called for every mutating request (`saved()`), at each send (`:526`) and at the end of each stream (`:579`).
  - `packages/core/src/testing/memory-repositories.ts:159`: `appendNodes` builds a `Set` of every node in the account on every send.
  - `memory-repositories.ts:45-56`: `listTrees` counts all branches and nodes per tree. It ran after every reply via `refreshAfterCompletion` (`tree-store.ts:1133-1134`); it no longer does (see the suspicion below).
- **Evidence**
  - Session size: 240 KB (63 branches) → 894 KB (255 branches).
  - Create branch: about 11 ms (`setItem` + `save`) of 47–59 ms at d5, and 41–46 ms of 100–115 ms at d7.
  - Per stream at d7: `setItem` 43–50 ms plus `save` 24–31 ms. These are the 87–91 ms long tasks at stream start and end.
  - Time to first token: 49–57 ms (d5) → 85–90 ms (d7); time to the `start` event: 30 → 57–64 ms.
  - sessionStorage holds about 5 M characters, so a tree around 5× d7 (about 4 k messages) would silently stop being mirrored (the `catch` in `save`).
- **Suggested fix.** Debounce `save()` to idle time or `pagehide`, or keep one storage key per tree. Index nodes by branch in the memory repositories. None of this affects production, which uses the Worker and D1, but it is what `/demo` users with a big tree feel.

#### 5. Opening a long path builds every message eagerly, so cost grows linearly with path length (moderate)

- **Where.** `apps/web/src/app/chat/chat-page.html` renders `@for (e of entries(); track e.node.id)` with one full `app-message-item` per message. Each one has about 25 computeds and child components (sources, tangents, ask box, related links, forks), plus a sanitized `innerHTML` per message even when the Markdown is cached.
- **Evidence** (production)
  - Trunk → D1 (10 messages): 34 ms.
  - Trunk → deep leaf (38 messages): 89 ms, including an 83 ms long task (d5). With 44 messages (d7): 111 ms.
  - Loading the deep URL: 269–295 ms versus 228–232 ms for the shallow one.
  - Deep leaf → sibling leaf: only 27–35 ms, because shared ancestors keep their DOM (`track e.node.id`). That is about 2–2.5 ms per message created, and it depends on path length, not on tree size.
  - Fine at 40 messages. A 200-message path would block for about 0.5 s.
- **Suggested fix**
  - Add `content-visibility: auto` with `contain-intrinsic-size` on `.msg`, or virtualize the message list.
  - Create the heavy sub-parts (tangents, ask box, related links, sources) lazily for ancestor messages, for example with `@defer (on viewport)`.

#### 6. The pin-to-bottom effect forces a layout on every delta (minor)

- **Where.** `apps/web/src/app/chat/chat-page.ts:188-193` schedules one `requestAnimationFrame` per delta, and `scrollTo` (`:264-273`) then sets `el.scrollTop = el.scrollHeight`, which reads layout.
- **Evidence.** `scrollTo` self time is 24–55 ms per stream of about 120 chunks (0.2–0.4 ms per chunk) in every streaming run, and 6.6 ms over 40 chunks at 16 k characters.
- **Suggested fix.** Coalesce to one pending rAF. Alternatively, rely on scroll anchoring (`overflow-anchor` with a bottom sentinel) or a `ResizeObserver` on the streaming message.

### Measured and fine

| Area                               | Numbers                                                                                                                                                                                                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context assembly (`packages/core`) | 0.02 ms for the depth-5 `path` leaf, independent of tree size; 0.17 ms for the deepest `summary` branch (sha256); 2.2 ms for all 32 leaves. Linear up to 3280 branches. **No O(n²)** in `indexTree`, outline, `branchPath`, `branchChain`, `descendantBranches` or `subtreeSize`. |
| Streaming DOM                      | Per chunk, only the streaming message's DOM changes (1 other-body mutation and 4 outline mutations per whole stream). Time to first token is 49–57 ms; the context assembly behind it is negligible.                                                                              |
| Memory                             | No leak over 2 × 50 (d5) and 2 × 100 (d7) switches: heap +0.1 to +0.3 MB per round, DOM nodes and listeners back to baseline, no drift in switch time.                                                                                                                            |
| Scrolling a 38–44-message branch   | 16.7 ms mean frame, p95 17.4–17.6 ms, max 33 ms, 0 frames over 50 ms.                                                                                                                                                                                                             |
| Context Inspector                  | 26–33 ms (11 segments) to 48–69 ms (39–45 segments); the demo `planContext` itself takes about 1–2 ms.                                                                                                                                                                            |
| Dialogs and drawer                 | "Branch from here" opens in 12–22 ms; the drawer in 11–23 ms.                                                                                                                                                                                                                     |

### Suspicions (from reading the code, not measured)

- **KaTeX re-typesets every formula of a streaming reply on every delta.** The new `innerHTML` replaces the `.math-done` elements (`packages/web-shared/src/ui/math.ts:20-45`, triggered from `:58-63`), so each delta typesets every formula again. That makes it quadratic in the number of formulas, with each KaTeX render costing about a millisecond. The lorem replies contain no math, so this is untested. The block-incremental fix for issue 1 also solves it.
- **The Markdown cache is FIFO with 300 entries and no refresh on hit** (`packages/web-shared/src/core/markdown.service.ts:10-30`). In trees with more than 300 messages, frequently used messages are evicted in insertion order and re-rendered when revisited. The d7 tree (784 messages) showed no drift in switch time across 100 switches, so the impact is small today. An LRU (delete and re-insert on hit) would be cheap.
- **`refreshAfterCompletion` refetches the whole conversation list after every reply** (`tree-store.ts:1133-1142`). In production that is a `/api/trees` round trip, with server-side counts, per reply and per tab. Server-side cost was not measured. **Fixed:** `done` now carries the tree's new title when auto-titling changed it (`done.tree`), the clients patch their list entry locally, and the stream scenario sees no `/api/trees` request after a reply (`treesRequests`: 1 per reply before, 0 after).
- **`upsertById` does a linear `findIndex` per item** (`tree-store.ts:78-86`), and every stream `start`/`done` re-indexes the whole tree. Measured at 0.1–0.4 ms in Node (up to 9 ms at 9860 messages). Fine for now.
- **Links were not seeded.** `MessageItem.related` (`message-item.ts:361`) and `linkCounts` are recomputed for every message on each `index` change; many links could add up.

---

## 5. Files added (no app code changed)

- `apps/e2e/perf/playwright.perf.config.ts`: separate Playwright config. Builds the app, serves it statically and runs `*.perf.ts`. Not picked up by `pnpm e2e`, whose `testDir` is `tests`.
- `apps/e2e/perf/power-tree.perf.ts`: the scenarios: baseline, load, switch, inspector, stream, create branch, outline and drawer, scroll, memory, and the synthetic long stream (dev only).
- `apps/e2e/perf/seed.ts`: Node-side seeding with the real `DemoBackend`.
- `apps/e2e/perf/probe.ts`: CDP probe (metrics, long tasks, CPU-profile summary, GC and heap).
- `apps/e2e/perf/sourcemap.ts`: minimal source-map lookup.
- `apps/e2e/perf/serve-static.mjs`, `apps/e2e/perf/tsconfig.json`.
- `packages/core/bench/heavy-tree.ts`, `packages/core/bench/scaling.perf.ts`, `packages/core/bench/vitest.config.ts`.
- `packages/render/bench/stream.perf.ts`, `packages/render/bench/vitest.config.ts`.
- Edited:
  - `apps/e2e/package.json`: added a `perf` script; `typecheck` now also checks `perf/`.
  - `packages/core/package.json` and `packages/render/package.json`: added a `bench` script.
  - Their `tsconfig.json` files now include `bench`.

`pnpm typecheck`, `pnpm lint` and Prettier pass. `pnpm test` is unchanged: the `*.perf.ts` files don't match Vitest's default `*.test`/`*.spec` include (core still runs 19 files and 344 tests; render 89 tests). Results are written to `apps/e2e/test-results/perf/*.json`, which is git-ignored.

## 6. Re-running

```bash
# Browser harness (in this container, Chromium lives in /opt/pw-browsers)
export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
pnpm --filter @tangent/e2e perf                          # production build, 5 deep × 2 (about 2 min)
PERF_DEPTH=7 pnpm --filter @tangent/e2e perf             # 255 branches
PERF_BUILD=dev pnpm --filter @tangent/e2e perf           # dev build: readable profiles + synthetic long stream
PERF_BUILD=dev PERF_SKIP_BUILD=1 pnpm --filter @tangent/e2e perf -g synthetic   # one scenario
# Other knobs: PERF_FANOUT, PERF_REPEAT (3), PERF_SWITCHES (50), PERF_OUT=<json>, PERF_PORT (8791),
#              PLAYWRIGHT_CHROMIUM_PATH=<binary>

# Microbenchmarks
pnpm --filter @tangent/core bench      # tree and context scaling table
pnpm --filter @tangent/render bench    # Markdown cost of streaming, full versus block-incremental
```
