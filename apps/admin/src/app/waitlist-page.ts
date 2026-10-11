import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  WAITLIST_INVITE_MAX,
  type AdminWaitlistEntry,
  type AdminWaitlistResponse,
} from '@tangent/shared';
import { ApiClient, errorMessage } from '@tangent/web-shared';

/**
 * Who "Invite the next" emails: the oldest addresses not invited yet, as many
 * as there are free places (all of them without a cap), at most one request's
 * worth. An invite holds no place, so inviting more than the free places
 * only means some find it full again.
 */
export function nextToInvite(list: AdminWaitlistResponse): string[] {
  const free = list.maxUsers === null ? Infinity : Math.max(0, list.maxUsers - list.users);
  return list.entries
    .filter((e) => e.invitedAt === null)
    .slice(0, Math.min(free, WAITLIST_INVITE_MAX))
    .map((e) => e.email);
}

/**
 * The waitlist (`GET /api/admin/waitlist`), oldest first: people who asked,
 * while sign-ups were closed, to hear when there's room. Raise `MAX_USERS`
 * and deploy, then invite: each invite emails a link to sign up. Remove takes
 * an address off (a deletion request); signing up does that by itself.
 */
@Component({
  selector: 'app-waitlist-page',
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>Waitlist</h2>
    @if (error(); as e) {
      <p class="notice notice-error" role="alert">{{ e }}</p>
    }
    @if (note(); as n) {
      <p class="muted small" role="status">{{ n }}</p>
    }
    @if (list(); as l) {
      <dl class="admin-facts">
        <dt>Users</dt>
        <dd>
          {{ l.users }}
          @if (l.maxUsers === null) {
            (no cap: MAX_USERS is unset)
          } @else {
            of {{ l.maxUsers }} (MAX_USERS)
          }
        </dd>
        <dt>Waiting</dt>
        <dd>{{ l.total }} ({{ uninvited() }} not invited yet)</dd>
      </dl>
      <p class="admin-search">
        <button
          type="button"
          class="btn btn-primary"
          [disabled]="busy() || next().length === 0"
          (click)="invite(next())"
        >
          Invite the next {{ next().length }}
        </button>
        <button type="button" class="btn" [disabled]="busy()" (click)="load()">Refresh</button>
      </p>
      @if (l.entries.length > 0) {
        <div class="admin-table-wrap" tabindex="0" role="region" aria-label="Waitlist">
          <table class="admin-table">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Joined</th>
                <th scope="col">Invited</th>
                <th scope="col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              @for (e of l.entries; track e.email) {
                <tr>
                  <td>{{ e.email }}</td>
                  <td class="admin-nowrap">{{ e.createdAt | date: 'mediumDate' }}</td>
                  <td class="admin-nowrap">
                    {{ e.invitedAt ? (e.invitedAt | date: 'medium') : '—' }}
                  </td>
                  <td class="admin-nowrap">
                    <button
                      type="button"
                      class="btn btn-sm"
                      [disabled]="busy()"
                      (click)="invite([e.email])"
                    >
                      {{ e.invitedAt ? 'Invite again' : 'Invite' }}
                    </button>
                    <button
                      type="button"
                      class="btn btn-sm btn-ghost"
                      [disabled]="busy()"
                      (click)="remove(e)"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      } @else {
        <p class="muted small">Nobody is waiting.</p>
      }
    } @else if (busy()) {
      <p class="muted small" aria-busy="true">Loading…</p>
    }
  `,
})
export class WaitlistPage {
  private readonly api = inject(ApiClient);
  protected readonly list = signal<AdminWaitlistResponse | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly note = signal<string | null>(null);
  protected readonly next = computed(() => {
    const l = this.list();
    return l ? nextToInvite(l) : [];
  });
  protected readonly uninvited = computed(
    () => this.list()?.entries.filter((e) => e.invitedAt === null).length ?? 0,
  );

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    await this.step(async () => {
      this.list.set(await this.api.adminWaitlist());
    });
  }

  protected async invite(emails: string[]): Promise<void> {
    await this.step(async () => {
      const { invited } = await this.api.adminWaitlistInvite({ emails });
      this.note.set(`Invited ${invited}.`);
    });
    await this.load();
  }

  protected async remove(entry: AdminWaitlistEntry): Promise<void> {
    if (!confirm(`Take ${entry.email} off the waitlist?`)) return;
    await this.step(() => this.api.adminWaitlistRemove(entry.email));
    await this.load();
  }

  private async step(run: () => Promise<unknown>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await run();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
