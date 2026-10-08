import fs from 'node:fs';
import path from 'node:path';
import { test, type Page } from '@playwright/test';
import { installPageProbe, Probe, round, type Measurement } from './probe';
import { DEMO_STORAGE_KEY, seedHeavyTree, type SeededBranch, type SeededTree } from './seed';

/*
 * Power mode with a heavy tree: the /demo app over a seeded binary (by
 * default) tree of branches, PERF_DEPTH levels deep with PERF_FANOUT branches
 * at each level. Each interaction is measured in the page (see probe.ts),
 * once on a shallow branch and once on the deepest `path` branch, and the
 * results go to PERF_OUT (JSON) and the console.
 *
 *   pnpm --filter @tangent/e2e perf                  # 5 deep × 2, production build
 *   PERF_BUILD=dev pnpm --filter @tangent/e2e perf   # readable profiles (dev mode costs extra)
 *   PERF_DEPTH=7 pnpm --filter @tangent/e2e perf     # 254 branches
 */

const DEPTH = Number(process.env.PERF_DEPTH ?? 5);
const FANOUT = Number(process.env.PERF_FANOUT ?? 2);
const REPEAT = Number(process.env.PERF_REPEAT ?? 3);
const SWITCHES = Number(process.env.PERF_SWITCHES ?? 50);
const OUT =
  process.env.PERF_OUT ??
  path.resolve(
    import.meta.dirname,
    `../test-results/perf/power-d${DEPTH}x${FANOUT}-${process.env.PERF_BUILD ?? 'prod'}.json`,
  );

test.describe.configure({ mode: 'serial' });

let seeded: SeededTree;
let page: Page;
let probe: Probe;
const report: Record<string, unknown> = {};
const table: { name: string; m: Measurement }[] = [];

function byTitle(title: string): SeededBranch {
  const b = seeded.branches.find((x) => x.title === title);
  if (!b) throw new Error(`no branch ${title}`);
  return b;
}

// ---------------------------------------------------------------- in-page actions
// (serialized into the page: self-contained, no closures)

function clickOutline(title: string): void {
  const links = document.querySelectorAll<HTMLElement>('.outline-link');
  for (const l of links) {
    if (l.querySelector('.outline-title')?.textContent?.trim() === title) {
      l.click();
      return;
    }
  }
  throw new Error(`no outline item ${title}`);
}

function pathShown(a: { branchId: string | null; count: number }): boolean {
  const onBranch =
    a.branchId === null
      ? !location.pathname.includes('/b/')
      : location.pathname.includes(`/b/${a.branchId}`);
  return onBranch && document.querySelectorAll('.messages-inner .msg-body').length === a.count;
}

function typeAndSend(text: string): void {
  const box = document.querySelector<HTMLTextAreaElement>('#composer-input');
  if (!box) throw new Error('no composer');
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
}

/** The chat view's message count, the new branch's first etc. */
function countBodies(): number {
  return document.querySelectorAll('.messages-inner .msg-body').length;
}

async function settle(p: Page, ms = 300): Promise<void> {
  // Two frames and a quiet moment.
  await p.evaluate(
    (wait) =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, wait))),
      ),
    ms,
  );
}

async function goTrunk(): Promise<void> {
  await page.evaluate(clickOutline, 'Main thread');
  await page.waitForFunction(pathShown, { branchId: null, count: seeded.trunkPathLength });
  await settle(page);
}

