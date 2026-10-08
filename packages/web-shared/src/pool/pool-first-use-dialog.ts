import { ChangeDetectionStrategy, Component, output } from '@angular/core';
import { Modal } from '../ui/modal';

/**
 * Before an account's first pool use, the human check, when the account has
 * none on record (403 `pool_unavailable`, reason `verify`: accounts from
 * before the check at sign-in). Continue goes to the Worker's `/verify` page,
 * which runs Turnstile and comes back here; the apps' own CSP doesn't load
 * Turnstile.
 */
@Component({
  selector: 'app-pool-first-use-dialog',
  imports: [Modal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
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
  `,
})
export class PoolFirstUseDialog {
  readonly closed = output();
  /** The Worker's Turnstile page, back to this exact page afterwards. */
  protected readonly verifyHref = poolVerifyHref(location.pathname + location.search);
}

/** `/verify?next=<path>`: the check, then back to `path` (same-origin; checked by the Worker). */
export function poolVerifyHref(path: string): string {
  return `/verify?next=${encodeURIComponent(path)}`;
}
