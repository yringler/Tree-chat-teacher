import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { POOL_NOTICE_TEXT, POOL_NOTICE_VERSION } from '@tangent/shared';
import { Modal } from '../ui/modal';

/**
 * Before an account's first pool use, one of two steps (whichever the pool
 * asked for):
 *
 * - `consentVersion` null: the human check, when the account has none on
 *   record (403 `pool_unavailable`, reason `verify`: accounts from before the
 *   check at sign-in). Continue goes to the Worker's `/verify` page, which
 *   runs Turnstile and comes back here; the apps' own CSP doesn't load
 *   Turnstile.
 * - `consentVersion` set: the pool notice (403 `pool_consent_required`, again
 *   after every new version of its text). Acknowledging needs the checkbox; the
 *   app records the version of the text shown (this build's
 *   `POOL_NOTICE_VERSION`, never the server's number) and sends the message
 *   again. When the server asks for another version than the one bundled
 *   here, this page's copy of the text is stale: the dialog says to reload
 *   instead of offering the checkbox.
 */
@Component({
  selector: 'app-pool-first-use-dialog',
  imports: [Modal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (consentVersion() === null) {
      <app-modal heading="One quick check" (closed)="closed.emit()">
        <p>
          The open pool is for learners, so before your first message on it we check that you're a
          person, not a script. It takes a few seconds, once.
        </p>
        <p class="muted small">
          You come back to this lesson afterwards; then send your message again.
        </p>
        <div class="form-actions">
          <button type="button" class="btn btn-ghost" (click)="closed.emit()">Not now</button>
          <a class="btn btn-primary" [href]="verifyHref">Continue</a>
        </div>
      </app-modal>
    } @else if (stale()) {
      <app-modal heading="The open pool notice has changed" (closed)="closed.emit()">
        <p>Reload the page to read the new notice before your next message on the pool.</p>
        <div class="form-actions">
          <button type="button" class="btn btn-ghost" (click)="closed.emit()">Not now</button>
          <button type="button" class="btn btn-primary" (click)="reload()">Reload</button>
        </div>
      </app-modal>
    } @else {
      <app-modal heading="Before you use the open pool" (closed)="closed.emit()">
        <p>{{ noticeText }}</p>
        <label class="check">
          <input
            type="checkbox"
            name="pool-notice"
            [checked]="understood()"
            (change)="understood.set(!understood())"
          />
          I understand
        </label>
        <div class="form-actions">
          <button type="button" class="btn btn-ghost" (click)="closed.emit()">Not now</button>
          <button
            type="button"
            class="btn btn-primary"
            [disabled]="!understood() || busy()"
            (click)="acknowledge()"
          >
            Continue
          </button>
        </div>
      </app-modal>
    }
  `,
})
export class PoolFirstUseDialog {
  /** The pool notice version the server asks for; null = the human check instead. */
  readonly consentVersion = input<number | null>(null);
  /** Set while the acknowledgment is being recorded. */
  readonly busy = input(false);
  readonly closed = output();
  /** The user acknowledged the notice text shown (`POOL_NOTICE_VERSION`). */
  readonly acknowledged = output();
  protected readonly noticeText = POOL_NOTICE_TEXT;
  /** The server wants a version of the notice this build doesn't carry. */
  protected readonly stale = computed(() => {
    const version = this.consentVersion();
    return version !== null && version !== POOL_NOTICE_VERSION;
  });
  protected readonly understood = signal(false);
  /** The Worker's Turnstile page, back to this exact page afterwards. */
  protected readonly verifyHref = poolVerifyHref(location.pathname + location.search);

  protected acknowledge(): void {
    if (this.consentVersion() !== null && !this.stale() && this.understood())
      this.acknowledged.emit();
  }

  protected reload(): void {
    location.reload();
  }
}

/** `/verify?next=<path>`: the check, then back to `path` (same-origin; checked by the Worker). */
export function poolVerifyHref(path: string): string {
  return `/verify?next=${encodeURIComponent(path)}`;
}
