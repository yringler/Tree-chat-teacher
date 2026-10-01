import { ChangeDetectionStrategy, Component, DestroyRef, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { APP_PATHS, AuthService, Icon } from '@tangent/web-shared';
import { Keyboard } from './core/keyboard';
import { RouteSync } from './core/route-sync';
import { DialogHost } from './dialogs/dialog-host';
import { Sidebar } from './sidebar/sidebar';
import { TreeStore } from './state/tree-store';
import { UiStore } from './state/ui-store';

/** Where the simple app lives (apps/simple, `baseHref: '/learn/'`). */
const SIMPLE_APP_HOME = '/learn/';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, Sidebar, DialogHost, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  host: { '(document:keydown)': 'loginPage || keyboard.handle($event)' },
})
export class App {
  protected readonly ui = inject(UiStore);
  protected readonly store = inject(TreeStore);
  protected readonly keyboard = inject(Keyboard);
  private readonly auth = inject(AuthService);
  /**
   * The login page is always its own document (see AuthService), so this is
   * fixed for the page's lifetime. It renders without the app shell and
   * loads no data.
   */
  protected readonly loginPage = location.pathname === inject(APP_PATHS).login;

  constructor() {
    if (this.loginPage) return;
    inject(RouteSync).start(inject(DestroyRef));
    void this.boot();
  }

  private async boot(): Promise<void> {
    try {
      const me = await this.auth.requireUser();
      if (!me) return;
      // Simple (metered) accounts use the /learn/ app; this one is power-only.
      if (me.mode === 'simple') {
        location.replace(SIMPLE_APP_HOME);
        return;
      }
      await this.store.init(me);
    } catch (err) {
      this.store.fail(err);
    }
  }
}
