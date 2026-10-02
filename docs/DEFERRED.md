# Deferred work

Known gaps and follow-ups that were consciously left out of a change. Each entry says where the gap is, why it matters, and roughly what fixing it takes. Remove entries as they are done.

## Canvas (`apps/canvas`)

Found in an independent review of the first cut of the experimental Canvas app. None of these block using it; together they are a day or two of iteration.

### Not done yet

- **No culling of off-screen lanes.** `LayoutStore.isVisible()` (`apps/canvas/src/app/layout/layout-store.ts`) exists but nothing calls it: `canvas-page.html` renders every `<app-lane>` always, so a large tree keeps the full markdown DOM of every card alive and re-rasterizes all of it on each zoom step. Fix: render a placeholder of the measured height for lanes that are off screen (keep their last `LaneMeasure` so the layout does not shift), swap the real lane back in when they scroll into view.
- **Markdown re-rendered on every delta.** `Card.html` (`apps/canvas/src/app/canvas/card.ts`) runs the whole reply through markdown-it and highlight.js, uncached, for each streamed delta; with several lanes streaming that is several full renders per frame on the main thread. Fix: throttle streaming renders to one per animation frame, or render only the tail while streaming and the full message on `done`.
- **Fan-out creates branches one after another.** `CanvasStore.fanOut` (`apps/canvas/src/app/state/canvas-store.ts`) awaits each `createBranch` in a `for` loop. Fix: create them with `Promise.all` and then send; keep the outline order by the created branches' order, not by completion.
- **New lanes jump once measured.** A lane is placed at `defaultLaneHeight` (240) until its first `ResizeObserver` report, so lanes below it slide after the first paint. Fix: estimate the height from the message lengths (or the number of cards) before the first measurement.
- **No fling inertia.** Drag-panning stops dead on pointer up (`CanvasPage.onPointerUp`, `apps/canvas/src/app/canvas/canvas-page.ts`). Fix: track the pointer velocity over the last few moves and decay it with `requestAnimationFrame`, cancelled by the next pointer down or wheel.
- **No `prefers-reduced-motion`.** The world transform, lane moves and the budget bar animate unconditionally (`apps/canvas/src/styles.css`). Fix: a media query that drops those transitions, and skip the pulsing "writing" dot.
- **Touch: most touches cannot pan.** `onPointerDown` refuses to pan when the touch starts on a card body, the tangents or a text box, which on a phone is most of a lane; `touch-action: none` on the viewport also turns off native scroll physics. Fix: a drag threshold (pan once the pointer moves more than ~8px, select text on long press), so card bodies can still be panned from.
- **Safari pinch is untested.** Zoom relies on ctrl-modified wheel events and two-pointer distance; check it on Safari and iOS.
- **Lanes stay long.** Unselected lanes off the ancestry clip each card at 150px (`.lane-cards.is-compact`), but a lane with many turns is still tall. Consider clamping the number of cards shown in compact lanes, with a "N more" stub.

### Inherent to the DOM approach (noted, not planned)

- Layout depends on measured DOM heights, so it is always a two-phase render: place, measure, place again. Streaming text therefore reflows the tree live, which is also the feature.
- The zoomed world is one scaled compositor layer; there is no level of detail short of a second, simpler DOM for low zoom.
- Native text selection, find-in-page, screen readers and copy of rendered markdown come for free, which a canvas-drawn UI (for example Flutter web) would have to rebuild. See the Flutter review summarized in `DECISIONS.md` ("Canvas").

### Features left out of the first cut

- Reviewer, shares, export, backups and the system prompt editor: use Power mode, which shows the same conversations.
- Phone layout is cramped: the lane map is a desktop idea. A phone-first design would be linear with "doors" into branches (see the candidate views below).

### Candidate next views (from the same review)

- **Context Ledger.** One column showing the selected branch exactly as the model reads it, segment by segment from the context plan: system prompt, inherited ancestors, the branch summary with its status, the anchor quote, compaction stubs where messages vanished, then the branch, each with its token count and reason, and a budget rail. Writing a message shows live what it will cost and what it would push out. The API already returns everything (`GET /api/branches/:id/context`).
- **Variant Arena.** Pick a message; sibling branches off it (what fan-out creates) become a grid aligned turn by turn, with a reviewer column (`POST /api/nodes/:id/review`) showing accuracy and recommendation per variant, and "promote this variant" to move its model to the parent.
- **Trail Deck (phone).** A single thread where messages with branches or tangents show doors you swipe into, the breadcrumb chain stays pinned, and swiping back returns to the fork. The one concept where native gesture physics (a Flutter app) would earn their keep; it also needs a token-based auth path on the server first.
