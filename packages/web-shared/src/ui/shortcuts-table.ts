import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { ShortcutHelp } from '../core/shortcuts';

/** An app's keyboard shortcuts, for its help dialog. */
@Component({
  selector: 'app-shortcuts-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <table class="shortcuts">
      <tbody>
        @for (s of shortcuts(); track s.label) {
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
  `,
})
export class ShortcutsTable {
  readonly shortcuts = input.required<readonly ShortcutHelp[]>();
}
