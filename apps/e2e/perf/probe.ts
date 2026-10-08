/*
 * Measuring one interaction in the page: wall time (in-page clock, from the
 * action to the done condition and to the next frame), long tasks (>50 ms),
 * the CDP Performance metrics delta (script, layout, style time; heap; DOM
 * nodes) and a sampled CPU profile, summarized as self time by function,
 * mapped through the bundles' source maps to repository files.
 */
import type { CDPSession, Page } from '@playwright/test';
import { SourceMap, type Original } from './sourcemap';

export interface LongTask {
  start: number;
  duration: number;
}

export interface Hot {
  fn: string;
  where: string;
  category: string;
  selfMs: number;
}

export interface Measurement {
  name: string;
  /** Action → done condition (DOM updated), in-page clock. */
  wallMs: number;
  /** Action → the frame after the done condition. */
  toFrameMs: number;
  scriptMs: number;
  layoutMs: number;
  styleMs: number;
  /** Main-thread task time (all work). */
  taskMs: number;
  longTasks: number;
  longestTaskMs: number;
  longTaskTotalMs: number;
  domNodes: number;
  heapUsedMB: number;
  /** CPU profile self time grouped by category (angular, app, core, demo backend, …). */
  categories: Record<string, number>;
  hot: Hot[];
  extra?: Record<string, number | string>;
}

/** Installed with addInitScript: the long-task log the probe reads. */
export function installPageProbe(): void {
  const w = window as unknown as { __perf: { longTasks: LongTask[] } };
  w.__perf = { longTasks: [] };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        w.__perf.longTasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    // No long-task timing in this browser.
  }
}

interface FrameWithLocation {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}
interface ProfileNode {
  id: number;
  callFrame: FrameWithLocation;
}
interface CpuProfile {
  nodes: ProfileNode[];
  samples?: number[];
  timeDeltas?: number[];
}

