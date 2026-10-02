import { ChangeDetectionStrategy, Component, DestroyRef, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ApiClient, APP_PATHS, AuthService, DEMO_MODE, Icon } from '@tangent/web-shared';
import { RouteSync } from './core/route-sync';
import { DEMO_SIGNUP_URL } from './demo/demo-mode';
import { AppHeader } from './shell/app-header';
import { ModelAccessDialog } from './shell/model-access-dialog';
import { PasskeysDialog } from './shell/passkeys-dialog';
import { AccountStore } from './state/account-store';
import { LessonStore } from './state/lesson-store';
import { UiStore } from './state/ui-store';

/** Simple-mode shell, served under /learn/. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, AppHeader, ModelAccessDialog, PasskeysDialog, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loginPage) {
      <router-outlet />
    } @else {
      <div class="shell">
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
      @if (ui.accessOpen()) {
        <app-model-access-dialog />
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
  private readonly account = inject(AccountStore);
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiClient);
  /** `/learn/demo/`: an in-browser backend, no sign-in (see @tangent/web-shared/demo). */
  protected readonly demo = inject(DEMO_MODE);
  protected readonly signupUrl = DEMO_SIGNUP_URL;
  /** The signed-in caller is known. */
  protected readonly ready = this.account.me;
  /**
   * The login page is always its own document (see AuthService), so this is
   * fixed for the page's lifetime. It renders without the shell and loads no data.
   */
  protected readonly loginPage =
    !this.demo && location.pathname.replace(/\/+$/, '') === inject(APP_PATHS).login;

  constructor() {
    if (this.loginPage) return;
    inject(RouteSync).start(inject(DestroyRef));
    void this.boot();
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
        // The demo has no key cookie (and always runs on pretend credit).
        this.demo ? Promise.resolve() : this.account.refreshKey(),
      ]);
    } catch (err) {
      this.lessons.fail(err);
    }
  }
}
