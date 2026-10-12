import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DeleteAccount, Icon } from '@tangent/web-shared';
import { AccountStore } from '../state/account-store';

/**
 * `/learn/delete-account`: account deletion as a page of its own, where the
 * short `/delete-account` link lands (app stores ask for a URL that deletes
 * an account). The account menu's dialog shows the same form.
 */
@Component({
  selector: 'app-delete-account-page',
  imports: [DeleteAccount, Icon, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-body">
      <a class="link-btn" routerLink="/"
        ><app-icon name="back" [size]="14" /> Back to your lessons</a
      >
      <section class="card" aria-labelledby="delete-account-title">
        <h1 id="delete-account-title">Delete account</h1>
        @if (account.me()?.email; as email) {
          <app-delete-account [email]="email" />
        } @else {
          <p class="notice">
            Sign-in is disabled on this server, so there is no account to delete.
          </p>
        }
      </section>
    </div>
  `,
})
export class DeleteAccountPage {
  protected readonly account = inject(AccountStore);
}
