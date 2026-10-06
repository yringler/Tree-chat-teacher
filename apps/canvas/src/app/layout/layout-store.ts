import { computed, inject, Injectable, signal, untracked } from '@angular/core';
import { CanvasStore } from '../state/canvas-store';
import { UiStore } from '../state/ui-store';
import { crossLinkGeometry, type CrossLink } from './cross-links';
import {
  DEFAULT_LAYOUT,
  layoutTree,
  type LaneMeasure,
  type LanePlacement,
  type Layout,
} from './layout';

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.12;
export const MAX_ZOOM = 1.6;
/** Padding around the whole tree when fitting it into the viewport. */
const FIT_PADDING = 48;

const EMPTY_LAYOUT: Layout = { lanes: [], byId: new Map(), connectors: [], width: 0, height: 0 };

/**
 * The geometry of the open tree: where every lane sits (from `layoutTree`
 * over the lanes' measured heights) and the viewport's pan and zoom. Screen
 * = pan + world × zoom.
 */
@Injectable({ providedIn: 'root' })
export class LayoutStore {
  private readonly store = inject(CanvasStore);
  private readonly ui = inject(UiStore);

  readonly options = DEFAULT_LAYOUT;
  /** Measured lane sizes, reported by the lane components after each render. */
  private readonly measures = signal<ReadonlyMap<string, LaneMeasure>>(new Map());
  readonly pan = signal<Point>({ x: 0, y: 0 });
  readonly zoom = signal(1);
  readonly viewport = signal<Size>({ width: 0, height: 0 });
  /** True while the user drags or wheels, so the transform doesn't animate. */
  readonly dragging = signal(false);
  /** Bumped when a move should animate (fit, centre on a lane). */
  readonly smooth = signal(0);
  /**
   * The lane a pointer down just selected. Following that selection would
   * zoom and slide the lane away under a starting drag or text selection, so
   * the page leaves the camera alone for it (see `consumePointerSelect`).
   */
  pointerSelect: string | null = null;

  readonly layout = computed<Layout>(() => {
    const idx = this.store.index();
    if (!idx) return EMPTY_LAYOUT;
    return layoutTree(idx, this.measures(), this.ui.collapsed(), this.options);
  });

  /** The lines between linked messages, when shown (`ui.showLinks`). */
  readonly crossLinks = computed<CrossLink[]>(() => {
    const idx = this.store.index();
    const links = this.store.links();
    if (!idx || links.length === 0 || !this.ui.showLinks()) return [];
    return crossLinkGeometry(
      idx,
      this.layout(),
      links,
      (branchId, nodeId) => this.cardOf(branchId, nodeId),
      this.options.headAnchor,
    );
  });

  readonly transform = computed(() => {
    const p = this.pan();
    const z = this.zoom();
    return `translate(${p.x}px, ${p.y}px) scale(${z})`;
  });

  /** Called by a lane whenever its box changes. */
  measured(branchId: string, measure: LaneMeasure): void {
    const cur = this.measures().get(branchId);
    if (cur && sameMeasure(cur, measure)) return;
    this.measures.update((m) => new Map(m).set(branchId, measure));
  }

  forget(branchId: string): void {
    if (!this.measures().has(branchId)) return;
    this.measures.update((m) => {
      const next = new Map(m);
      next.delete(branchId);
      return next;
    });
  }

  /** Forgets every measurement (a new tree is opening). */
  reset(): void {
    this.measures.set(new Map());
  }

  cardOf(branchId: string, nodeId: string): { top: number; height: number } | null {
    return this.measures().get(branchId)?.cards.get(nodeId) ?? null;
  }

  /**
   * True when the selection of `id` came from a pointer down on its lane.
   * Always resets, so a later selection (a fork chip clicked in that lane, the
   * keyboard) centres again.
   */
  consumePointerSelect(id: string): boolean {
    const fromPointer = this.pointerSelect === id;
    this.pointerSelect = null;
    return fromPointer;
  }

  // ---- The viewport

  setViewport(size: Size): void {
    const cur = this.viewport();
    if (cur.width !== size.width || cur.height !== size.height) this.viewport.set(size);
  }

