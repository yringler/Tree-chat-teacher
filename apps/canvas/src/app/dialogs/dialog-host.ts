import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { KeysDialog } from '@tangent/web-shared';
import { laneTitle } from '../canvas/titles';
import { CanvasStore } from '../state/canvas-store';
import { UiStore } from '../state/ui-store';
import { BranchDialog } from './branch-dialog';
import { BranchSettings } from './branch-settings';
import { DeleteAccountDialog } from './delete-account-dialog';
import { HelpDialog } from './help-dialog';
import { LinkDialog } from './link-dialog';

/** Renders the dialogs the UiStore says are open, the top-most last. */
@Component({
  selector: 'app-dialog-host',
  imports: [BranchDialog, BranchSettings, DeleteAccountDialog, HelpDialog, KeysDialog, LinkDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- In stack order: the dialog opened last is on top, and Escape closes it. -->
    @for (d of ui.dialogs.list(); track d.kind) {
      @switch (d.kind) {
        @case ('branch') {
          <app-branch-dialog [state]="d" />
        }
        @case ('branch-settings') {
          <app-branch-settings [state]="d" />
        }
        @case ('link') {
          <app-link-dialog [state]="d" />
        }
        @case ('keys') {
          <!-- Billing is the power app's page. -->
          <app-keys-dialog
            noun="lane"
            [titleOf]="laneTitle"
            [initialProvider]="
              (store.blockedBranch() ?? store.selectedBranch())?.providerId ?? null
            "
            billingHref="/billing"
            (closed)="ui.dialogs.close('keys')"
          />
        }
        @case ('help') {
          <app-help-dialog />
        }
        @case ('delete-account') {
          <app-delete-account-dialog />
        }
      }
    }
  `,
})
export class DialogHost {
  protected readonly ui = inject(UiStore);
  protected readonly store = inject(CanvasStore);
  protected readonly laneTitle = laneTitle;
}
