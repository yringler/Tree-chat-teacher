import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { describeEndpoint } from '@tangent/core/links';
import { endpointTitle, Icon } from '@tangent/web-shared';
import type { CrossLink } from '../layout/cross-links';
import { LayoutStore } from '../layout/layout-store';
import { CanvasStore } from '../state/canvas-store';
import { UiStore, type LinkDragState } from '../state/ui-store';
import { laneTitle } from './titles';

/** Glyphs keep at least this on-screen size when zoomed out (a factor on their world size). */
const GLYPH_MIN_SCREEN = 0.8;
const GLYPH_MAX_SCALE = 2.5;

/** Shared by both layers: a link touching the selected lane or the focused card is drawn stronger. */
function isOn(
  x: CrossLink,
  selected: string | null,
  focused: string | null,
  open: string | null,
): boolean {
  return (
    x.id === open ||
    x.ends.some((e) => e.branchId === selected || (focused !== null && e.nodeId === focused))
  );
}

/**
 * The lines between linked messages (NodeLink), in world coordinates under
 * the lanes, after the fork connectors. A thin solid line in its own colour
 * (dashes and dots already say "summary", "parent message" and "independent"), stronger where
 * it touches the selected lane or the focused card, dimmed where an end is
 * folded away. Not a hit target: the glyph on top (CrossLinkGlyphs) is.
 */
@Component({
  selector: 'app-cross-links',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let l = geo.layout();
    <svg
      class="xlinks"
      [attr.width]="l.width + 4"
      [attr.height]="l.height + 4"
      [attr.viewBox]="'0 0 ' + (l.width + 4) + ' ' + (l.height + 4)"
      aria-hidden="true"
    >
      @for (x of geo.crossLinks(); track x.id) {
        <path
          class="xlink-path"
          [class.is-on]="on(x)"
          [class.is-folded]="x.ends[0].folded || x.ends[1].folded"
          [attr.data-link-id]="x.id"
          [attr.d]="x.d"
        />
      }
    </svg>
  `,
  host: { class: 'xlinks-host' },
})
export class CrossLinks {
  protected readonly geo = inject(LayoutStore);
  private readonly store = inject(CanvasStore);
  private readonly ui = inject(UiStore);

  protected on(x: CrossLink): boolean {
    return isOn(
      x,
      this.store.selectedBranchId(),
      this.store.focusedNodeId(),
      this.ui.linkPopover()?.linkId ?? null,
    );
  }
}

/**
 * Over the lanes: a glyph halfway along every link (the only hit target; it
 * opens the link's popover) and, while a link is dragged out of a card's
 * port, the rubber band to the pointer.
 */
@Component({
  selector: 'app-cross-link-glyphs',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (ui.linkDrag(); as drag) {
      @let l = geo.layout();
      <svg
        class="xlink-drag"
        [attr.width]="l.width + 4"
        [attr.height]="l.height + 4"
        aria-hidden="true"
      >
        <path
          class="xlink-rubber"
          [class.is-over]="drag.overNodeId !== null"
          [attr.d]="band(drag)"
        />
        <circle class="xlink-rubber-end" [attr.cx]="drag.to.x" [attr.cy]="drag.to.y" r="5" />
      </svg>
    }
    @for (x of geo.crossLinks(); track x.id) {
      @let open = ui.linkPopover()?.linkId === x.id;
      <button
        type="button"
        class="xlink-glyph"
        [class.is-on]="on(x)"
        [class.is-folded]="x.ends[0].folded || x.ends[1].folded"
        [class.has-note]="x.link.note !== null"
        [style.left.px]="x.mid.x"
        [style.top.px]="x.mid.y"
        [attr.data-link-id]="x.id"
        [attr.aria-label]="labels().get(x.id) ?? 'Link'"
        [attr.aria-expanded]="open"
        [title]="labels().get(x.id) ?? 'Link'"
        (click)="toggle(x.id, $event)"
      >
        <app-icon name="link" [size]="12" />
      </button>
    }
  `,
  host: { class: 'xlink-glyphs-host', '[style.--glyph-scale]': 'glyphScale()' },
})
export class CrossLinkGlyphs {
  protected readonly geo = inject(LayoutStore);
  protected readonly ui = inject(UiStore);
  private readonly store = inject(CanvasStore);

  /** Zoomed far out, glyphs grow back towards a size that can still be clicked. */
  protected readonly glyphScale = computed(() =>
    Math.min(GLYPH_MAX_SCALE, Math.max(1, GLYPH_MIN_SCREEN / this.geo.zoom())),
  );

  /** "Link: ‹one end› ↔ ‹the other›", for each drawn link. */
  protected readonly labels = computed(() => {
    const idx = this.store.index();
    const out = new Map<string, string>();
    if (!idx) return out;
    for (const x of this.geo.crossLinks()) {
      const [a, b] = x.ends.map((e) => {
        const ep = describeEndpoint(idx, e.nodeId, laneTitle);
        return ep ? endpointTitle(ep) : 'a message';
      });
      out.set(x.id, `Link: ${a} ↔ ${b}`);
    }
    return out;
  });

  protected on(x: CrossLink): boolean {
    return isOn(
      x,
      this.store.selectedBranchId(),
      this.store.focusedNodeId(),
      this.ui.linkPopover()?.linkId ?? null,
    );
  }

  protected toggle(linkId: string, e: Event): void {
    e.stopPropagation();
    this.ui.linkPopover.set(this.ui.linkPopover()?.linkId === linkId ? null : { linkId });
  }

  protected band(drag: LinkDragState): string {
    const { from, to } = drag;
    const dx = Math.max(24, Math.abs(to.x - from.x) / 2) * (to.x < from.x ? -1 : 1);
    return `M ${from.x} ${from.y} C ${from.x + Math.abs(dx)} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
  }
}