function median(ms: Measurement[]): Measurement {
  const sorted = [...ms].sort((a, b) => a.wallMs - b.wallMs);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function record(name: string, m: Measurement): void {
  table.push({ name, m });
  console.log(
    `${name.padEnd(48)} wall ${String(m.wallMs).padStart(7)} ms  script ${String(m.scriptMs).padStart(7)}  layout ${String(m.layoutMs).padStart(6)}  style ${String(m.styleMs).padStart(6)}  long ${m.longTasks} (max ${m.longestTaskMs})  dom ${m.domNodes}`,
  );
  for (const h of m.hot.slice(0, 6))
    console.log(`      ${String(h.selfMs).padStart(7)} ms  ${h.fn}  ${h.where}  [${h.category}]`);
}

// ---------------------------------------------------------------- setup

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  const t0 = Date.now();
  seeded = await seedHeavyTree({ depth: DEPTH, fanout: FANOUT });
  report['seed'] = {
    depth: DEPTH,
    fanout: FANOUT,
    branches: seeded.branches.length + 1,
    nodes: seeded.nodeCount,
    storageChars: seeded.saved.length,
    spineLeafPath: byTitle(`D${DEPTH} ${Array(DEPTH).fill(0).join('.')}`).pathLength,
    seedMs: Date.now() - t0,
  };
  console.log('seeded', report['seed']);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(installPageProbe);
  await context.addInitScript(
    ({ key, value }) => {
      // Once per tab: later loads keep what the session has become.
      if (!sessionStorage.getItem('__perf_seeded')) {
        sessionStorage.setItem(key, value);
        sessionStorage.setItem('__perf_seeded', '1');
      }
    },
    { key: DEMO_STORAGE_KEY, value: seeded.saved },
  );
  page = await context.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e));
  probe = await Probe.attach(page);
  // Open the tree, so any test can run on its own (`-g`).
  await page.goto(`/demo/t/${seeded.treeId}`);
  await page.waitForFunction(pathShown, { branchId: null, count: seeded.trunkPathLength });
});

