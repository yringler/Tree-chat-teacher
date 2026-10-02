import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LayoutStore } from '../layout/layout-store';
import { CanvasStore } from '../state/canvas-store';

const W = 200;
const H = 132;
const PAD = 6;

/** The whole tree at a glance, with the viewport drawn over it. Click to go there. */
@Component({
  selector: 'app-minimap',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      class="minimap"
      [attr.width]="w"
      [attr.height]="h"
      [attr.viewBox]="'0 0 ' + w + ' ' + h"
      role="img"
      aria-label="Map of the canvas"
      (click)="jump($event)"
    >
      @for (l of lanes(); track l.id) {
        <rect
          class="mini-lane mode-fill-{{ l.mode }}"
          [class.is-selected]="l.selected"
          [class.is-chain]="l.chain"
          [attr.x]="l.x"
          [attr.y]="l.y"
          [attr.width]="l.w"
          [attr.height]="l.h"
          rx="2"
        />
      }
      <rect
        class="mini-view"
        [attr.x]="view().x"
        [attr.y]="view().y"
        [attr.width]="view().w"
        [attr.height]="view().h"
      />
    </svg>
  `,
  host: { class: 'minimap-host' },
})
export class Minimap {
  private readonly layoutStore = inject(LayoutStore);
  private readonly store = inject(CanvasStore);
  protected readonly w = W;
  protected readonly h = H;

  /** World → minimap scale, fitting the tree in the box. */
  private readonly scale = computed(() => {
    const l = this.layoutStore.layout();
    return Math.min((W - 2 * PAD) / Math.max(1, l.width), (H - 2 * PAD) / Math.max(1, l.height));
  });

  protected readonly lanes = computed(() => {
    const s = this.scale();
    const selected = this.store.selectedBranchId();
    const chain = this.store.chainIds();
    return this.layoutStore.layout().lanes.map((l) => ({
      id: l.branch.id,
      mode: l.branch.contextMode,
      x: PAD + l.x * s,
      y: PAD + l.y * s,
      w: Math.max(2, l.width * s),
      h: Math.max(2, l.height * s),
      selected: l.branch.id === selected,
      chain: chain.has(l.branch.id),
    }));
  });

  protected readonly view = computed(() => {
    const s = this.scale();
    const p = this.layoutStore.pan();
    const z = this.layoutStore.zoom();
    const v = this.layoutStore.viewport();
    return {
      x: PAD + (-p.x / z) * s,
      y: PAD + (-p.y / z) * s,
      w: (v.width / z) * s,
      h: (v.height / z) * s,
    };
  });

  protected jump(e: MouseEvent): void {
    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const s = this.scale();
    const x = (e.clientX - rect.left - PAD) / s;
    const y = (e.clientY - rect.top - PAD) / s;
    this.layoutStore.centerWorld({ x, y });
  }
}
