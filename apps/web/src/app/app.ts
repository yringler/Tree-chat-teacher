import { ChangeDetectionStrategy, Component, DestroyRef, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ApiClient, APP_PATHS, AuthService, DEMO_MODE, Toasts } from '@tangent/web-shared';
import { Keyboard } from './core/keyboard';
import { RouteSync } from './core/route-sync';
import { DialogHost } from './dialogs/dialog-host';
import { Sidebar } from './sidebar/sidebar';
import { TreeStore } from './state/tree-store';
import { UiStore } from './state/ui-store';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, Sidebar, DialogHost, Toasts],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  host: { '(document:keydown)': 'loginPage || keyboard.handle($event)' },
})
export class App {
  protected readonly ui = inject(UiStore);
  protected readonly store = inject(TreeStore);
  protected readonly keyboard = inject(Keyboard);
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiClient);
  /** `/demo/`: an in-browser backend, no sign-in (see @tangent/web-shared/demo). */
  protected readonly demo = inject(DEMO_MODE);
  /** Where the demo banner's call to action goes (the real sign-in page). */
  protected readonly signupUrl = '/login';
  /**
   * The login page is always its own document (see AuthService), so this is
   * fixed for the page's lifetime. It renders without the app shell and
   * loads no data.
   */
  protected readonly loginPage = !this.demo && location.pathname === inject(APP_PATHS).login;

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
      await this.store.init(me);
    } catch (err) {
      this.store.fail(err);
    }
  }
}
