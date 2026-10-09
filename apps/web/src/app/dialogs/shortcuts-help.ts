import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SHORTCUTS } from '../core/keyboard';
import { UiStore } from '../state/ui-store';
import { Modal } from '@tangent/web-shared';

@Component({
  selector: 'app-shortcuts-help',
  imports: [Modal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="Keyboard shortcuts" (closed)="ui.dialogs.close('shortcuts')">
      <table class="shortcuts">
        <tbody>
          @for (s of shortcuts; track s.label) {
            <tr>
              <td>
                @for (k of s.keys; track k; let last = $last) {
                  <kbd>{{ k }}</kbd
                  >{{ last ? '' : ' ' }}
                }
              </td>
              <td>{{ s.label }}</td>
            </tr>
          }
        </tbody>
      </table>
      <p class="muted small">Shortcuts are ignored while you type in a field (except Esc).</p>
    </app-modal>
  `,
})
export class ShortcutsHelp {
  protected readonly ui = inject(UiStore);
  protected readonly shortcuts = SHORTCUTS;
}
