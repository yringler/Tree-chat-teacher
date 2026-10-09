import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Modal } from '@tangent/web-shared';
import { SHORTCUTS } from '../core/keyboard';
import { UiStore } from '../state/ui-store';

/** How to read the canvas, and the keyboard. */
@Component({
  selector: 'app-help-dialog',
  imports: [Modal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="Reading the canvas" (closed)="close()">
      <dl class="legend">
        <dt><span class="legend-line legend-path"></span></dt>
        <dd>
          <strong>Full path.</strong> The lane inherits everything its parent had at the fork.
        </dd>
        <dt><span class="legend-line legend-summary"></span></dt>
        <dd>
          <strong>Summary.</strong> The lane inherits a generated summary of the parent context.
        </dd>
        <dt><span class="legend-line legend-message"></span></dt>
        <dd>
          <strong>Parent message.</strong> Only the message it forks from and the quote come along.
        </dd>
        <dt><span class="legend-line legend-independent"></span></dt>
        <dd>
          <strong>Independent.</strong> The cut marks a fresh start: only the quote comes along.
        </dd>
        <dt>
          <span class="legend-xlink"><span class="legend-xlink-glyph"></span></span>
        </dt>
        <dd>
          <strong>Link.</strong> Two related messages you linked, anywhere on the map. Click the dot
          halfway to go to either end, edit the note or remove it.
        </dd>
        <dt><span class="legend-card legend-lit"></span></dt>
        <dd>
          <strong>Lit card.</strong> With Lineage on, the model would read this message as is.
        </dd>
        <dt><span class="legend-card legend-sum"></span></dt>
        <dd><strong>In summary.</strong> It reaches the model only through a summary.</dd>
        <dt><span class="legend-card legend-dim"></span></dt>
        <dd><strong>Dimmed.</strong> Not sent for the selected lane at all.</dd>
      </dl>
      <p class="muted small">
        Every lane has its own message box and can stream at the same time as the others. The branch
        button on a card opens one lane, or several variants at once: the same question on different
        models or with different context, answered side by side. To link two messages, drag the port
        on a card's right edge onto the other card, or click it (or press R) and pick one.
      </p>
      <h3 class="help-heading">Keyboard</h3>
      <table class="shortcuts">
        <tbody>
          @for (s of shortcuts; track s.label) {
            <tr>
              <td>
                @for (k of s.keys; track k; let last = $last) {
                  <kbd>{{ k }}</kbd>
                  @if (!last) {
                    <span class="muted"> / </span>
                  }
                }
              </td>
              <td>{{ s.label }}</td>
            </tr>
          }
        </tbody>
      </table>
      <p class="muted small">
        Drag the background or scroll to pan; hold Ctrl (⌘ on a Mac) while scrolling, or pinch, to
        zoom. Double-click the background to fit everything.
      </p>
    </app-modal>
  `,
})
export class HelpDialog {
  private readonly ui = inject(UiStore);
  protected readonly shortcuts = SHORTCUTS;

  protected close(): void {
    this.ui.dialogs.close('help');
  }
}
