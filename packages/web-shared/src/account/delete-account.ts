import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { ApiClient, errorMessage } from '../core/api-client';
import { Icon } from '../ui/icon';

/** Where the browser goes once the account is gone: the public landing page. */
const AFTER_DELETE_URL = '/welcome';

/**
 * Permanent account deletion (`DELETE /api/account`), for both apps' account
 * UI. The user retypes their email to confirm, which the server checks too.
 * Afterwards the session is gone, so the page leaves the app with a full load.
 */
@Component({
  selector: 'app-delete-account',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="small">
      Permanently deletes your account in both Power and Learn: every conversation, share link and
      setting, your passkeys and sign-in, and your customer record with our payment provider (named
      in the Privacy Policy), which cancels your membership. Unused credit is lost. This can't be
      undone, so download backups of anything you want to keep first.
    </p>
    <p class="muted small">
      Payment records are kept as tax law requires, and open pool records so that its daily limits
      hold; see the <a href="/privacy" target="_blank" rel="noopener">privacy policy</a>.
    </p>
    <form class="form" (submit)="$event.preventDefault(); remove()">
      <label class="field">
        <span class="field-label">To confirm, type your email: {{ email() }}</span>
        <input
          type="email"
          autocomplete="off"
          spellcheck="false"
          [value]="typed()"
          (input)="typed.set($any($event.target).value)"
        />
      </label>
      <div class="form-actions">
        <button type="submit" class="btn btn-danger" [disabled]="!canDelete()">
          <app-icon name="trash" [size]="14" /> {{ busy() ? 'Deleting…' : 'Delete my account' }}
        </button>
      </div>
    </form>
    @if (error(); as e) {
      <p class="notice notice-error" role="alert">{{ e }}</p>
    }
  `,
})
export class DeleteAccount {
  private readonly api = inject(ApiClient);

  /** The signed-in user's email, which must be typed to confirm. */
  readonly email = input.required<string>();

  protected readonly typed = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly canDelete = computed(
    () => !this.busy() && this.typed().trim().toLowerCase() === this.email().toLowerCase(),
  );

  protected async remove(): Promise<void> {
    if (!this.canDelete()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.deleteAccount(this.typed().trim());
      location.assign(AFTER_DELETE_URL);
    } catch (err) {
      this.error.set(errorMessage(err));
      this.busy.set(false);
    }
  }
}
