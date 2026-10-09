import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  type OnDestroy,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { describeEndpoint } from '@tangent/core/links';
import {
  endpointTitle,
  Icon,
  PendingQuote,
  SelectionAsk,
  selectedMessageQuote,
  TextSizeMenu,
  TextSizeStore,
  type MessageQuote,
} from '@tangent/web-shared';
import { BRAND } from '../brand';
import { LayoutStore, MAX_ZOOM, MIN_ZOOM } from '../layout/layout-store';
import { CanvasStore } from '../state/canvas-store';
import { UiStore } from '../state/ui-store';
import { Connectors } from './connectors';
import { CrossLinkGlyphs, CrossLinks } from './cross-links';
import { Lane } from './lane';
import { LinkPopover } from './link-popover';
import { Minimap } from './minimap';
import { ResizeFollower } from './resize-follower';
import { laneTitle, treeTitle } from './titles';

/** Wheel without a modifier pans; with Ctrl or ⌘ (and a trackpad pinch) it zooms. */
const WHEEL_ZOOM = 0.0015;
/** The wheel has no "up": the transform animates again once it has been still this long. */
const WHEEL_SETTLE_MS = 150;
/** A touch becomes a pan once it moves this far; until then it may still be a tap. */
const TOUCH_SLOP = 8;
/** A touch held still this long is a long press: left to the browser (text selection). */
const LONG_PRESS_MS = 500;

