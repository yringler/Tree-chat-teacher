import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type {
  AdminReport,
  AdminReportShareState,
  AdminReportsQuery,
  LegalHoldReason,
  ReportAction,
  ReportCategory,
} from '@tangent/shared';
import { ApiClient, errorMessage, Icon } from '@tangent/web-shared';

/** What each category of report says, as the queue shows it. */
export const REPORT_CATEGORY_LABELS: Readonly<Record<ReportCategory, string>> = {
  copyright: 'Copyright',
  defamation: 'False claims about a person',
  violent_or_illegal: 'Violence or another crime',
  csam: 'Child sexual abuse material',
  harassment_privacy: 'Harassment or personal information',
  other: 'Something else',
};

/** The badge class of a reported share's state: green while up, red when down, amber otherwise. */
export function shareStateClass(state: AdminReportShareState): string {
  if (state === 'active') return 'badge-ok';
  if (state === 'removed' || state === 'pending_review') return 'badge-danger';
  return 'badge-warn';
}

/** The legal hold a report of this category asks for, when the report didn't place one. */
export function holdReasonFor(category: ReportCategory): LegalHoldReason {
  return category === 'csam' || category === 'violent_or_illegal' ? category : 'other';
}

/** What the confirmation says before each decision; Remove and Restore change what the public sees. */
const CONFIRM: Readonly<Record<ReportAction, string>> = {
  remove:
    'Remove this link for good? Its open reports count as acted on, a strike against the owner; a second removed link suspends their sharing.',
  restore: 'Put this link back up? Its reports are rejected, which takes back a removal’s strike.',
  reject: 'Reject this report? The link goes back up unless another open report keeps it down.',
};

/**
 * Reports from share pages (`GET /api/admin/reports`): the undecided ones,
 * oldest first, or all of them. Each shows the reporter's words and where the
 * share stands, never the conversation: **Review** opens it on its own page
 * (`/admin/review/:shareId`, in a new tab). Remove, Restore and Reject take
 * optional notes; a report the share page didn't put on hold can be held here.
 */