test.afterAll(async () => {
  report['measurements'] = table.map(({ name, m }) => ({ ...m, name }));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${OUT}`);
});

// ---------------------------------------------------------------- interactions

test('harness baseline: a no-op interaction', async () => {
  await page.goto(`/demo/t/${seeded.treeId}`);
  await page.waitForFunction(pathShown, { branchId: null, count: seeded.trunkPathLength });
  await settle(page, 500);
  const runs: Measurement[] = [];
  for (let i = 0; i < REPEAT; i++)
    runs.push(
      await probe.measure(
        'no-op (harness overhead)',
        () => undefined,
        null,
        () => true,
        null,
      ),
    );
  record('no-op (harness overhead)', median(runs));
});

test('load: shallow vs deep branch URL', async () => {
  test.setTimeout(180_000);
  const deep = byTitle(`D${DEPTH} ${Array(DEPTH).fill(0).join('.')}`);
  const shallow = byTitle('D1 0');
  for (const [label, b] of [
    ['shallow', shallow],
    ['deep', deep],
  ] as const) {
    const runs: { ms: number; script: number; layout: number; long: number; longestMs: number }[] =
      [];
    for (let i = 0; i < REPEAT; i++) {
      const before = await probe.metrics();
      await page.goto(`/demo/t/${seeded.treeId}/b/${b.id}`);
      await page.waitForFunction(
        (a) => {
          const w = window as unknown as { __perf: { tDone?: number } };
          const onBranch = location.pathname.includes(`/b/${a.branchId}`);
          if (
            !onBranch ||
            document.querySelectorAll('.messages-inner .msg-body').length !== a.count
          )
            return false;
          w.__perf.tDone ??= performance.now();
          return true;
        },
        { branchId: b.id, count: b.pathLength },
        { polling: 'raf' },
      );
      await settle(page, 200);
      const { t, long } = await page.evaluate(() => {
        const w = window as unknown as {
          __perf: { tDone: number; longTasks: { start: number; duration: number }[] };
        };
        return {
          t: w.__perf.tDone,
          long: w.__perf.longTasks.filter((l) => l.start < w.__perf.tDone),
        };
      });
      const m = await probe.metrics();
      runs.push({
        ms: round(t),
        script: round(((m['ScriptDuration'] ?? 0) - (before['ScriptDuration'] ?? 0)) * 1000),
        layout: round(((m['LayoutDuration'] ?? 0) - (before['LayoutDuration'] ?? 0)) * 1000),
        long: long.length,
        longestMs: round(Math.max(0, ...long.map((l) => l.duration))),
      });
    }
    runs.sort((a, b2) => a.ms - b2.ms);
    const mid = runs[Math.floor(runs.length / 2)]!;
    report[`load.${label}`] = { ...mid, pathLength: b.pathLength };
    console.log(`load ${label} (path ${b.pathLength}):`, mid, runs);
  }
  await settle(page, 500);
});

test('switch branch from the outline: shallow vs deep', async () => {
  test.setTimeout(180_000);
  const deep = byTitle(`D${DEPTH} ${Array(DEPTH).fill(0).join('.')}`);
  const deepSibling = byTitle(`D${DEPTH} ${[...Array(DEPTH - 1).fill(0), 1].join('.')}`);
  const shallow = byTitle('D1 0');
  for (const [label, b] of [
    ['trunk → D1 (shallow)', shallow],
    [`trunk → D${DEPTH} spine leaf (deep)`, deep],
  ] as const) {
    const runs: Measurement[] = [];
    for (let i = 0; i < REPEAT; i++) {
      await goTrunk();
      runs.push(
        await probe.measure(`switch ${label}`, clickOutline, b.title, pathShown, {
          branchId: b.id,
          count: b.pathLength,
        }),
      );
    }
    record(`switch ${label}`, median(runs));
  }
  // Deep → deep sibling (shares all but the last level).
  const runs: Measurement[] = [];
  for (let i = 0; i < REPEAT; i++) {
    await page.evaluate(clickOutline, deep.title);
    await page.waitForFunction(pathShown, { branchId: deep.id, count: deep.pathLength });
    await settle(page);
    const m = await probe.measure(
      'switch deep → deep sibling',
      clickOutline,
      deepSibling.title,
      pathShown,
      { branchId: deepSibling.id, count: deepSibling.pathLength },
    );
    runs.push(m);
  }
  record(`switch D${DEPTH} leaf → sibling leaf`, median(runs));
});

test('context inspector: open on shallow vs deep', async () => {
  test.setTimeout(180_000);
  const deep = byTitle(`D${DEPTH} ${Array(DEPTH).fill(0).join('.')}`);
  const shallow = byTitle('D1 0');
  for (const [label, b] of [
    ['shallow D1', shallow],
    [`deep D${DEPTH}`, deep],
  ] as const) {
    await page.evaluate(clickOutline, b.title);
    await page.waitForFunction(pathShown, { branchId: b.id, count: b.pathLength });
    await settle(page);
    const runs: Measurement[] = [];
    for (let i = 0; i < REPEAT; i++) {
      const m = await probe.measure(
        `inspector open ${label}`,
        () => document.querySelector<HTMLElement>('[aria-label="Context inspector (i)"]')!.click(),
        null,
        () =>
          document.querySelectorAll(
            '.inspector-body:not(.is-stale) .segments > li app-segment-card',
          ).length > 0,
        null,
        {
          extra: async () => ({
            segments: await page.evaluate(
              () => document.querySelectorAll('.inspector .segments > li').length,
            ),
          }),
        },
      );
      runs.push(m);
      await page.evaluate(() =>
        document.querySelector<HTMLElement>('[aria-label="Context inspector (i)"]')!.click(),
      );
      await settle(page);
    }
    record(`inspector open ${label}`, median(runs));
  }

  // Inspector left open while switching: every switch re-plans the context.
  await page.evaluate(() =>
    document.querySelector<HTMLElement>('[aria-label="Context inspector (i)"]')!.click(),
  );
  await page.waitForFunction(
    () => document.querySelectorAll('.inspector-body:not(.is-stale) .segments > li').length > 0,
  );
  const sibling = byTitle(`D${DEPTH} ${[...Array(DEPTH - 1).fill(0), 1].join('.')}`);
  const runs: Measurement[] = [];
  for (let i = 0; i < REPEAT; i++) {
    for (const b of [sibling, deep]) {
      const m = await probe.measure(
        `switch with inspector open → ${b.title}`,
        clickOutline,
        b.title,
        (title: string) => {
          const active = document.querySelector('.outline-row.is-selected .outline-title');
          return (
            active?.textContent?.trim() === title &&
            document.querySelectorAll('.inspector-body:not(.is-stale) .segments > li').length > 0
          );
        },
        b.title,
      );
      if (b === deep) runs.push(m);
    }
  }
  record(`switch → D${DEPTH} leaf, inspector open`, median(runs));
  await page.evaluate(() =>
    document.querySelector<HTMLElement>('[aria-label="Context inspector (i)"]')!.click(),
  );
  await settle(page);
});

interface StreamStats {
  tSent: number;
  tStart: number | null;
  tFirstToken: number | null;
  tDone: number | null;
  batches: number;
  streamingBodyBatches: number;
  otherBodyMutations: number;
  outlineMutations: number;
  nodesAdded: number;
  finalChars: number;
  frameGaps: number[];
}

/** Watches the message list while a reply streams in (installed just before sending). */
function watchStream(before: number): void {
  const w = window as unknown as {
    __stream: StreamStats;
    __streamObs: MutationObserver[];
    __streamDone: Promise<void>;
  };
  let finish!: () => void;
  w.__streamDone = new Promise<void>((r) => (finish = r));
  const s: StreamStats = {
    tSent: performance.now(),
    tStart: null,
    tFirstToken: null,
    tDone: null,
    batches: 0,
    streamingBodyBatches: 0,
    otherBodyMutations: 0,
    outlineMutations: 0,
    nodesAdded: 0,
    finalChars: 0,
    frameGaps: [],
  };
  w.__stream = s;
  const list = document.querySelector('.messages-inner')!;
  // Found once (the reply's body element is kept while it streams); cheap afterwards.
  let found: Element | null = null;
  const streamingBody = (): Element | null => {
    if (found?.isConnected) return found;
    const bodies = list.getElementsByClassName('msg-body');
    found = bodies.length > before ? (bodies[bodies.length - 1] ?? null) : null;
    return found;
  };
  const obs = new MutationObserver((records) => {
    const now = performance.now();
    s.batches++;
    const target = streamingBody();
    if (target && s.tStart === null) s.tStart = now;
    let touchedStreaming = false;
    for (const r of records) {
      s.nodesAdded += r.addedNodes.length;
      const el = r.target instanceof Element ? r.target : r.target.parentElement;
      const body = el?.closest('.msg-body');
      if (body && body === target) touchedStreaming = true;
      else if (body) s.otherBodyMutations++;
    }
    if (touchedStreaming) s.streamingBodyBatches++;
    if (target && s.tFirstToken === null && (target.textContent ?? '').trim() !== '')
      s.tFirstToken = now;
  });
  obs.observe(list, { childList: true, subtree: true, characterData: true, attributes: false });
  const outline = document.querySelector('.outline');
  const obs2 = new MutationObserver((records) => (s.outlineMutations += records.length));
  if (outline)
    obs2.observe(outline, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
  w.__streamObs = [obs, obs2];
  let last = performance.now();
  const bodies = list.getElementsByClassName('msg-body');
  const cursors = list.getElementsByClassName('cursor');
  const frame = (): void => {
    const now = performance.now();
    s.frameGaps.push(now - last);
    last = now;
    // Done: the reply's message is there, and nothing streams any more.
    if (s.tStart !== null && bodies.length === before + 2 && cursors.length === 0) {
      s.tDone = now;
      s.finalChars = bodies[bodies.length - 1]?.textContent?.length ?? 0;
      for (const o of w.__streamObs) o.disconnect();
      finish();
      return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

test('send and stream a reply: shallow vs deep path branch', async () => {
  test.setTimeout(300_000);
  const deep = byTitle(`D${DEPTH} ${Array(DEPTH).fill(0).join('.')}`);
  const shallow = byTitle('D1 0');
  const streams: Record<string, unknown> = {};
  for (const [label, b] of [
    ['shallow D1', shallow],
    [`deep D${DEPTH}`, deep],
  ] as const) {
    const runs: Record<string, number | string>[] = [];
    for (let i = 0; i < REPEAT; i++) {
      await page.evaluate(clickOutline, b.title);
      await page.waitForFunction((t) => {
        const a = document.querySelector('.outline-row.is-selected .outline-title');
        return a?.textContent?.trim() === t && !document.querySelector('.messages-inner .cursor');
      }, b.title);
      await settle(page, 500);
      const before = await page.evaluate(countBodies);
      await page.evaluate(() => {
        const el = document.querySelector('.messages');
        if (el) el.scrollTop = el.scrollHeight;
      });
      const end = await probe.begin();
      await page.evaluate(watchStream, before);
      await page.evaluate(typeAndSend, `Perf question ${i} in ${b.title}: tell me more.`);
      await page.evaluate(
        () => (window as unknown as { __streamDone: Promise<void> }).__streamDone,
      );
      const prof = await end();
      const s = await page.evaluate(
        () => (window as unknown as { __stream: StreamStats }).__stream,
      );
      const longTasks = await page.evaluate(
        (t) =>
          (
            window as unknown as { __perf: { longTasks: { start: number; duration: number }[] } }
          ).__perf.longTasks.filter((l) => l.start >= t),
        s.tSent,
      );
      const gaps = s.frameGaps.slice(1).sort((x, y) => x - y);
      const chunks = Math.max(1, s.streamingBodyBatches);
      const scriptMs = (prof.delta['ScriptDuration'] ?? 0) * 1000;
      const run = {
        ttftMs: round((s.tFirstToken ?? NaN) - s.tSent),
        startMs: round((s.tStart ?? NaN) - s.tSent),
        streamMs: round((s.tDone ?? NaN) - s.tSent),
        chunks: s.streamingBodyBatches,
        otherBodyMutations: s.otherBodyMutations,
        outlineMutations: s.outlineMutations,
        finalChars: s.finalChars,
        scriptMs: round(scriptMs),
        scriptPerChunkMs: round(scriptMs / chunks),
        layoutPerChunkMs: round(((prof.delta['LayoutDuration'] ?? 0) * 1000) / chunks),
        stylePerChunkMs: round(((prof.delta['RecalcStyleDuration'] ?? 0) * 1000) / chunks),
        taskPerChunkMs: round(((prof.delta['TaskDuration'] ?? 0) * 1000) / chunks),
        longTasks: longTasks.length,
        longestTaskMs: round(Math.max(0, ...longTasks.map((l) => l.duration))),
        framesOver50: s.frameGaps.filter((g) => g > 50).length,
        frameP95Ms: round(gaps[Math.floor(gaps.length * 0.95)] ?? 0),
        frameMaxMs: round(gaps.at(-1) ?? 0),
        cat: JSON.stringify(prof.categories),
      };
      runs.push(run);
      if (i === REPEAT - 1) {
        console.log(`stream ${label}: top self time over the whole stream`);
        for (const h of prof.hot.slice(0, 12))
          console.log(
            `      ${String(h.selfMs).padStart(7)} ms  ${h.fn}  ${h.where}  [${h.category}]`,
          );
        streams[`${label}.hot`] = prof.hot;
        streams[`${label}.categories`] = prof.categories;
      }
      await settle(page, 300);
    }
    runs.sort((x, y) => Number(x['ttftMs']) - Number(y['ttftMs']));
    const mid = runs[Math.floor(runs.length / 2)]!;
    streams[label] = { median: mid, runs };
    console.log(`stream ${label}:`, mid);
  }
  report['stream'] = streams;
});

test('create a branch with "Branch from here": shallow vs deep', async () => {
  test.setTimeout(180_000);
  const deep = byTitle(`D${DEPTH} ${Array(DEPTH).fill(0).join('.')}`);
  const shallow = byTitle('D1 0');
  for (const [label, b] of [
    ['shallow D1', shallow],
    [`deep D${DEPTH}`, deep],
  ] as const) {
    const opens: Measurement[] = [];
    const creates: Measurement[] = [];
    for (let i = 0; i < REPEAT; i++) {
      await page.evaluate(clickOutline, b.title);
      await page.waitForFunction((t) => {
        const a = document.querySelector('.outline-row.is-selected .outline-title');
        return a?.textContent?.trim() === t;
      }, b.title);
      await settle(page);
      opens.push(
        await probe.measure(
          `branch dialog open ${label}`,
          () => {
            const msgs = document.querySelectorAll('.messages-inner .msg-assistant');
            const last = msgs[msgs.length - 1];
            const btn = [
              ...(last?.querySelectorAll<HTMLElement>('.msg-actions button') ?? []),
            ].find((x) => x.textContent?.includes('Branch from here'));
            btn!.click();
          },
          null,
          () => !!document.querySelector('app-branch-dialog form button[type="submit"]'),
          null,
        ),
      );
      creates.push(
        await probe.measure(
          `create branch ${label}`,
          () => {
            document.querySelector<HTMLFormElement>('app-branch-dialog form')!.requestSubmit();
          },
          null,
          () =>
            !document.querySelector('app-branch-dialog') &&
            !!document.querySelector('.messages-inner .fork-current') &&
            [...document.querySelectorAll('.messages-inner p')].some((p) =>
              p.textContent?.includes('Your next message starts it'),
            ),
          null,
        ),
      );
      await settle(page);
    }
    record(`branch dialog open ${label}`, median(opens));
    record(`create branch ${label}`, median(creates));
  }
});

test('outline: collapse and expand the whole tree', async () => {
  test.setTimeout(120_000);
  await goTrunk();
  const toggle = (): void => {
    document.querySelector<HTMLElement>('.outline .twisty')!.click();
  };
  const collapsed = (): boolean => document.querySelectorAll('.outline .outline-row').length === 1;
  const total = await page.evaluate(
    () => document.querySelectorAll('.outline .outline-row').length,
  );
  const cs: Measurement[] = [];
  const es: Measurement[] = [];
  for (let i = 0; i < REPEAT; i++) {
    cs.push(await probe.measure('outline collapse all', toggle, null, collapsed, null));
    await settle(page);
    es.push(
      await probe.measure(
        'outline expand all',
        toggle,
        null,
        (n: number) => document.querySelectorAll('.outline .outline-row').length === n,
        total,
      ),
    );
    await settle(page);
  }
  record(`outline collapse (${total} rows)`, median(cs));
  record(`outline expand (${total} rows)`, median(es));

  // Narrow window: the sidebar becomes a drawer.
  await page.setViewportSize({ width: 800, height: 900 });
  await settle(page);
  const ds: Measurement[] = [];
  for (let i = 0; i < REPEAT; i++) {
    ds.push(
      await probe.measure(
        'drawer open (narrow)',
        () => document.querySelector<HTMLElement>('[aria-label="Open menu"]')!.click(),
        null,
        () => !!document.querySelector('.app.drawer-open .scrim'),
        null,
      ),
    );
    await page.evaluate(() => document.querySelector<HTMLElement>('.scrim')!.click());
    await settle(page);
  }
  record('drawer open (narrow window)', median(ds));
  await page.setViewportSize({ width: 1440, height: 900 });
  await settle(page);
});

test('scroll the long deep branch', async () => {
  test.setTimeout(120_000);
  const deep = byTitle(`D${DEPTH} ${Array(DEPTH).fill(0).join('.')}`);
  await page.evaluate(clickOutline, deep.title);
  await page.waitForFunction((t) => {
    const a = document.querySelector('.outline-row.is-selected .outline-title');
    return a?.textContent?.trim() === t;
  }, deep.title);
  await settle(page, 500);
  const end = await probe.begin();
  const frames = await page.evaluate(
    () =>
      new Promise<{ gaps: number[]; height: number }>((resolve) => {
        const el = document.querySelector<HTMLElement>('.messages')!;
        el.scrollTop = 0;
        const gaps: number[] = [];
        let last = performance.now();
        let dir = 1;
        let passes = 0;
        const step = (): void => {
          const now = performance.now();
          gaps.push(now - last);
          last = now;
          el.scrollTop += dir * 120;
          const atEnd =
            dir > 0 ? el.scrollTop + el.clientHeight >= el.scrollHeight - 1 : el.scrollTop <= 0;
          if (atEnd) {
            dir = -dir;
            passes++;
          }
          if (passes < 4) requestAnimationFrame(step);
          else resolve({ gaps: gaps.slice(1), height: el.scrollHeight });
        };
        requestAnimationFrame(step);
      }),
  );
  const prof = await end();
  const g = [...frames.gaps].sort((a, b) => a - b);
  const stats = {
    scrollHeightPx: frames.height,
    frames: g.length,
    meanMs: round(g.reduce((s, x) => s + x, 0) / g.length),
    p95Ms: round(g[Math.floor(g.length * 0.95)] ?? 0),
    maxMs: round(g.at(-1) ?? 0),
    over50: g.filter((x) => x > 50).length,
    scriptMs: round((prof.delta['ScriptDuration'] ?? 0) * 1000),
    layoutMs: round((prof.delta['LayoutDuration'] ?? 0) * 1000),
    styleMs: round((prof.delta['RecalcStyleDuration'] ?? 0) * 1000),
  };
  report['scroll'] = { ...stats, hot: prof.hot.slice(0, 10) };
  console.log('scroll deep branch', stats);
});

test(`memory: ${SWITCHES} branch switches`, async () => {
  test.setTimeout(600_000);
  // A mix of depths and modes.
  const targets = seeded.branches
    .filter((b) => b.depth >= 2)
    .filter((_, i) => i % Math.max(1, Math.floor(seeded.branches.length / 10)) === 0)
    .slice(0, 10);
  const cycle = async (n: number): Promise<number[]> => {
    const times: number[] = [];
    for (let i = 0; i < n; i++) {
      const b = targets[i % targets.length]!;
      const t0 = await page.evaluate(() => performance.now());
      await page.evaluate(clickOutline, b.title);
      await page.waitForFunction(
        pathShown,
        { branchId: b.id, count: b.pathLength },
        { polling: 'raf' },
      );
      const t1 = await page.evaluate(() => performance.now());
      times.push(t1 - t0);
    }
    return times;
  };
  await cycle(10); // warm-up: every target rendered once (markdown cache, chunks)
  await settle(page, 500);
  const before = await probe.afterGc();
  const times = await cycle(SWITCHES);
  await goTrunk();
  await settle(page, 1000);
  const after = await probe.afterGc();
  const first = times.slice(0, 10);
  const last = times.slice(-10);
  const avg = (xs: number[]): number => round(xs.reduce((s, x) => s + x, 0) / xs.length);
  const mem = {
    before,
    after,
    heapGrowthMB: round(after.heapMB - before.heapMB),
    nodeGrowth: after.nodes - before.nodes,
    listenerGrowth: after.listeners - before.listeners,
    switchAvgFirst10Ms: avg(first),
    switchAvgLast10Ms: avg(last),
    /** Mean switch time per block of 10: a drift upwards would mean something accumulates. */
    switchAvgPer10Ms: Array.from({ length: Math.ceil(times.length / 10) }, (_, i) =>
      avg(times.slice(i * 10, i * 10 + 10)),
    ),
  };
  report['memory'] = mem;
  console.log('memory', mem);

  // Once more: does it keep growing?
  await cycle(SWITCHES);
  await goTrunk();
  await settle(page, 1000);
  const again = await probe.afterGc();
  report['memory2'] = { after: again, heapGrowthMB: round(again.heapMB - after.heapMB) };
  console.log('memory, second round', report['memory2']);
});

/*
 * Dev build only (it needs Angular's `ng` debugging global to reach the
 * TreeStore): streams a long synthetic reply into the deep branch's last
 * message through the store's live-stream state, 4 characters a chunk like
 * a real token stream, and reads the cost of 40 chunks at several reply
 * lengths. A real stream re-renders the whole message on every chunk, so the
 * per-chunk cost should grow with the length.
 */
interface DebugStore {
  path: () => {
    id: string;
    role: string;
    status: string;
    treeId: string;
    branchId: string;
    content: string;
  }[];
  applyNodes: (nodes: unknown[]) => void;
  setLive: (s: unknown) => void;
  patchLive: (id: string, p: { content: string }) => void;
  dropLive: (id: string) => void;
}

test('synthetic long reply stream: per-chunk cost vs reply length (dev build)', async () => {
  test.skip(process.env.PERF_BUILD !== 'dev', 'needs the dev build (ng debugging API)');
  test.setTimeout(300_000);
  const deep = byTitle(`D${DEPTH} ${Array(DEPTH).fill(0).join('.')}`);
  await page.goto(`/demo/t/${seeded.treeId}/b/${deep.id}`);
  // Earlier tests may have added messages here: wait for the selection, not a count.
  await page.waitForFunction((t) => {
    const a = document.querySelector('.outline-row.is-selected .outline-title');
    return a?.textContent?.trim() === t && document.querySelectorAll('.msg-body').length > 0;
  }, deep.title);
  await settle(page, 500);
  await page.evaluate(() => {
    const w = window as unknown as {
      ng: { getComponent: (el: Element) => { store: DebugStore } };
      __synth: { store: DebugStore; node: ReturnType<DebugStore['path']>[number]; text: string };
    };
    const store = w.ng.getComponent(document.querySelector('app-chat-page')!).store;
    const node = store
      .path()
      .filter((n) => n.role === 'assistant')
      .at(-1)!;
    const para =
      'The **key idea** is that `branches` share a prefix, so the context of a deep branch is the ' +
      'path from the root, and every reply adds [a link](https://example.org) or two. ';
    const blocks: string[] = [];
    for (let i = 0; blocks.join('\n\n').length < 40_000; i++) {
      blocks.push(`## Section ${i}`);
      blocks.push(para.repeat(3));
      blocks.push(
        ['- one point about trees', '- another about paths', '- a third, *emphasized*'].join('\n'),
      );
      if (i % 3 === 0)
        blocks.push(
          '```ts\nconst path = branchPath(index, id);\nfor (const n of path) total += n.content.length;\n```',
        );
    }
    w.__synth = { store, node, text: blocks.join('\n\n') };
    store.applyNodes([{ ...node, status: 'streaming', content: '' }]);
    store.setLive({
      nodeId: node.id,
      treeId: node.treeId,
      branchId: node.branchId,
      content: '',
      status: null,
      reconnecting: false,
    });
  });
  const rows: Record<string, number>[] = [];
  for (const size of [1_000, 4_000, 8_000, 16_000, 32_000]) {
    await page.evaluate((s) => {
      const w = window as unknown as {
        __synth: { store: DebugStore; node: { id: string }; text: string };
      };
      w.__synth.store.patchLive(w.__synth.node.id, { content: w.__synth.text.slice(0, s) });
    }, size);
    await settle(page, 300);
    const before = await probe.metrics();
    const end = await probe.begin();
    const wallPerChunk = await page.evaluate(async (s) => {
      const w = window as unknown as {
        __synth: { store: DebugStore; node: { id: string }; text: string };
      };
      const frame = (): Promise<void> =>
        new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
      const t0 = performance.now();
      for (let i = 0; i < 40; i++) {
        w.__synth.store.patchLive(w.__synth.node.id, {
          content: w.__synth.text.slice(0, s + 4 * (i + 1)),
        });
        await frame();
      }
      return (performance.now() - t0) / 40;
    }, size);
    const prof = await end();
    const after = await probe.metrics();
    const per = (k: string): number => round((((after[k] ?? 0) - (before[k] ?? 0)) * 1000) / 40);
    const row = {
      chars: size,
      scriptPerChunkMs: per('ScriptDuration'),
      layoutPerChunkMs: per('LayoutDuration'),
      stylePerChunkMs: per('RecalcStyleDuration'),
      taskPerChunkMs: per('TaskDuration'),
      wallPerChunkMs: round(wallPerChunk),
      markdownItMs: round((prof.categories['markdown-it'] ?? 0) / 40),
      renderMs: round((prof.categories['render'] ?? 0) / 40),
      highlightMs: round((prof.categories['highlight.js'] ?? 0) / 40),
      angularMs: round(
        ((prof.categories['angular'] ?? 0) + (prof.categories['angular-dom'] ?? 0)) / 40,
      ),
      nativeMs: round((prof.categories['native'] ?? 0) / 40),
    };
    rows.push(row);
    console.log('synthetic stream', row);
    if (size === 16_000)
      for (const h of prof.hot.slice(0, 12))
        console.log(
          `      ${String(h.selfMs).padStart(7)} ms  ${h.fn}  ${h.where}  [${h.category}]`,
        );
  }
  report['syntheticStream'] = rows;
  await page.evaluate(() => {
    const w = window as unknown as { __synth: { store: DebugStore; node: { id: string } } };
    w.__synth.store.dropLive(w.__synth.node.id);
    w.__synth.store.applyNodes([w.__synth.node]);
  });
});