/** A touch that has not moved past the slop yet: no capture, so taps still click. */
interface PendingTouch {
  x: number;
  y: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * `/t/:treeId[/b/:branchId]`: the whole conversation on one pannable,
 * zoomable surface. Every lane is live at once; the URL names the selected
 * lane, whose lineage (what the model would see) lights up across the map.
 */
@Component({
  selector: 'app-canvas-page',
  imports: [
    Icon,
    RouterLink,
    Connectors,
    CrossLinks,
    CrossLinkGlyphs,
    Lane,
    LinkPopover,
    Minimap,
    SelectionAsk,
    TextSizeMenu,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './canvas-page.html',
  host: {
    class: 'page canvas-page',
    // The cards' and lane composers' text size (styles.css); the lanes re-measure on a change.
    '[style.--chat-font-scale]': 'textSize.scale()',
    '(document:selectionchange)': 'onSelectionChange()',
  },
})
export class CanvasPage implements OnDestroy {
  protected readonly store = inject(CanvasStore);
  protected readonly ui = inject(UiStore);
  protected readonly geo = inject(LayoutStore);
  protected readonly textSize = inject(TextSizeStore);
  private readonly title = inject(Title);
  private readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');
  /**
   * Text selected in a finished card: offers "Ask about this" (a `path` lane
   * quoting it, ready to type) and, by its gear, the branch dialog with the
   * quote filled in (variants, modes, models).
   */
  protected readonly selection = new PendingQuote(() => this.selectedQuote());
  protected readonly asking = signal(false);
  private readonly resize = new ResizeFollower((el) => this.measureViewport(el));
  private fitted = false;
  /** Active pointers, for drag-panning and two-finger pinch. */
  private readonly pointers = new Map<number, { x: number; y: number }>();
  /** Touches (and pens) still deciding between a tap, a pan and a long press. */
  private readonly pending = new Map<number, PendingTouch>();
  private pinchDistance = 0;
  private wheelTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly treeTitle = computed(() => {
    const t = this.store.detail()?.tree.title;
    return t === undefined ? '' : treeTitle(t);
  });
  protected readonly zoomPct = computed(() => Math.round(this.geo.zoom() * 100));
  protected readonly canZoomIn = computed(() => this.geo.zoom() < MAX_ZOOM);
  protected readonly canZoomOut = computed(() => this.geo.zoom() > MIN_ZOOM);
  protected readonly laneCount = computed(() => this.geo.layout().lanes.length);
  protected readonly liveCount = computed(() => this.store.busyBranches().size);
  protected readonly lineage = computed(() =>
    this.ui.lineage() ? this.store.selectedLineage() : null,
  );
  /** "Back to ‘…’", while the lane a link was followed to is still the selected one. */
  protected readonly linkBack = computed(() => {
    const back = this.ui.linkReturn();
    return back && back.toBranchId === this.store.selectedBranchId() ? back : null;
  });
  /** What pick mode links from, as its chip would read. */
  protected readonly pickSource = computed(() => {
    const from = this.ui.linkPick()?.fromNodeId;
    const idx = this.store.index();
    const ep = from && idx ? describeEndpoint(idx, from, laneTitle) : null;
    return ep ? endpointTitle(ep) : '';
  });

  constructor() {
    effect(() => {
      const t = this.treeTitle();
      this.title.setTitle(t ? `${t} · ${BRAND}` : BRAND);
    });

    // A new tree: forget the old measurements and fit once the first layout is in.
    effect(() => {
      this.store.selectedTreeId();
      untracked(() => {
        this.geo.reset();
        this.fitted = false;
      });
    });
    afterRenderEffect(() => {
      const l = this.geo.layout();
      if (this.fitted || l.lanes.length === 0 || this.geo.viewport().width === 0) return;
      // The lanes report their real heights on their first render; fit after that.
      this.fitted = true;
      requestAnimationFrame(() => {
        const selected = untracked(this.store.selectedBranchId);
        const trunk = untracked(this.store.index)?.trunk.id;
        if (selected && selected !== trunk) this.geo.centerOn(selected);
        else this.geo.fitAll();
      });
    });

    // Follow the selection: bring the selected lane (or the focused card) into view.
    let lastKey = '';
    effect(() => {
      const branchId = this.store.selectedBranchId();
      const focus = this.store.focusedNodeId();
      const l = this.geo.layout();
      if (!branchId || l.lanes.length === 0) return;
      const key = `${branchId}|${focus ?? ''}`;
      if (key === lastKey) return;
      lastKey = key;
      untracked(() => {
        this.selection.clear();
        this.ui.expand(this.store.chain().map((b) => b.id));
        // A lane picked with the pointer is already in view, and the gesture
        // that picked it (a drag, a text selection) is still going: stay put.
        const fromPointer = this.geo.consumePointerSelect(branchId);
        if (this.fitted && !fromPointer) {
          requestAnimationFrame(() => this.geo.centerOn(branchId, focus));
        }
      });
    });

    // The lineage of the selected lane, refreshed when its leaf changes or a reply finishes.
    effect(() => {
      const branchId = this.store.selectedBranchId();
      this.store.completions();
      this.store.detail();
      if (!branchId || !this.ui.lineage()) return;
      if (this.store.busyBranches().has(branchId)) return;
      untracked(() => void this.store.loadLineage(branchId));
    });

    // The viewport is re-created when the page comes back from "Loading…" (another tree).
    afterRenderEffect(() => this.resize.follow(this.viewport()?.nativeElement ?? null));
  }

  ngOnDestroy(): void {
    this.selection.destroy();
    clearTimeout(this.wheelTimer);
    this.dropPending();
    this.resize.disconnect();
  }

  private measureViewport(el: Element): void {
    const before = this.geo.viewport();
    this.geo.setViewport({ width: el.clientWidth, height: el.clientHeight });
    // A resized window (or a rotated phone): keep the selected lane in view.
    const selected = this.store.selectedBranchId();
    if (this.fitted && before.width > 0 && before.width !== el.clientWidth && selected) {
      this.geo.centerOn(selected);
    }
  }

  // ---- Pan and zoom

  protected onWheel(e: WheelEvent): void {
    e.preventDefault();
    const el = this.viewport()?.nativeElement;
    if (!el) return;
    this.geo.dragging.set(true);
    clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => {
      if (this.pointers.size === 0) this.geo.dragging.set(false);
    }, WHEEL_SETTLE_MS);
    if (e.ctrlKey || e.metaKey) {
      const rect = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * WHEEL_ZOOM * (e.deltaMode === 1 ? 20 : 1));
      this.geo.zoomAt(factor, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    } else {
      const k = e.deltaMode === 1 ? 20 : 1;
      this.geo.panBy(-e.deltaX * k, -e.deltaY * k);
    }
  }

  protected onPointerDown(e: PointerEvent): void {
    if (e.pointerType !== 'mouse') {
      this.onTouchDown(e);
      return;
    }
    // Only the background and lane chrome pan; text, buttons and boxes keep their own behaviour.
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, a, textarea, input, select, .card-body, .tangents, .anchor'))
      return;
    if (e.button !== 0) return;
    this.capture(e);
  }

  /**
   * Touch and pen: a finger on a card body may be a tap, a pan or a long
   * press, so it waits as pending until it moves past the slop (a pan) or is
   * held still (left to the browser's text selection). A second finger
   * anywhere turns both into a pinch at once.
   */
  private onTouchDown(e: PointerEvent): void {
    if (this.pointers.size > 0 || this.pending.size > 0) {
      for (const [id, p] of [...this.pending]) this.promote(id, p, e.currentTarget);
      this.capture(e);
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, a, textarea, input, select')) return;
    const id = e.pointerId;
    const timer = setTimeout(() => this.pending.delete(id), LONG_PRESS_MS);
    this.pending.set(id, { x: e.clientX, y: e.clientY, timer });
  }

  /** Captures a pointer for panning (a second one starts a pinch). */
  private capture(e: PointerEvent): void {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) this.pinchDistance = this.distance();
    this.geo.dragging.set(true);
  }

  /** A pending touch becomes an active pointer, panning from where it went down. */
  private promote(id: number, p: PendingTouch, viewport: EventTarget | null): void {
    clearTimeout(p.timer);
    this.pending.delete(id);
    try {
      (viewport as HTMLElement | null)?.setPointerCapture(id);
    } catch {
      // The pointer is already gone; its pointerup still arrives and clears it.
    }
    this.pointers.set(id, { x: p.x, y: p.y });
    if (this.pointers.size === 2) this.pinchDistance = this.distance();
    this.geo.dragging.set(true);
  }

  private dropPending(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  protected onPointerMove(e: PointerEvent): void {
    const waiting = this.pending.get(e.pointerId);
    if (waiting) {
      if (Math.hypot(e.clientX - waiting.x, e.clientY - waiting.y) <= TOUCH_SLOP) return;
      this.promote(e.pointerId, waiting, e.currentTarget);
    }
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    this.pointers.set(e.pointerId, cur);
    if (this.pointers.size === 2) {
      const d = this.distance();
      if (this.pinchDistance > 0) {
        const el = this.viewport()?.nativeElement;
        const rect = el?.getBoundingClientRect();
        const pts = [...this.pointers.values()];
        const mid = {
          x: (pts[0]!.x + pts[1]!.x) / 2 - (rect?.left ?? 0),
          y: (pts[0]!.y + pts[1]!.y) / 2 - (rect?.top ?? 0),
        };
        this.geo.zoomAt(d / this.pinchDistance, mid);
      }
      this.pinchDistance = d;
      return;
    }
    this.geo.panBy(cur.x - prev.x, cur.y - prev.y);
  }

  protected onPointerUp(e: PointerEvent): void {
    const waiting = this.pending.get(e.pointerId);
    if (waiting) {
      clearTimeout(waiting.timer);
      this.pending.delete(e.pointerId);
    }
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchDistance = 0;
    if (this.pointers.size === 0) this.geo.dragging.set(false);
  }

  private distance(): number {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
  }

  protected onDoubleClick(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    if (target?.closest('.lane, .xlink-glyph')) return;
    this.geo.fitAll();
  }

  // ---- Branch from a selection

  /** Maps the document selection to one finished message, if it lies inside one. */
  protected onSelectionChange(): void {
    // A touch that started a text selection (long press, handles) is not a pan.
    if (this.pending.size > 0 && window.getSelection()?.isCollapsed === false) this.dropPending();
    this.selection.update();
  }

  /** "Ask about this": a `path` lane off the card, quoting the selection, its box focused. */
  protected async askAbout(q: MessageQuote): Promise<void> {
    if (this.selectionLocked()) {
      this.moreAbout(q);
      return;
    }
    this.selection.clear();
    window.getSelection()?.removeAllRanges();
    this.asking.set(true);
    try {
      await this.store.createBranch({
        fromNodeId: q.nodeId,
        contextMode: 'path',
        anchorQuote: q.quote,
      });
    } finally {
      this.asking.set(false);
    }
  }

  /** The gear: the branch dialog with the quote filled in. */
  protected moreAbout(q: MessageQuote): void {
    this.selection.clear();
    window.getSelection()?.removeAllRanges();
    this.ui.dialogs.open({ kind: 'branch', fromNodeId: q.nodeId, quote: q.quote });
  }

  /**
   * The selection's card is on a lane whose funding needs the membership:
   * only the dialog can pick another route.
   */
  protected readonly selectionLocked = computed(() => {
    const q = this.selection.value();
    const node = q ? this.store.index()?.nodes.get(q.nodeId) : undefined;
    const lane = node ? this.store.index()?.branches.get(node.branchId) : undefined;
    return !!lane && this.store.account.routeLocked(lane);
  });

  private selectedQuote(): MessageQuote | null {
    const found = selectedMessageQuote(this.viewport()?.nativeElement, window.getSelection());
    const node = found ? this.store.index()?.nodes.get(found.nodeId) : undefined;
    return node?.status === 'complete' ? found : null;
  }

  // ---- Links

  protected toggleLinks(): void {
    this.ui.linkPopover.set(null);
    this.ui.showLinks.update((v) => !v);
  }

  /** Pick mode's "Search": the picker dialog instead of clicking a card. */
  protected searchInstead(fromNodeId: string): void {
    this.ui.linkPick.set(null);
    this.ui.dialogs.open({ kind: 'link', fromNodeId });
  }

  protected deleteTree(): void {
    const d = this.store.detail();
    if (!d) return;
    if (!confirm(`Delete “${treeTitle(d.tree.title)}” with all its lanes?`)) return;
    void this.store.deleteTree(d.tree.id);
  }
}