  panBy(dx: number, dy: number): void {
    this.pan.update((p) => ({ x: p.x + dx, y: p.y + dy }));
  }

  /** Zooms by `factor` keeping the screen point `at` fixed. */
  zoomAt(factor: number, at: Point): void {
    const z0 = this.zoom();
    const z1 = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z0 * factor));
    if (z1 === z0) return;
    const p = this.pan();
    // The world point under the cursor stays put: at = pan + w·z for both zooms.
    const wx = (at.x - p.x) / z0;
    const wy = (at.y - p.y) / z0;
    this.zoom.set(z1);
    this.pan.set({ x: at.x - wx * z1, y: at.y - wy * z1 });
  }

  zoomStep(direction: 1 | -1): void {
    const v = this.viewport();
    this.animate();
    this.zoomAt(direction > 0 ? 1.25 : 0.8, { x: v.width / 2, y: v.height / 2 });
  }

  /** The whole tree in view (zoomed out to at most 1:1). */
  fitAll(): void {
    const l = untracked(this.layout);
    const v = untracked(this.viewport);
    if (l.lanes.length === 0 || v.width === 0) return;
    const z = Math.min(
      1,
      (v.width - 2 * FIT_PADDING) / Math.max(1, l.width),
      (v.height - 2 * FIT_PADDING) / Math.max(1, l.height),
    );
    const zoom = Math.max(MIN_ZOOM, z);
    this.animate();
    this.zoom.set(zoom);
    this.pan.set({
      x: (v.width - l.width * zoom) / 2,
      y: Math.max(FIT_PADDING, (v.height - l.height * zoom) / 2),
    });
  }

  /** Brings a lane into view: its head near the top, centred horizontally, at a readable zoom. */
  centerOn(branchId: string, nodeId: string | null = null): void {
    const lane = untracked(this.layout).byId.get(branchId);
    const v = untracked(this.viewport);
    if (!lane || v.width === 0) return;
    const zoom = Math.max(untracked(this.zoom), 0.7);
    const card = nodeId ? this.cardOf(branchId, nodeId) : null;
    const worldX = lane.x + lane.width / 2;
    const worldY = card ? lane.y + card.top + card.height / 2 : lane.y + 20;
    this.animate();
    this.zoom.set(zoom);
    this.pan.set({
      x: v.width / 2 - worldX * zoom,
      y: card ? v.height / 2 - worldY * zoom : FIT_PADDING - worldY * zoom + 20,
    });
  }

  /** The world point under a point of the viewport (relative to its top left). */
  toWorld(at: Point): Point {
    const p = untracked(this.pan);
    const z = untracked(this.zoom);
    return { x: (at.x - p.x) / z, y: (at.y - p.y) / z };
  }

  /** Where a world point is in the viewport (relative to its top left). */
  toScreen(world: Point): Point {
    const p = this.pan();
    const z = this.zoom();
    return { x: p.x + world.x * z, y: p.y + world.y * z };
  }

  /** Centres the viewport on a world point (the minimap). */
  centerWorld(point: Point): void {
    const v = untracked(this.viewport);
    const z = untracked(this.zoom);
    this.animate();
    this.pan.set({ x: v.width / 2 - point.x * z, y: v.height / 2 - point.y * z });
  }

  /** True when any part of the lane is on screen. */
  isVisible(lane: LanePlacement): boolean {
    const p = this.pan();
    const z = this.zoom();
    const v = this.viewport();
    const left = p.x + lane.x * z;
    const top = p.y + lane.y * z;
    return (
      left < v.width && top < v.height && left + lane.width * z > 0 && top + lane.height * z > 0
    );
  }

  private animate(): void {
    this.dragging.set(false);
    this.smooth.update((n) => n + 1);
  }
}

function sameMeasure(a: LaneMeasure, b: LaneMeasure): boolean {
  if (a.height !== b.height || a.cards.size !== b.cards.size) return false;
  for (const [id, c] of b.cards) {
    const o = a.cards.get(id);
    if (!o || o.top !== c.top || o.height !== c.height) return false;
  }
  return true;
}
