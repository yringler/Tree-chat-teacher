import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { Icon } from './icon';

/** Where this browser keeps when the beta notice was last closed (epoch ms). */
const DISMISSED_KEY = 'tangent.betaNoticeDismissedAt';

/** How long a closed notice stays closed: it comes back once a day. */
export const BETA_NOTICE_SNOOZE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the notice shows, given when it was last closed. A missing, garbled
 * or future time shows it: the worst case is one extra close.
 */
export function betaNoticeDue(dismissedAt: string | null, now: number): boolean {
  if (dismissedAt === null) return true;
  const at = Number(dismissedAt);
  if (!Number.isFinite(at) || at > now) return true;
  return now - at >= BETA_NOTICE_SNOOZE_MS;
}

/**
 * The beta notice above an app's page: Tangent is new, so it asks people to
 * report problems to the operator's mailbox. Closing it hides it for a day in
 * this browser; with storage blocked it stays closed until the next load.
 * Styles: `.beta-banner` in base.css.
 */
@Component({
  selector: 'app-beta-banner',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <p class="beta-banner" role="note">
        <span>
          <strong>Beta.</strong> Tangent is new, and some things may break. Something wrong or
          confusing? Email <a [href]="'mailto:' + email">{{ email }}</a
          >.
        </span>
        <button type="button" class="icon-btn" aria-label="Close the beta notice" (click)="close()">
          <app-icon name="x" [size]="14" />
        </button>
      </p>
    }
  `,
})
export class BetaBanner {
  /** The operator's mailbox on this deployment's own domain. */
  protected readonly email = `admin@${location.hostname}`;
  protected readonly visible = signal(betaNoticeDue(readDismissedAt(), Date.now()));

  protected close(): void {
    this.visible.set(false);
    try {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    } catch {
      // Storage unavailable (private mode, blocked): closed for this page load only.
    }
  }
}

function readDismissedAt(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}
