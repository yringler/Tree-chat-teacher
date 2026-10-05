import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { AdminStatusResponse, MeResponse } from '@tangent/shared';
import { ApiClient, AuthService, errorMessage, Icon } from '@tangent/web-shared';
import { PoolPage } from './pool-page';
import { PoolTopicsPage } from './pool-topics-page';
import { PoolUsagePage } from './pool-usage-page';
import { UsersPage } from './users-page';

/**
 * The admin app, served under /admin/ to admins only (the Worker answers 404
 * to anyone else; ADMIN_USER_IDS). One page: who may publish share links
 * while DMCA_AGENT_REGISTERED is off, taking any share down, suspending a
 * user's community pool access, the pool's balance and overage breaker with
 * top-ups and corrections, who uses the pool most, and the review queue
 * of topics the pool's public impact feed may name.
 */
@Component({
  selector: 'app-root',
  imports: [Icon, PoolPage, PoolTopicsPage, PoolUsagePage, UsersPage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="admin-head">
      <a href="/" class="brand" aria-label="Back to Tangent">
        <app-icon name="tree" [size]="20" />
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
          @if (s.dmcaAgentRegistered) {
            <p class="notice notice-ok" role="status">
              <span>
                <strong>DMCA_AGENT_REGISTERED is on:</strong> everyone may share; the allowlist
                below has no effect.
              </span>
            </p>
          } @else {
            <p class="notice" role="status">
              <span>
                <strong>DMCA_AGENT_REGISTERED is off:</strong> only admins and the users marked “May
                share” can publish share links, and only their links open. Turning a user off takes
                their links down at once.
              </span>
            </p>
          }
        }
        <app-users-page />
        <app-pool-page />
        <app-pool-usage-page />
        <app-pool-topics-page />
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
