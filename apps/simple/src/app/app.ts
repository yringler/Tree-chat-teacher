import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { RouterOutlet } from '@angular/router';
import type { MembershipInfo } from '@tangent/shared';
import {
  ApiClient,
  APP_PATHS,
  AuthService,
  DEMO_MODE,
  Icon,
  MembershipGate,
  PoolFirstUseDialog,
} from '@tangent/web-shared';
import { BRAND } from './brand';
import { ConnectDialog } from './chat/connect-dialog';
import { RouteSync } from './core/route-sync';
import { DEMO_SIGNUP_URL } from './demo/demo-mode';
import { AppHeader } from './shell/app-header';
import { ModelAccessDialog } from './shell/model-access-dialog';
import { DeleteAccountDialog } from './shell/delete-account-dialog';
import { PasskeysDialog } from './shell/passkeys-dialog';
import { AccountStore } from './state/account-store';
import { LessonStore } from './state/lesson-store';
import { UiStore } from './state/ui-store';

/** Simple-mode shell, served under /learn/. */
@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    AppHeader,
    ModelAccessDialog,
    PasskeysDialog,
    DeleteAccountDialog,
    Icon,
    MembershipGate,
    PoolFirstUseDialog,
    ConnectDialog,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loginPage) {
      <router-outlet />
    } @else {
      <div class="shell" [attr.inert]="gate() ? '' : null">
        <app-header />
        @if (demo) {
          <p class="demo-banner" role="note">
            <span><strong>Demo:</strong> replies are generated nonsense and nothing is saved.</span>
            <a class="demo-banner-cta" [href]="signupUrl">Start learning for real</a>
          </p>
        }
        <main class="shell-main">
          @if (ready()) {
            <router-outlet />
          } @else {
            <p class="muted center pad" aria-busy="true">Loading…</p>
          }
        </main>
      </div>
      @if (ui.passkeysOpen()) {
        <app-passkeys-dialog />
      }
      @if (ui.deleteAccountOpen()) {
        <app-delete-account-dialog />
      }
      @if (ui.accessOpen()) {
        <app-model-access-dialog />
      }
      @if (ui.linkDialog(); as sourceNodeId) {
        <app-connect-dialog [sourceNodeId]="sourceNodeId" />
      }
      @if (ui.poolVerifyOpen()) {
        <app-pool-first-use-dialog (closed)="ui.poolVerifyOpen.set(false)" />
      } @else if (ui.poolConsentVersion(); as version) {
        <app-pool-first-use-dialog
          [consentVersion]="version"
          [busy]="acknowledging()"
          (closed)="ui.poolConsentVersion.set(null)"
          (acknowledged)="acknowledgePoolNotice()"
        />
      }
      @if (gate(); as membership) {
        <app-membership-gate
          [membership]="membership"
          [appName]="brand"
          billingPath="/learn/billing"
          needs="Buying credit needs one (Learn on your own key doesn't)"
          [freeTier]="account.freeTierOffered()"
          (redeemed)="account.setMembership($event)"
          (freeTierChosen)="account.useFreeTier()"
        />
      }
    }

    <div class="toasts" role="status" aria-live="polite">
      @for (t of ui.toasts(); track t.id) {
        <div class="toast" [class.toast-error]="t.kind === 'error'">
          <span>{{ t.text }}</span>
          <button type="button" class="icon-btn" aria-label="Dismiss" (click)="ui.dismiss(t.id)">
            <app-icon name="x" [size]="14" />
          </button>
        </div>
      }
    </div>
  `,
  host: { '(document:keydown.escape)': 'ui.closeTop()' },
})
export class App {
  protected readonly ui = inject(UiStore);
  private readonly lessons = inject(LessonStore);
  protected readonly account = inject(AccountStore);
  private readonly routeSync = inject(RouteSync);
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiClient);
  /** `/learn/demo/`: an in-browser backend, no sign-in (see @tangent/web-shared/demo). */
  protected readonly demo = inject(DEMO_MODE);
  protected readonly signupUrl = DEMO_SIGNUP_URL;
  protected readonly brand = BRAND;
  /** The signed-in caller is known. */
  protected readonly ready = this.account.me;
  /**
   * The login page is always its own document (see AuthService), so this is
   * fixed for the page's lifetime. It renders without the shell and loads no data.
   */
  protected readonly loginPage =
    !this.demo && location.pathname.replace(/\/+$/, '') === inject(APP_PATHS).login;

  /**
   * The membership to ask for while generating is blocked; never over the
   * billing page (where the learner subscribes), the login page or the demo.
   * Waits for the first navigation so it doesn't flash over `/billing`.
   */
  protected readonly gate = computed<MembershipInfo | null>(() => {
    if (this.demo || this.loginPage) return null;
    const url = this.routeSync.url();
    if (!url || url === '/billing' || url.startsWith('/billing?')) return null;
    return this.account.membershipBlocked() ? this.account.membership() : null;
  });

  /** The pool notice's acknowledgment is being recorded. */
  protected readonly acknowledging = signal(false);

  constructor() {
    if (this.loginPage) return;
    this.routeSync.start(inject(DestroyRef));
    void this.boot();
  }

  protected async acknowledgePoolNotice(): Promise<void> {
    this.acknowledging.set(true);
    try {
      await this.lessons.acknowledgePoolNotice();
    } finally {
      this.acknowledging.set(false);
    }
  }

  private async boot(): Promise<void> {
    try {
      // The demo's caller always exists; nothing to redirect to.
      const me = this.demo ? await this.api.me() : await this.auth.requireUser();
      if (!me) return;
      this.account.setMe(me);
      await Promise.all([
        this.lessons.init(),
        this.account.refreshBalance(),
        this.account.refreshPool(),
        // The demo has no key cookie (and always runs on pretend credit).
        this.demo ? Promise.resolve() : this.account.refreshKey(),
      ]);
    } catch (err) {
      this.lessons.fail(err);
    }
  }
}