@Component({
  selector: 'app-reports-page',
  imports: [DatePipe, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>Reports</h2>
    <p class="muted small">
      Review within 24 to 48 hours; child sexual abuse material and violence as soon as you see
      them. The owner is never told why.
    </p>
    <form class="admin-search" (submit)="$event.preventDefault()">
      <label class="field">
        <span class="field-label">Show</span>
        <select [value]="status()" (change)="show($any($event.target).value)">
          <option value="pending">Waiting for a decision</option>
          <option value="all">All reports</option>
        </select>
      </label>
    </form>

    @if (error(); as e) {
      <p class="notice notice-error" role="alert">{{ e }}</p>
    }

    <div class="admin-table-wrap" tabindex="0" role="region" aria-label="Reports">
      <table class="admin-table">
        <thead>
          <tr>
            <th scope="col">Received</th>
            <th scope="col">Report</th>
            <th scope="col">Share</th>
            <th scope="col">Owner</th>
            <th scope="col">Decision</th>
          </tr>
        </thead>
        <tbody>
          @for (r of reports(); track r.id) {
            <tr>
              <td class="admin-nowrap">{{ r.createdAt | date: 'short' }}</td>
              <td class="admin-report">
                <strong>{{ label(r.category) }}</strong>
                <p class="admin-report-details">{{ r.details }}</p>
                @if (r.reporterEmail) {
                  <div class="muted small">From {{ r.reporterEmail }}</div>
                }
              </td>
              <td>
                <span class="badge {{ stateClass(r.shareState) }}">{{
                  r.shareState.replace('_', ' ')
                }}</span>
                @if (r.held) {
                  <span class="badge badge-warn" title="A legal hold keeps a copy">held</span>
                }
                <div class="muted small">
                  {{ r.shareReporters }} {{ r.shareReporters === 1 ? 'reporter' : 'reporters' }}
                </div>
                <a [href]="'/admin/review/' + r.shareId" target="_blank" rel="noopener noreferrer">
                  <app-icon name="external" [size]="14" /> Review
                </a>
              </td>
              <td>
                {{ r.ownerEmail ?? '(deleted)' }}
                @if (r.ownerUserId) {
                  <div>
                    <code class="admin-id">{{ r.ownerUserId }}</code>
                  </div>
                }
              </td>
              <td class="admin-decision">
                @if (r.resolution !== 'pending') {
                  <div>
                    <span
                      class="badge {{ r.resolution === 'actioned' ? 'badge-danger' : 'badge-ok' }}"
                      >{{ r.resolution === 'actioned' ? 'removed' : 'rejected' }}</span
                    >
                    <span class="muted small">{{ r.resolvedAt | date: 'short' }}</span>
                  </div>
                  @if (r.notes) {
                    <p class="muted small">{{ r.notes }}</p>
                  }
                }
                <label class="field">
                  <span class="field-label">Notes</span>
                  <input
                    type="text"
                    maxlength="2000"
                    [value]="notes().get(r.id) ?? ''"
                    (input)="setNotes(r.id, $any($event.target).value)"
                  />
                </label>
                <div class="admin-actions">
                  <button
                    type="button"
                    class="btn btn-danger btn-sm"
                    [disabled]="busy().has(r.id)"
                    (click)="decide(r, 'remove')"
                  >
                    Remove
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm"
                    [disabled]="busy().has(r.id)"
                    (click)="decide(r, 'restore')"
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    [disabled]="busy().has(r.id)"
                    (click)="decide(r, 'reject')"
                  >
                    Reject
                  </button>
                  @if (!r.held) {
                    <button
                      type="button"
                      class="btn btn-ghost btn-sm"
                      [disabled]="busy().has(r.id)"
                      (click)="hold(r)"
                    >
                      Hold
                    </button>
                  }
                </div>
              </td>
            </tr>
          } @empty {
            @if (!loading()) {
              <tr>
                <td colspan="5" class="muted">
                  {{ status() === 'pending' ? 'No reports are waiting.' : 'No reports.' }}
                </td>
              </tr>
            }
          }
        </tbody>
      </table>
    </div>

    @if (loading()) {
      <p class="muted small" aria-busy="true">Loading…</p>
    } @else if (nextCursor()) {
      <button type="button" class="btn" (click)="loadMore()">Load more</button>
    }
  `,
})
export class ReportsPage {
  private readonly api = inject(ApiClient);

  protected readonly status = signal<AdminReportsQuery['status']>('pending');
  protected readonly reports = signal<AdminReport[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Notes typed for each report, sent with its decision. */
  protected readonly notes = signal<ReadonlyMap<string, string>>(new Map());
  /** Report ids with a request in flight. */
  protected readonly busy = signal<ReadonlySet<string>>(new Set());

  constructor() {
    void this.load(null);
  }

  protected label(category: ReportCategory): string {
    return REPORT_CATEGORY_LABELS[category];
  }

  protected stateClass(state: AdminReportShareState): string {
    return shareStateClass(state);
  }

  protected show(status: string): void {
    this.status.set(status === 'all' ? 'all' : 'pending');
    void this.load(null);
  }

  protected loadMore(): void {
    void this.load(this.nextCursor());
  }

  protected setNotes(reportId: string, text: string): void {
    this.notes.update((m) => new Map(m).set(reportId, text));
  }

  /**
   * Sends the decision, then reloads the list: a decision can resolve the
   * share's other reports too, and a decided one leaves the queue.
   */
  protected async decide(report: AdminReport, action: ReportAction): Promise<void> {
    if (!confirm(CONFIRM[action])) return;
    const notes = this.notes().get(report.id)?.trim();
    await this.run(report.id, async () => {
      await this.api.adminResolveReport(report.id, { action, ...(notes ? { notes } : {}) });
      this.notes.update((m) => {
        const next = new Map(m);
        next.delete(report.id);
        return next;
      });
      await this.load(null);
    });
  }

  /** Preserves the share as evidence (the report's category gives the reason); listed under Legal holds. */
  protected async hold(report: AdminReport): Promise<void> {
    const reason = holdReasonFor(report.category);
    if (
      !confirm('Place a legal hold on this share? It keeps a copy of the conversation and account.')
    )
      return;
    const notes = this.notes().get(report.id)?.trim();
    await this.run(report.id, async () => {
      await this.api.adminPlaceHold(report.shareId, { reason, ...(notes ? { notes } : {}) });
      this.reports.update((list) =>
        list.map((r) => (r.shareId === report.shareId ? { ...r, held: true } : r)),
      );
    });
  }

  private async load(cursor: string | null): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const page = await this.api.adminReports(this.status(), cursor);
      this.reports.update((list) => (cursor ? [...list, ...page.reports] : page.reports));
      this.nextCursor.set(page.nextCursor);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  private async run(id: string, step: () => Promise<void>): Promise<void> {
    this.busy.update((s) => new Set(s).add(id));
    this.error.set(null);
    try {
      await step();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.update((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }
}
