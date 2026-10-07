import { ChangeDetectionStrategy, Component, DestroyRef, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ApiClient, APP_PATHS, AuthService, DEMO_MODE, Icon } from '@tangent/web-shared';
import { DEMO_SIGNUP_URL } from './brand';
import { Keyboard } from './core/keyboard';
import { RouteSync } from './core/route-sync';
import { DialogHost } from './dialogs/dialog-host';
import { AppHeader } from './shell/app-header';
import { CanvasStore } from './state/canvas-store';
import { UiStore } from './state/ui-store';

/** The canvas shell, served under /canvas/. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, AppHeader, DialogHost, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loginPage) {
      <router-outlet />
    } @else {
      <div class="shell">
        <app-header />
        @if (demo) {
          <p class="banner banner-demo" role="note">
            <span><strong>Demo:</strong> replies are generated nonsense and nothing is saved.</span>
            <a class="banner-cta" [href]="signupUrl">Sign in to use it for real</a>
          </p>
        } @else if (!ui.experimentalAck()) {
          <p class="banner banner-experimental" role="note">
            <span>
              <strong>Experimental.</strong> Canvas shows your Power-mode conversations as a map,
              with every lane live at once. It is real: what you send here is sent, on your own
              keys. Expect rough edges.
            </span>
            <button type="button" class="link-btn" (click)="ui.acknowledgeExperimental()">
              Got it
            </button>
          </p>
        }
        @if (!demo && store.membershipBlocked()) {
          <p class="banner banner-membership" role="alert">
            <span>
              <strong>Membership needed.</strong> Using your own API keys needs the yearly
              membership; your provider bills you directly. Tangent credit needs none: anyone can
              buy it. Your conversations stay readable.
            </span>
            <a class="banner-cta" href="/billing">Subscribe or enter a code</a>
            @if (store.membershipDismissible()) {
              <button type="button" class="link-btn" (click)="store.dismissMembershipNotice()">
                Dismiss
              </button>
            }
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
      <app-dialog-host />
    }

    <div class="toasts" role="status" aria-live="polite">
      @for (t of ui.toasts(); track t.id) {
        <div class="toast" [class.toast-error]="t.kind === 'error'">
          <span
            >{{ t.text }}
            @if (t.link; as link) {
              <a class="toast-link" [href]="link.href">{{ link.label }}</a>
            }
          </span>
          <button type="button" class="icon-btn" aria-label="Dismiss" (click)="ui.dismiss(t.id)">
            <app-icon name="x" [size]="14" />
          </button>
        </div>
      }
    </div>
  `,
  host: { '(document:keydown)': 'loginPage || keyboard.handle($event)' },
})
export class App {
  protected readonly ui = inject(UiStore);
  protected readonly keyboard = inject(Keyboard);
  protected readonly store = inject(CanvasStore);
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiClient);
  protected readonly demo = inject(DEMO_MODE);
  protected readonly signupUrl = DEMO_SIGNUP_URL;
  protected readonly ready = this.store.me;
  /** The login page is always its own document (see AuthService). */
  protected readonly loginPage =
    !this.demo && location.pathname.replace(/\/+$/, '') === inject(APP_PATHS).login;

  constructor() {
    if (this.loginPage) return;
    inject(RouteSync).start(inject(DestroyRef));
    void this.boot();
  }

  private async boot(): Promise<void> {
    try {
      const me = this.demo ? await this.api.me() : await this.auth.requireUser();
      if (!me) return;
      await this.store.init(me);
    } catch (err) {
      this.store.fail(err);
    }
  }
}
