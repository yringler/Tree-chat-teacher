import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { UiStore } from '../state/ui-store';
import { BranchDialog } from './branch-dialog';
import { BranchSettings } from './branch-settings';
import { DeleteAccountDialog } from './delete-account-dialog';
import { HelpDialog } from './help-dialog';
import { KeysDialog } from './keys-dialog';
import { LinkDialog } from './link-dialog';

/** Renders whichever dialog the UiStore says is open. */
@Component({
  selector: 'app-dialog-host',
  imports: [BranchDialog, BranchSettings, DeleteAccountDialog, HelpDialog, KeysDialog, LinkDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (ui.branchDialog(); as s) {
      <app-branch-dialog [state]="s" />
    }
    @if (ui.branchSettings(); as s) {
      <app-branch-settings [state]="s" />
    }
    @if (ui.linkDialog(); as s) {
      <app-link-dialog [state]="s" />
    }
    @if (ui.keysOpen()) {
      <app-keys-dialog />
    }
    @if (ui.helpOpen()) {
      <app-help-dialog />
    }
    @if (ui.deleteAccountOpen()) {
      <app-delete-account-dialog />
    }
  `,
})
export class DialogHost {
  protected readonly ui = inject(UiStore);
}