function categorize(source: string, url: string): string {
  const s = source || url;
  // Angular's own sources (its signals primitives map to bazel paths like bin/packages/core/…).
  if (/@angular|k8-fastbuild/.test(s))
    return /platform-browser/.test(s) ? 'angular-dom' : 'angular';
  if (/web-shared\/src\/demo|packages\/core\/src\/testing/.test(s)) return 'demo-backend';
  if (/packages\/core\/src/.test(s)) return 'core';
  if (/packages\/shared\/src/.test(s)) return 'shared';
  if (/packages\/render\/src/.test(s)) return 'render';
  if (/markdown-it|linkify|mdurl|uc\.micro|punycode|entities/.test(s)) return 'markdown-it';
  if (/highlight\.js/.test(s)) return 'highlight.js';
  if (/katex/.test(s)) return 'katex';
  if (/txtgen/.test(s)) return 'demo-backend';
  if (/zod/.test(s)) return 'zod';
  if (/@angular\/platform-browser/.test(s)) return 'angular-dom';
  if (/@angular/.test(s)) return 'angular';
  if (/rxjs/.test(s)) return 'rxjs';
  if (/apps\/web\/src|^src\/app\//.test(s)) return 'app';
  if (/web-shared\/src/.test(s)) return 'web-shared';
  if (url === '') return 'native';
  return 'other';
}

export class Probe {
  private readonly maps = new Map<string, Promise<SourceMap | null>>();
  readonly results: Measurement[] = [];

  private constructor(
    readonly page: Page,
    readonly cdp: CDPSession,
  ) {}

  static async attach(page: Page): Promise<Probe> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('HeapProfiler.enable');
    return new Probe(page, cdp);
  }

  async metrics(): Promise<Record<string, number>> {
    const { metrics } = await this.cdp.send('Performance.getMetrics');
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  }

  /** Forces garbage collection (twice, to clear weak caches), then reads the heap and DOM counts. */
  async afterGc(): Promise<{
    heapMB: number;
    nodes: number;
    listeners: number;
    documents: number;
  }> {
    await this.cdp.send('HeapProfiler.collectGarbage');
    await this.page.waitForTimeout(100);
    await this.cdp.send('HeapProfiler.collectGarbage');
    const heap = await this.cdp.send('Runtime.getHeapUsage');
    const m = await this.metrics();
    return {
      heapMB: heap.usedSize / 1048576,
      nodes: m['Nodes'] ?? 0,
      listeners: m['JSEventListeners'] ?? 0,
      documents: m['Documents'] ?? 0,
    };
  }

  private sourceMap(url: string): Promise<SourceMap | null> {
    let p = this.maps.get(url);
    if (!p) {
      p = (async () => {
        if (!/^https?:/.test(url) || !url.endsWith('.js')) return null;
        try {
          const res = await fetch(`${url}.map`);
          if (!res.ok) return null;
          return new SourceMap((await res.json()) as ConstructorParameters<typeof SourceMap>[0]);
        } catch {
          return null;
        }
      })();
      this.maps.set(url, p);
    }
    return p;
  }

  /** Self time by function (mapped to sources), and by category. */
  async summarize(
    profile: CpuProfile,
    top = 15,
  ): Promise<{ hot: Hot[]; categories: Record<string, number> }> {
    const selfUs = new Map<number, number>();
    const samples = profile.samples ?? [];
    const deltas = profile.timeDeltas ?? [];
    for (let i = 0; i < samples.length; i++) {
      // A sample's delta is the time since the previous one: charge it to this sample's node.
      selfUs.set(samples[i]!, (selfUs.get(samples[i]!) ?? 0) + (deltas[i] ?? 0));
    }
    const byKey = new Map<string, Hot>();
    const categories: Record<string, number> = {};
    for (const node of profile.nodes) {
      const us = selfUs.get(node.id) ?? 0;
      if (us === 0) continue;
      const cf = node.callFrame;
      const fnName = cf.functionName || '(anonymous)';
      if (fnName === '(idle)' || fnName === '(program)' || fnName === '(garbage collector)') {
        categories[fnName] = (categories[fnName] ?? 0) + us / 1000;
        continue;
      }
      let orig: Original | null = null;
      const map = cf.url ? await this.sourceMap(cf.url) : null;
      if (map) orig = map.lookup(cf.lineNumber, cf.columnNumber);
      const source = orig ? orig.source.replace(/^(\.\.\/)+|^webpack:\/\/\//, '') : '';
      const where = orig
        ? `${source}:${orig.line}`
        : `${cf.url.split('/').pop() ?? ''}:${cf.lineNumber + 1}`;
      const category = categorize(source, cf.url);
      categories[category] = (categories[category] ?? 0) + us / 1000;
      // The original name when the map has one (production bundles are minified).
      const shown = orig?.name && orig.name !== fnName ? `${orig.name} (${fnName})` : fnName;
      const key = `${shown}@${where}`;
      const hot = byKey.get(key) ?? { fn: shown, where, category, selfMs: 0 };
      hot.selfMs += us / 1000;
      byKey.set(key, hot);
    }
    const hot = [...byKey.values()]
      .sort((a, b) => b.selfMs - a.selfMs)
      .slice(0, top)
      .map((h) => ({ ...h, selfMs: round(h.selfMs) }));
    for (const k of Object.keys(categories)) categories[k] = round(categories[k]!);
    return { hot, categories };
  }

  /**
   * Runs `action(actionArg)` in the page (timed from just before it), waits
   * for `done(doneArg)` (polled every frame; the first frame it holds is the
   * done time), then the next frame. Both functions are serialized into the
   * page, so they must be self-contained.
   */
  async measure<A, D>(
    name: string,
    action: (arg: A) => void | Promise<void>,
    actionArg: A,
    done: (arg: D) => boolean,
    doneArg: D,
    options: {
      profile?: boolean;
      timeoutMs?: number;
      extra?: () => Promise<Record<string, number | string>>;
    } = {},
  ): Promise<Measurement> {
    const profile = options.profile ?? true;
    const before = await this.metrics();
    if (profile) await this.cdp.send('Profiler.start');
    const t0 = await this.page.evaluate(
      async ({ src, a }) => {
        const w = window as unknown as { __perf: { tDone?: number; t0?: number } };
        w.__perf.tDone = undefined;
        const fn = new Function(`return (${src})`)() as (x: unknown) => unknown;
        const t = performance.now();
        w.__perf.t0 = t;
        await fn(a);
        return t;
      },
      { src: action.toString(), a: actionArg as unknown },
    );
    await this.page.waitForFunction(
      ({ src, a }) => {
        const w = window as unknown as {
          __perf: { tDone?: number; fns?: Map<string, (x: unknown) => boolean> };
        };
        // Compiled once per measurement, not every frame.
        const fns = (w.__perf.fns ??= new Map());
        let fn = fns.get(src);
        if (!fn) fns.set(src, (fn = new Function(`return (${src})`)() as (x: unknown) => boolean));
        if (!fn(a)) return false;
        w.__perf.tDone ??= performance.now();
        return true;
      },
      { src: done.toString(), a: doneArg as unknown },
      { polling: 'raf', timeout: options.timeoutMs ?? 60_000 },
    );
    const { tDone, tFrame, longTasks } = await this.page.evaluate(
      (start) =>
        new Promise<{ tDone: number; tFrame: number; longTasks: LongTask[] }>((resolve) =>
          requestAnimationFrame(() =>
            setTimeout(() => {
              const w = window as unknown as { __perf: { tDone: number; longTasks: LongTask[] } };
              resolve({
                tDone: w.__perf.tDone,
                tFrame: performance.now(),
                longTasks: w.__perf.longTasks.filter((l) => l.start + l.duration >= start),
              });
            }),
          ),
        ),
      t0,
    );
    let summary: { hot: Hot[]; categories: Record<string, number> } = { hot: [], categories: {} };
    if (profile) {
      const { profile: p } = await this.cdp.send('Profiler.stop');
      summary = await this.summarize(p as unknown as CpuProfile);
    }
    const after = await this.metrics();
    const d = (k: string): number => round(((after[k] ?? 0) - (before[k] ?? 0)) * 1000);
    const m: Measurement = {
      name,
      wallMs: round(tDone - t0),
      toFrameMs: round(tFrame - t0),
      scriptMs: d('ScriptDuration'),
      layoutMs: d('LayoutDuration'),
      styleMs: d('RecalcStyleDuration'),
      taskMs: d('TaskDuration'),
      longTasks: longTasks.length,
      longestTaskMs: round(Math.max(0, ...longTasks.map((l) => l.duration))),
      longTaskTotalMs: round(longTasks.reduce((s, l) => s + l.duration, 0)),
      domNodes: await this.page.evaluate(() => document.getElementsByTagName('*').length),
      heapUsedMB: round((after['JSHeapUsedSize'] ?? 0) / 1048576),
      categories: summary.categories,
      hot: summary.hot,
      ...(options.extra ? { extra: await options.extra() } : {}),
    };
    this.results.push(m);
    return m;
  }

  /** Starts a CPU profile and metrics window spanning several actions (e.g. a whole stream). */
  async begin(): Promise<
    () => Promise<{ hot: Hot[]; categories: Record<string, number>; delta: Record<string, number> }>
  > {
    const before = await this.metrics();
    await this.cdp.send('Profiler.start');
    return async () => {
      const { profile } = await this.cdp.send('Profiler.stop');
      const after = await this.metrics();
      const delta: Record<string, number> = {};
      for (const k of Object.keys(after)) delta[k] = (after[k] ?? 0) - (before[k] ?? 0);
      return { ...(await this.summarize(profile as unknown as CpuProfile, 25)), delta };
    };
  }
}

export function round(n: number): number {
  return Math.round(n * 10) / 10;
}
