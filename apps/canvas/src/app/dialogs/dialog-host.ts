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

/** Renders whichever dialog the UiStore says is open. */
@Component({
  selector: 'app-dialog-host',
  imports: [BranchDialog, BranchSettings, DeleteAccountDialog, HelpDialog, KeysDialog, LinkDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (ui.dialogs.get('branch'); as s) {
      <app-branch-dialog [state]="s" />
    }
    @if (ui.dialogs.get('branch-settings'); as s) {
      <app-branch-settings [state]="s" />
    }
    @if (ui.dialogs.get('link'); as s) {
      <app-link-dialog [state]="s" />
    }
    @if (ui.dialogs.isOpen('keys')) {
      <!-- Billing is the power app's page. -->
      <app-keys-dialog
        noun="lane"
        [titleOf]="laneTitle"
        [initialProvider]="(store.blockedBranch() ?? store.selectedBranch())?.providerId ?? null"
        billingHref="/billing"
        (closed)="ui.dialogs.close('keys')"
      />
    }
    @if (ui.dialogs.isOpen('help')) {
      <app-help-dialog />
    }
    @if (ui.dialogs.isOpen('delete-account')) {
      <app-delete-account-dialog />
    }
  `,
})
export class DialogHost {
  protected readonly ui = inject(UiStore);
  protected readonly store = inject(CanvasStore);
  protected readonly laneTitle = laneTitle;
}
