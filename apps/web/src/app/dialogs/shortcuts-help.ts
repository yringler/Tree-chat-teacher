import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SHORTCUTS } from '../core/keyboard';
import { UiStore } from '../state/ui-store';
import { Modal, ShortcutsTable } from '@tangent/web-shared';

@Component({
  selector: 'app-shortcuts-help',
  imports: [Modal, ShortcutsTable],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="Keyboard shortcuts" (closed)="ui.dialogs.close('shortcuts')">
      <app-shortcuts-table [shortcuts]="shortcuts" />
    </app-modal>
  `,
})
export class ShortcutsHelp {
  protected readonly ui = inject(UiStore);
  protected readonly shortcuts = SHORTCUTS;
}
