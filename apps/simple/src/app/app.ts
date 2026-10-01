import { ChangeDetectionStrategy, Component, DestroyRef, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { APP_PATHS, AuthService, Icon } from '@tangent/web-shared';
import { RouteSync } from './core/route-sync';
import { AppHeader } from './shell/app-header';
import { PasskeysDialog } from './shell/passkeys-dialog';
import { AccountStore } from './state/account-store';
import { LessonStore } from './state/lesson-store';
import { UiStore } from './state/ui-store';

/** Where the power app lives: allowlisted (power) accounts belong there. */
const POWER_APP_HOME = '/';

/** Simple-mode shell, served under /learn/. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, AppHeader, PasskeysDialog, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loginPage) {
      <router-outlet />
    } @else {
      <div class="shell">
        <app-header />
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
  /** The signed-in caller is known and is a simple account. */
  protected readonly ready = this.account.me;
  /**
   * The login page is always its own document (see AuthService), so this is
   * fixed for the page's lifetime. It renders without the shell and loads no data.
   */
  protected readonly loginPage = location.pathname.replace(/\/+$/, '') === inject(APP_PATHS).login;

  constructor() {
    if (this.loginPage) return;
    inject(RouteSync).start(inject(DestroyRef));
    void this.boot();
  }

  private async boot(): Promise<void> {
    try {
      const me = await this.auth.requireUser();
      if (!me) return;
      // Power (allowlisted) accounts use the full app at the root.
      if (me.mode === 'power') {
        location.replace(POWER_APP_HOME);
        return;
      }
      this.account.me.set(me);
      await Promise.all([this.lessons.init(), this.account.refreshBalance()]);
    } catch (err) {
      this.lessons.fail(err);
    }
  }
}
