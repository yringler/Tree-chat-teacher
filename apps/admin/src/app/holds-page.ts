import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type {
  AdminHold,
  AdminHoldReportRequest,
  HoldReportKind,
  LegalHoldReason,
} from '@tangent/shared';
import { ApiClient, errorMessage, Icon } from '@tangent/web-shared';

/** What a hold's report form holds. */
export interface HoldReportForm {
  kind: HoldReportKind;
  /** The number NCMEC or the agency gave the report. */
  reference: string;
}

/** The `external-report` request a form makes, or why it can't be sent. */
export function holdReportRequest(form: HoldReportForm): AdminHoldReportRequest | string {
  const reference = form.reference.trim();
  if (!reference) return 'Enter the report number you were given.';
  if (reference.length > 200) return 'At most 200 characters.';
  return { kind: form.kind, reference };
}

const KIND_LABELS: Readonly<Record<HoldReportKind, string>> = {
  ncmec: 'NCMEC',
  law_enforcement: 'Law enforcement',
};

const REASON_LABELS: Readonly<Record<LegalHoldReason, string>> = {
  csam: 'Child sexual abuse material',
  violent_or_illegal: 'Violence or another crime',
  law_enforcement: 'Law-enforcement request',
  other: 'Other',
};

/**
 * Legal holds (`GET /api/admin/holds`): what each preserves and for whom,
 * never the copies (**Review** shows the held conversation once the share is
 * gone). **Record** notes a report filed by hand with NCMEC or law
 * enforcement, which keeps the hold for a year; **Release** deletes the
 * copies and keeps the record. What to do and when: docs/runbooks/csam.md.
 */
@Component({
  selector: 'app-holds-page',
  imports: [DatePipe, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>Legal holds</h2>
    <button type="button" class="btn btn-ghost btn-sm" [disabled]="loading()" (click)="load()">
      <app-icon name="refresh" [size]="14" /> Refresh
    </button>
    @if (error(); as e) {
      <p class="notice notice-error" role="alert">{{ e }}</p>
    }
    <div class="admin-table-wrap" tabindex="0" role="region" aria-label="Legal holds">
      <table class="admin-table">
        <thead>
          <tr>
            <th scope="col">Placed</th>
            <th scope="col">Reason</th>
            <th scope="col">Account</th>
            <th scope="col">Reported</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          @for (h of holds(); track h.id) {
            <tr>
              <td class="admin-nowrap">
                {{ h.createdAt | date: 'short' }}
                <div class="muted small">{{ h.createdBy ? 'by an admin' : 'automatically' }}</div>
              </td>
              <td>
                {{ reasonLabel(h.reason) }}
                @if (h.releasedAt) {
                  <span class="badge">released {{ h.releasedAt | date: 'mediumDate' }}</span>
                }
                @if (h.notes) {
                  <p class="muted small admin-report-details">{{ h.notes }}</p>
                }
              </td>
              <td>
                {{ h.subjectEmail ?? '(unknown)' }}
                @if (h.subjectUserId) {
                  <div>
                    <code class="admin-id">{{ h.subjectUserId }}</code>
                  </div>
                }
              </td>
              <td>
                @for (x of h.externalReports; track x.at) {
                  <div class="small">
                    {{ kindLabel(x.kind) }} <code class="admin-id">{{ x.reference }}</code>
                    <span class="muted">{{ x.at | date: 'mediumDate' }}</span>
                  </div>
                } @empty {
                  <span class="muted small">Not yet</span>
                }
              </td>
              <td class="admin-decision">
                @if (h.shareId) {
                  <a
                    [href]="'/admin/review/' + h.shareId"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <app-icon name="external" [size]="14" /> Review
                  </a>
                }
                @if (!h.releasedAt) {
                  <form
                    class="admin-actions"
                    (submit)="$event.preventDefault(); record(h, kind.value, reference.value)"
                  >
                    <label class="field">
                      <span class="field-label">Reported to</span>
                      <select #kind>
                        <option value="ncmec">NCMEC</option>
                        <option value="law_enforcement">Law enforcement</option>
                      </select>
                    </label>
                    <label class="field">
                      <span class="field-label">Report number</span>
                      <input #reference type="text" maxlength="200" autocomplete="off" />
                    </label>
                    <button type="submit" class="btn btn-sm" [disabled]="busy().has(h.id)">
                      Record
                    </button>
                  </form>
                  <button
                    type="button"
                    class="btn btn-danger-ghost btn-sm"
                    [disabled]="busy().has(h.id)"
                    (click)="release(h)"
                  >
                    Release
                  </button>
                }
              </td>
            </tr>
          } @empty {
            @if (!loading()) {
              <tr>
                <td colspan="5" class="muted">No legal holds.</td>
              </tr>
            }
          }
        </tbody>
      </table>
    </div>
  `,
})
export class HoldsPage {
  private readonly api = inject(ApiClient);

  protected readonly holds = signal<AdminHold[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Hold ids with a request in flight. */
  protected readonly busy = signal<ReadonlySet<string>>(new Set());

  constructor() {
    void this.load();
  }

  protected reasonLabel(reason: LegalHoldReason): string {
    return REASON_LABELS[reason];
  }

  protected kindLabel(kind: HoldReportKind): string {
    return KIND_LABELS[kind];
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.holds.set((await this.api.adminHolds()).holds);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  /** Records a report filed by hand; from then on the hold can't be released for a year. */
  protected async record(hold: AdminHold, kind: string, reference: string): Promise<void> {
    const req = holdReportRequest({
      kind: kind === 'law_enforcement' ? 'law_enforcement' : 'ncmec',
      reference,
    });
    if (typeof req === 'string') {
      this.error.set(req);
      return;
    }
    if (!confirm(`Record ${KIND_LABELS[req.kind]} report ${req.reference}? It can't be undone.`))
      return;
    await this.run(hold.id, async () => this.replace(await this.api.adminReportHold(hold.id, req)));
  }

  /** Deletes the copies; the server refuses within a year of a recorded report. */
  protected async release(hold: AdminHold): Promise<void> {
    if (!confirm('Release this hold? Its copies are deleted for good; the record stays.')) return;
    await this.run(hold.id, async () => this.replace(await this.api.adminReleaseHold(hold.id)));
  }

  private replace(updated: AdminHold): void {
    this.holds.update((list) => list.map((h) => (h.id === updated.id ? updated : h)));
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
