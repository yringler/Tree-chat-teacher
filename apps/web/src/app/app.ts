import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import type { MembershipInfo } from '@tangent/shared';
import {
  ApiClient,
  APP_PATHS,
  AuthService,
  DEMO_MODE,
  Icon,
  MembershipGate,
} from '@tangent/web-shared';
import { Keyboard } from './core/keyboard';
import { RouteSync } from './core/route-sync';
import { DialogHost } from './dialogs/dialog-host';
import { Sidebar } from './sidebar/sidebar';
import { TreeStore } from './state/tree-store';
import { UiStore } from './state/ui-store';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, Sidebar, DialogHost, Icon, MembershipGate],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  // No shortcuts while the membership gate covers the app.
  host: { '(document:keydown)': 'loginPage || gate() || keyboard.handle($event)' },
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

  private readonly router = inject(Router);
  /** The current URL; null until the first navigation ends. */
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: null },
  );
  /**
   * The membership to ask for while generating is blocked (a panel over the
   * app); never over `/billing` (where the user subscribes), the login page
   * or the demo. Waits for the first navigation so it doesn't flash over
   * `/billing`.
   */
  protected readonly gate = computed<MembershipInfo | null>(() => {
    const url = this.url();
    if (this.demo || this.loginPage || !url) return null;
    if (url === '/billing' || url.startsWith('/billing?')) return null;
    return this.store.membershipBlocked() ? this.store.membership() : null;
  });

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
