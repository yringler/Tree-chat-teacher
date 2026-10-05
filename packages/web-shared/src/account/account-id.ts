import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { Icon } from '../ui/icon';

/**
 * The signed-in user's id (`MeResponse.userId`) with a copy button, for the
 * apps' account UI. The operator asks for it to grant something to one
 * account (e.g. publishing share links); it grants nothing by itself.
 * `menu`: the copy button is a menu item (inside a `role="menu"` list).
 */
@Component({
  selector: 'app-account-id',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="field-label">Account ID</span>
    <span class="account-id-row">
      <code class="account-id-value">{{ userId() }}</code>
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        [attr.role]="menu() ? 'menuitem' : null"
        (click)="copy()"
      >
        <app-icon name="copy" [size]="14" /> {{ copied() ? 'Copied' : 'Copy'
        }}<span class="sr-only"> account ID</span>
      </button>
    </span>
    <span class="muted small">Give this to the operator if asked.</span>
  `,
  host: { class: 'account-id' },
})
export class AccountId {
  readonly userId = input.required<string>();
  readonly menu = input(false);
  protected readonly copied = signal(false);

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.userId());
      this.copied.set(true);
    } catch {
      // Clipboard unavailable: the id is shown, so it can still be selected by hand.
    }
  }
}
