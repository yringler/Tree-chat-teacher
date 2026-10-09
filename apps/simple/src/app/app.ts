import { ChangeDetectionStrategy, Component, DestroyRef, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import {
  ApiClient,
  APP_PATHS,
  AuthService,
  DEMO_MODE,
  Modal,
  PoolFirstUseDialog,
  ShortcutsTable,
  SidebarState,
  Toasts,
} from '@tangent/web-shared';
import { CompareDialog } from './chat/compare-dialog';
import { ConnectDialog } from './chat/connect-dialog';
import { Keyboard, SHORTCUTS } from './core/keyboard';
import { RouteSync } from './core/route-sync';
import { DEMO_SIGNUP_URL } from './demo/demo-mode';
import { AppHeader } from './shell/app-header';
import { LessonSidebar } from './shell/lesson-sidebar';
import { ModelAccessDialog } from './shell/model-access-dialog';
import { DeleteAccountDialog } from './shell/delete-account-dialog';
import { PasskeysDialog } from './shell/passkeys-dialog';
import { AccountStore } from './state/account-store';
import { LessonStore } from './state/lesson-store';
import { UiStore } from './state/ui-store';
import { LearnFunding } from './state/learn-funding';

/** Simple-mode shell, served under /learn/. */
@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    AppHeader,
    ModelAccessDialog,
    PasskeysDialog,
    DeleteAccountDialog,
    PoolFirstUseDialog,
    ConnectDialog,
    CompareDialog,
    LessonSidebar,
    Modal,
    ShortcutsTable,
    Toasts,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loginPage) {
      <router-outlet />
    } @else {
      <div class="shell" [class.drawer-open]="sidebar.drawerOpen()">
        <app-header />
        @if (demo) {
          <p class="demo-banner" role="note">
            <span><strong>Demo:</strong> replies are generated nonsense and nothing is saved.</span>
            <a class="demo-banner-cta" [href]="signupUrl">Start learning for real</a>
          </p>
        }
        <div class="shell-body">
          <aside class="sidebar" id="sidebar" aria-label="Lessons">
            <app-lesson-sidebar />
          </aside>
          @if (sidebar.drawerOpen()) {
            <div class="scrim" (click)="sidebar.drawerOpen.set(false)"></div>
          }
          <main class="shell-main">
            @if (ready()) {
              <router-outlet />
            } @else {
              <p class="muted center pad" aria-busy="true">Loading…</p>
            }
          </main>
        </div>
      </div>
      <!-- In stack order: the dialog opened last is on top, and Escape closes it. -->
      @for (d of ui.dialogs.list(); track d.kind) {
        @switch (d.kind) {
          @case ('passkeys') {
            <app-passkeys-dialog />
          }
          @case ('delete-account') {
            <app-delete-account-dialog />
          }
          @case ('access') {
            <app-model-access-dialog />
          }
          @case ('connect') {
            <app-connect-dialog [sourceNodeId]="d.sourceNodeId" />
          }
          @case ('compare') {
            <app-compare-dialog [branchId]="d.branchId" [content]="d.content" />
          }
          @case ('shortcuts') {
            <app-modal heading="Keyboard shortcuts" (closed)="ui.dialogs.close('shortcuts')">
              <app-shortcuts-table [shortcuts]="shortcuts" />
            </app-modal>
          }
          @case ('pool-verify') {
            <app-pool-first-use-dialog (closed)="ui.dialogs.close('pool-verify')" />
          }
        }
      }
    }

    <app-toasts />
  `,
  host: { '(document:keydown)': 'onKey($event)' },
})
export class App {
  protected readonly ui = inject(UiStore);
  protected readonly sidebar = inject(SidebarState);
  private readonly lessons = inject(LessonStore);
  protected readonly account = inject(AccountStore);
  protected readonly funding = inject(LearnFunding);
  private readonly routeSync = inject(RouteSync);
  private readonly keyboard = inject(Keyboard);
  protected readonly shortcuts = SHORTCUTS;
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
    this.routeSync.start(inject(DestroyRef));
    void this.boot();
  }

  protected onKey(e: KeyboardEvent): void {
    this.keyboard.handle(e);
  }

  private async boot(): Promise<void> {
    try {
      // The demo's caller always exists; nothing to redirect to.
      const me = this.demo ? await this.api.me() : await this.auth.requireUser();
      if (!me) return;
      this.account.me.set(me);
      await Promise.all([
        this.lessons.init(),
        this.funding.refreshBalance(),
        this.funding.refreshPool(),
        // The demo has no key cookie (and always runs on pretend credit).
        this.demo ? Promise.resolve() : this.funding.refreshKey(),
      ]);
    } catch (err) {
      this.lessons.fail(err);
    }
  }
}
