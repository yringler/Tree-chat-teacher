import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  Injectable,
  input,
  signal,
} from '@angular/core';
import { androidAppStoreUrl } from '@tangent/shared';
import { Icon } from './icon';

/**
 * Where this browser keeps the banner's state: `seen` once a load could have
 * shown it, `closed` once it was closed or followed to the store.
 */
const STATE_KEY = 'tangent.androidAppBanner';

/**
 * True for a browser on an Android phone or tablet: every Android browser
 * (and the reduced user agent Chrome sends) names Android in its user agent.
 */
export function onAndroid(userAgent: string): boolean {
  return /\bAndroid\b/i.test(userAgent);
}

/**
 * Whether this load shows the banner, given what this browser stored. Never
 * on the first load, so a newcomer meets the product before an install pitch,
 * and never again once closed or followed. Anything else stored counts as
 * closed: the worst case is a banner that doesn't come back.
 */
export function androidAppBannerDue(stored: string | null): boolean {
  return stored === 'seen';
}

/**
 * Whether the Android app banner shows on this load. The shell sets the app
 * and asks it whether to keep the beta notice back: one banner at a time on a
 * phone's short screen.
 */
@Injectable({ providedIn: 'root' })
export class AndroidAppNotice {
  private readonly app = signal<string | null | undefined>(undefined);
  /** The deployment's app (`MeResponse.androidAppId`); undefined until the shell knows the caller. */
  readonly appId = this.app.asReadonly();
  /** What this browser stored; undefined off Android, where nothing is read or written. */
  private readonly stored = onAndroid(navigator.userAgent) ? readState() : undefined;
  private readonly due = signal(this.stored !== undefined && androidAppBannerDue(this.stored));

  /** The banner shows: this load is due and the deployment has an app. */
  readonly visible = computed(() => this.due() && typeof this.appId() === 'string');
  /**
   * The beta notice waits while the banner shows or may show once the caller
   * is known, so a phone never sees one banner swap for the other.
   */
  readonly holdsBannerSlot = computed(() => this.due() && this.appId() !== null);

  /**
   * The caller is known. A first load on Android, with an app to offer, marks
   * this browser so the next load shows the banner.
   */
  known(appId: string | null): void {
    this.app.set(appId);
    if (appId !== null && this.stored === null) writeState('seen');
  }

  /** Hides the banner, in this browser for good. */
  close(): void {
    this.due.set(false);
    writeState('closed');
  }
}

/**
 * The banner above an app's page that points a phone running Android to the
 * Android app: Learn made for a phone, on the same account. Following the link
 * or closing it hides it in this browser for good. Styles: `.app-banner` in
 * base.css.
 */
@Component({
  selector: 'app-android-app-banner',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let id = notice.appId();
    @if (notice.visible() && id) {
      <p class="app-banner" role="note">
        <span>
          @if (placement() === 'learn') {
            <strong>Tangent is on Android,</strong> made for your phone.
          } @else {
            <strong>Your conversations are in the Android app too,</strong> in Learn's simpler
            layout.
          }
          <a [href]="storeUrl(id)" (click)="notice.close()">Get it on Google Play</a>
        </span>
        <button
          type="button"
          class="icon-btn"
          aria-label="Close the Android app notice"
          (click)="notice.close()"
        >
          <app-icon name="x" [size]="14" />
        </button>
      </p>
    }
  `,
})
export class AndroidAppBanner {
  /** The app it sits in: its words, and the placement Play Console reports. */
  readonly placement = input.required<'learn' | 'power'>();
  protected readonly notice = inject(AndroidAppNotice);

  protected storeUrl(appId: string): string {
    return androidAppStoreUrl(appId, this.placement());
  }
}

function readState(): string | null {
  try {
    return localStorage.getItem(STATE_KEY);
  } catch {
    return null;
  }
}

function writeState(state: 'seen' | 'closed'): void {
  try {
    localStorage.setItem(STATE_KEY, state);
  } catch {
    // Storage unavailable (private mode, blocked): nothing is remembered, so the banner never shows.
  }
}
