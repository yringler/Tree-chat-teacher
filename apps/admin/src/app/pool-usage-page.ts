import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { AdminPoolUsageResponse } from '@tangent/shared';
import { ApiClient, errorMessage, formatCharge } from '@tangent/web-shared';

/**
 * Open pool consumption (`GET /api/admin/pool/usage`): who used the
 * pool most over the last days, so outliers are easy to spot, and today's
 * network keys with several users (what an account farm looks like).
 * Suspending a user is the "Pool suspended" box in the users table.
 */
@Component({
  selector: 'app-pool-usage-page',
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>Open pool use</h2>
    <form class="admin-search" (submit)="$event.preventDefault(); load(+days.value)">
      <label class="field">
        <span class="field-label">Days</span>
        <input #days type="number" min="1" max="90" value="7" />
      </label>
      <button type="submit" class="btn" [disabled]="loading()">Show</button>
    </form>
    @if (error(); as e) {
      <p class="notice notice-error" role="alert">{{ e }}</p>
    }
    @if (report(); as r) {
      <p class="muted small">Since {{ r.since | date: 'medium' : 'UTC' }} UTC, most spend first.</p>
      <div class="admin-table-wrap" tabindex="0" role="region" aria-label="Pool use by user">
        <table class="admin-table">
          <thead>
            <tr>
              <th scope="col">User</th>
              <th scope="col">Replies</th>
              <th scope="col">Spend</th>
              <th scope="col">Topic tagging</th>
              <th scope="col">Latest</th>
            </tr>
          </thead>
          <tbody>
            @for (row of r.rows; track row.userId) {
              <tr>
                <td>
                  {{ row.email ?? '(deleted)' }}
                  <div>
                    <code class="admin-id">{{ row.userId }}</code>
                  </div>
                </td>
                <td>{{ row.requests }}</td>
                <td>{{ money(row.spendMicros) }}</td>
                <td>{{ money(row.taggingMicros) }}</td>
                <td class="admin-nowrap">{{ row.lastAt | date: 'short' }}</td>
              </tr>
            } @empty {
              <tr>
                <td colspan="5" class="muted">No pool use in this period.</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <h3>Today's networks</h3>
      <div class="admin-table-wrap" tabindex="0" role="region" aria-label="Pool use by network">
        <table class="admin-table">
          <thead>
            <tr>
              <th scope="col">Network key</th>
              <th scope="col">Users</th>
              <th scope="col">Replies</th>
              <th scope="col">Spend</th>
            </tr>
          </thead>
          <tbody>
            @for (k of r.ipKeys; track k.ipKey) {
              <tr>
                <td>
                  <code class="admin-id">{{ k.ipKey }}</code>
                </td>
                <td>{{ k.users }}</td>
                <td>{{ k.requests }}</td>
                <td>{{ money(k.spendMicros) }}</td>
              </tr>
            } @empty {
              <tr>
                <td colspan="4" class="muted">No pool use today.</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    } @else if (loading()) {
      <p class="muted small" aria-busy="true">Loading…</p>
    }
  `,
})
export class PoolUsagePage {
  private readonly api = inject(ApiClient);
  protected readonly report = signal<AdminPoolUsageResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.load(7);
  }

  protected async load(days: number): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.report.set(await this.api.adminPoolUsage(Number.isInteger(days) ? days : 7));
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected money(micros: number): string {
    return formatCharge(micros);
  }
}
