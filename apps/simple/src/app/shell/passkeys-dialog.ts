import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, type OnInit, signal } from '@angular/core';
import {
  AuthService,
  errorMessage,
  Icon,
  Modal,
  ToastStore,
  type PasskeyInfo,
} from '@tangent/web-shared';
import { AccountStore } from '../state/account-store';
import { UiStore } from '../state/ui-store';

/** The account's passkeys: list, add, remove. */
@Component({
  selector: 'app-passkeys-dialog',
  imports: [Modal, Icon, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="Passkeys" (closed)="close()">
      @if (account.me()?.devMode) {
        <p class="notice">Sign-in is disabled on this server (DEV_ALLOW_NO_AUTH).</p>
      } @else {
        <p class="muted small">
          Sign in with your fingerprint, face or device PIN instead of an email link. Add one on
          each device you use.
        </p>
        @if (passkeys(); as list) {
          @if (list.length === 0) {
            <p class="small">No passkeys yet.</p>
          }
          <ul class="key-list">
            @for (p of list; track p.id) {
              <li class="key-row">
                <span class="key-name">{{ p.name || 'Passkey' }}</span>
                @if (p.createdAt) {
                  <span class="muted small">added {{ p.createdAt | date: 'mediumDate' }}</span>
                }
                <button
                  type="button"
                  class="btn btn-danger-ghost btn-sm"
                  [disabled]="busy()"
                  [attr.aria-label]="'Remove ' + (p.name || 'passkey')"
                  (click)="remove(p)"
                >
                  <app-icon name="trash" [size]="14" /> Remove
                </button>
              </li>
            }
          </ul>
        } @else {
          <p class="muted small">Loading…</p>
        }
        <form
          class="field-row"
          (submit)="$event.preventDefault(); add(nameInput.value); nameInput.value = ''"
        >
          <input
            #nameInput
            type="text"
            maxlength="60"
            placeholder="Name (e.g. Phone)"
            aria-label="Passkey name"
          />
          <button type="submit" class="btn btn-sm" [disabled]="busy()">
            <app-icon name="plus" [size]="14" /> Add a passkey
          </button>
        </form>
        @if (error(); as e) {
          <p class="notice notice-error" role="alert">{{ e }}</p>
        }
      }
    </app-modal>
  `,
})
export class PasskeysDialog implements OnInit {
  protected readonly account = inject(AccountStore);
  private readonly ui = inject(UiStore);
  private readonly toast = inject(ToastStore);
  private readonly auth = inject(AuthService);

  protected readonly passkeys = signal<PasskeyInfo[] | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    if (!this.account.me()?.devMode) void this.reload();
  }

  protected close(): void {
    this.ui.passkeysOpen.set(false);
  }

  protected async add(name: string): Promise<void> {
    await this.run(async () => {
      const message = await this.auth.addPasskey(name.trim());
      if (message) return message;
      this.toast.notify('Passkey added');
      await this.reload();
      return null;
    });
  }

  protected async remove(p: PasskeyInfo): Promise<void> {
    if (
      !confirm(`Remove the passkey "${p.name || 'Passkey'}"? You can't sign in with it afterwards.`)
    )
      return;
    await this.run(async () => {
      const message = await this.auth.deletePasskey(p.id);
      if (message) return message;
      await this.reload();
      return null;
    });
  }

  private async reload(): Promise<void> {
    try {
      this.passkeys.set(await this.auth.listPasskeys());
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  private async run(step: () => Promise<string | null>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const message = await step();
      if (message) this.error.set(message);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
