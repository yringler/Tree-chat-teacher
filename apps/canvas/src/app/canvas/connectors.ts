import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import type { Layout } from '../layout/layout';
import { CanvasStore } from '../state/canvas-store';

/**
 * The curves from each fork card to the lane that hangs off it, drawn in
 * world coordinates under the lanes. Their stroke says how the child inherits
 * context: solid for the full path, dashed for a summary, dash-dot for the
 * parent message only, dotted (and cut short of the lane) for an independent
 * lane. Curves on the selected lane's
 * ancestry are stronger.
 */
@Component({
  selector: 'app-connectors',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      class="connectors"
      [attr.width]="layout().width + 4"
      [attr.height]="layout().height + 4"
      [attr.viewBox]="'0 0 ' + (layout().width + 4) + ' ' + (layout().height + 4)"
      aria-hidden="true"
    >
      @for (c of layout().connectors; track c.childId) {
        @let on = store.chainIds().has(c.childId);
        <path class="link link-{{ c.mode }}" [class.is-on]="on" [attr.d]="c.d" />
        <circle class="fork" [class.is-on]="on" [attr.cx]="c.from.x" [attr.cy]="c.from.y" r="4" />
        @if (c.mode === 'independent') {
          <path
            class="cut"
            [attr.d]="
              'M ' +
              (c.to.x - 14) +
              ' ' +
              (c.to.y - 7) +
              ' l 6 14 M ' +
              (c.to.x - 20) +
              ' ' +
              (c.to.y - 7) +
              ' l 6 14'
            "
          />
        }
      }
    </svg>
  `,
  host: { class: 'connectors-host' },
})
export class Connectors {
  protected readonly store = inject(CanvasStore);
  readonly layout = input.required<Layout>();
}
