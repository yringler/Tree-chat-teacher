import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DeleteAccount, Modal } from '@tangent/web-shared';
import { AccountStore } from '../state/account-store';
import { UiStore } from '../state/ui-store';

/** Permanent account deletion (both apps' accounts), from the account menu. */
@Component({
  selector: 'app-delete-account-dialog',
  imports: [Modal, DeleteAccount],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="Delete account" (closed)="ui.dialogs.close('delete-account')">
      @if (account.me()?.email; as email) {
        <app-delete-account [email]="email" />
      } @else {
        <p class="notice">Sign-in is disabled on this server, so there is no account to delete.</p>
      }
    </app-modal>
  `,
})
export class DeleteAccountDialog {
  protected readonly account = inject(AccountStore);
  protected readonly ui = inject(UiStore);
}
