import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import {
  POOL_TOPIC_REVIEW_STATUSES,
  type AdminPoolTopic,
  type PoolTopicReviewStatus,
} from '@tangent/shared';
import { ApiClient, errorMessage } from '@tangent/web-shared';

/**
 * The list shown after a decision: a topic that left the status being shown
 * drops out; one still in it is replaced by its updated row.
 */
export function afterDecision(
  topics: readonly AdminPoolTopic[],
  shown: PoolTopicReviewStatus,
  decided: AdminPoolTopic,
): AdminPoolTopic[] {
  return decided.status === shown
    ? topics.map((t) => (t.id === decided.id ? decided : t))
    : topics.filter((t) => t.id !== decided.id);
}

/**
 * The impact feed's review queue (`/api/admin/pool/topics`): the first time a
 * topic has enough distinct learners in a week to be named on the public
 * feed, it waits here instead. Approved topics are named from the next weekly
 * snapshot on; rejected ones never. Sensitive topics never reach the queue;
 * blocklisted ones (POOL_TOPIC_BLOCKLIST) are never named whatever their status.
 */
@Component({
  selector: 'app-pool-topics-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>Impact feed topics</h2>
    <p class="muted small">
      A topic is named on the public feed only once enough different learners explored it in a week
      and it is approved here. Approval applies from the next weekly snapshot.
    </p>
    <div class="admin-search" role="group" aria-label="Review status">
      @for (s of statuses; track s) {
        <button
          type="button"
          class="btn"
          [attr.aria-pressed]="status() === s"
          [disabled]="loading()"
          (click)="load(s)"
        >
          {{ statusLabel(s) }}
        </button>
      }
    </div>
    @if (error(); as e) {
      <p class="notice notice-error" role="alert">{{ e }}</p>
    }
    <div class="admin-table-wrap" tabindex="0" role="region" aria-label="Impact feed topics">
      <table class="admin-table">
        <thead>
          <tr>
            <th scope="col">Topic</th>
            <th scope="col">First qualified</th>
            <th scope="col">Decision</th>
          </tr>
        </thead>
        <tbody>
          @for (t of topics(); track t.id) {
            <tr>
              <td>
                {{ t.group }} › {{ t.label }}
                <div>
                  <code class="admin-id">{{ t.id }}</code>
                  @if (t.blocklisted) {
                    <span class="badge badge-warn" title="On POOL_TOPIC_BLOCKLIST: never named"
                      >blocked</span
                    >
                  }
                </div>
              </td>
              <td class="admin-nowrap">Week of {{ t.firstSeenWeek }}</td>
              <td class="admin-nowrap">
                @if (t.status !== 'approved') {
                  <button
                    type="button"
                    class="btn"
                    [disabled]="busy() === t.id"
                    (click)="decide(t, 'approved')"
                  >
                    Approve
                  </button>
                }
                @if (t.status !== 'rejected') {
                  <button
                    type="button"
                    class="btn"
                    [disabled]="busy() === t.id"
                    (click)="decide(t, 'rejected')"
                  >
                    Reject
                  </button>
                }
              </td>
            </tr>
          } @empty {
            <tr>
              <td colspan="3" class="muted">
                {{ loading() ? 'Loading…' : 'No ' + status() + ' topics.' }}
              </td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class PoolTopicsPage {
  private readonly api = inject(ApiClient);
  protected readonly statuses = POOL_TOPIC_REVIEW_STATUSES;
  protected readonly status = signal<PoolTopicReviewStatus>('pending');
  protected readonly topics = signal<AdminPoolTopic[]>([]);
  protected readonly loading = signal(false);
  protected readonly busy = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.load('pending');
  }

  protected statusLabel(s: PoolTopicReviewStatus): string {
    return s === 'pending' ? 'Waiting for review' : s === 'approved' ? 'Approved' : 'Rejected';
  }

  protected async load(status: PoolTopicReviewStatus): Promise<void> {
    this.status.set(status);
    this.loading.set(true);
    this.error.set(null);
    try {
      this.topics.set((await this.api.adminPoolTopics(status)).topics);
    } catch (err) {
      this.topics.set([]);
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected async decide(topic: AdminPoolTopic, decision: 'approved' | 'rejected'): Promise<void> {
    this.busy.set(topic.id);
    this.error.set(null);
    try {
      const decided = await this.api.decideAdminPoolTopic(topic.id, decision);
      this.topics.update((list) => afterDecision(list, this.status(), decided));
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(null);
    }
  }
}
