import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { AdminStatusResponse, MeResponse } from '@tangent/shared';
import { ApiClient, AuthService, errorMessage, Logo } from '@tangent/web-shared';
import { HoldsPage } from './holds-page';
import { PoolPage } from './pool-page';
import { PoolUsagePage } from './pool-usage-page';
import { ReportsPage } from './reports-page';
import { UsersPage } from './users-page';
import { WaitlistPage } from './waitlist-page';

/**
 * The admin app, served under /admin/ to admins only (the Worker answers 404
 * to anyone else; ADMIN_USER_IDS). One page: the queue of reports from
 * share pages and the legal holds, then the users (who may publish share
 * links while SHARING is `allowlist`, whose sharing is suspended, taking any
 * share down or back up, suspending a user's open pool access, waiving a
 * user's membership, adding credit to a user), the pool's balance and
 * overage breaker with top-ups and corrections, who uses the pool most,
 * and the waitlist with its invites.
 */
@Component({
  selector: 'app-root',
  imports: [Logo, HoldsPage, PoolPage, PoolUsagePage, ReportsPage, UsersPage, WaitlistPage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="admin-head">
      <a href="/" class="brand" aria-label="Back to Tangent">
        <app-logo [size]="22" />
        <span aria-hidden="true">Tangent</span>
      </a>
      <span class="badge badge-warn">admin</span>
      <span class="spacer"></span>
      @if (me(); as m) {
        <span class="muted small">{{ m.devMode ? 'dev bypass' : m.email }}</span>
      }
    </header>
    <main class="admin-main">
      <h1>Admin</h1>
      @if (error(); as e) {
        <p class="notice notice-error" role="alert">{{ e }}</p>
      } @else if (!me()) {
        <p class="muted" aria-busy="true">Loading…</p>
      } @else {
        @if (status(); as s) {
          @switch (s.sharing) {
            @case ('everyone') {
              <p class="notice notice-ok" role="status">
                <span>
                  <strong>SHARING is everyone:</strong> everyone may share; the allowlist below has
                  no effect.
                </span>
              </p>
            }
            @case ('allowlist') {
              <p class="notice" role="status">
                <span>
                  <strong>SHARING is allowlist:</strong> only admins and the users marked “May
                  share” can publish share links, and only their links open. Turning a user off
                  takes their links down at once.
                </span>
              </p>
            }
            @case ('off') {
              <p class="notice notice-error" role="status">
                <span>
                  <strong>SHARING is off:</strong> nobody can publish share links, admins included,
                  and no link opens. The allowlist below takes effect once it is allowlist again.
                </span>
              </p>
            }
          }
          @if (s.moderationKeyMissing) {
            <p class="notice notice-error" role="status">
              <span>
                <strong>MODERATION_API_KEY is not set:</strong> SHARING says everyone, but nothing
                could be screened, so sharing acts as allowlist until the key is set.
              </span>
            </p>
          }
          @if (!s.membershipRequired) {
            <p class="notice" role="status">
              <span>
                <strong>The membership is not required</strong> (ANNUAL_FEE_ENABLED is off, or the
                payment provider doesn't sell it): everyone may generate on their own keys. A
                “Member” waiver takes effect once it is required.
              </span>
            </p>
          }
        }
        <app-reports-page />
        <app-holds-page />
        <app-users-page />
        <app-waitlist-page />
        <app-pool-page />
        <app-pool-usage-page />
      }
    </main>
  `,
})
export class App {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  protected readonly me = signal<MeResponse | null>(null);
  protected readonly status = signal<AdminStatusResponse | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.boot();
  }

  private async boot(): Promise<void> {
    try {
      const me = await this.auth.requireUser();
      if (!me) return;
      if (!me.isAdmin) {
        this.error.set('This account is not an admin.');
        return;
      }
      this.status.set(await this.api.adminStatus());
      this.me.set(me);
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }
}
