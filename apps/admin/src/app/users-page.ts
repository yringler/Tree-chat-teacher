import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { AdminUser, ShareSummary } from '@tangent/shared';
import { ApiClient, errorMessage, Icon } from '@tangent/web-shared';

/** A user's shares once expanded: loading (null) or the list. */
type SharesState = ShareSummary[] | null;

/**
 * Users, newest first, searchable by email: the per-user "May share"
 * permission and, expanded, the user's shares with Revoke (a takedown).
 */
@Component({
  selector: 'app-users-page',
  imports: [DatePipe, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="admin-search" role="search" (submit)="$event.preventDefault(); search(q.value)">
      <label class="field">
        <span class="field-label">Search by email</span>
        <input #q type="search" maxlength="320" autocomplete="off" spellcheck="false" />
      </label>
      <button type="submit" class="btn" [disabled]="loading()">Search</button>
    </form>

    @if (error(); as e) {
      <p class="notice notice-error" role="alert">{{ e }}</p>
    }

    <div class="admin-table-wrap" tabindex="0" role="region" aria-label="Users">
      <table class="admin-table">
        <thead>
          <tr>
            <th scope="col">Email</th>
            <th scope="col">Account ID</th>
            <th scope="col">Signed up</th>
            <th scope="col">Active shares</th>
            <th scope="col">May share</th>
            <th scope="col"><span class="sr-only">Shares</span></th>
          </tr>
        </thead>
        <tbody>
          @for (u of users(); track u.id) {
            <tr>
              <td>
                {{ u.email }}
                @if (u.isAdmin) {
                  <span class="badge badge-warn" title="In ADMIN_USER_IDS: may always share"
                    >admin</span
                  >
                }
                @if (u.name && u.name !== u.email) {
                  <div class="muted small">{{ u.name }}</div>
                }
              </td>
              <td>
                <code class="admin-id">{{ u.id }}</code>
              </td>
              <td class="admin-nowrap">{{ u.createdAt | date: 'mediumDate' }}</td>
              <td>{{ u.activeShares }}</td>
              <td>
                <label class="check">
                  <input
                    type="checkbox"
                    [checked]="u.shareAllowed"
                    [disabled]="busy().has(u.id)"
                    (change)="setShareAllowed(u, $any($event.target))"
                  />
                  <span class="sr-only">{{ u.email }} may share</span>
                </label>
              </td>
              <td>
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  [attr.aria-expanded]="shares().has(u.id)"
                  [attr.aria-controls]="'shares-' + u.id"
                  (click)="toggleShares(u)"
                >
                  <app-icon
                    [name]="shares().has(u.id) ? 'chevronDown' : 'chevronRight'"
                    [size]="14"
                  />
                  Shares
                </button>
              </td>
            </tr>
            @if (shares().has(u.id)) {
              <tr [id]="'shares-' + u.id">
                <td colspan="6" class="admin-shares">
                  @if (shares().get(u.id); as list) {
                    @if (list.length === 0) {
                      <p class="muted small">No shares.</p>
                    } @else {
                      <ul class="admin-share-list">
                        @for (s of list; track s.id) {
                          <li class="admin-share">
                            <span class="admin-share-title">{{ s.title || s.treeTitle }}</span>
                            <span class="badge state-{{ s.state }}">{{ s.state }}</span>
                            <span class="muted small">
                              {{ s.mode }} · {{ s.viewCount }} views · created
                              {{ s.createdAt | date: 'mediumDate' }}
                            </span>
                            @if (s.state === 'active') {
                              <a [href]="s.url" target="_blank" rel="noopener noreferrer">
                                <app-icon name="external" [size]="14" /> Open
                              </a>
                              <button
                                type="button"
                                class="btn btn-danger-ghost btn-sm"
                                [disabled]="busy().has(s.id)"
                                (click)="revoke(u, s)"
                              >
                                <app-icon name="trash" [size]="14" /> Revoke
                              </button>
                            }
                          </li>
                        }
                      </ul>
                    }
                  } @else {
                    <p class="muted small" aria-busy="true">Loading…</p>
                  }
                </td>
              </tr>
            }
          } @empty {
            @if (!loading()) {
              <tr>
                <td colspan="6" class="muted">No users found.</td>
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
export class UsersPage {
  private readonly api = inject(ApiClient);

  protected readonly users = signal<AdminUser[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Expanded users' shares, by user id. */
  protected readonly shares = signal<ReadonlyMap<string, SharesState>>(new Map());
  /** User and share ids with a request in flight. */
  protected readonly busy = signal<ReadonlySet<string>>(new Set());
  private query = '';

  constructor() {
    void this.load(null);
  }

  protected search(q: string): void {
    this.query = q.trim();
    this.shares.set(new Map());
    void this.load(null);
  }

  protected loadMore(): void {
    void this.load(this.nextCursor());
  }

  protected async setShareAllowed(user: AdminUser, box: HTMLInputElement): Promise<void> {
    const allowed = box.checked;
    if (
      !allowed &&
      user.activeShares > 0 &&
      !confirm(
        `${user.email} has ${user.activeShares} active share link(s). They stop opening at once ` +
          '(unless DMCA_AGENT_REGISTERED is on). Continue?',
      )
    ) {
      box.checked = true;
      return;
    }
    await this.run(user.id, async () => {
      try {
        this.replaceUser(await this.api.updateAdminUser(user.id, { shareAllowed: allowed }));
      } catch (err) {
        box.checked = user.shareAllowed;
        throw err;
      }
    });
  }

  protected async toggleShares(user: AdminUser): Promise<void> {
    if (this.shares().has(user.id)) {
      this.setShares(user.id, undefined);
      return;
    }
    this.setShares(user.id, null);
    try {
      this.setShares(user.id, await this.api.adminUserShares(user.id));
    } catch (err) {
      this.setShares(user.id, undefined);
      this.error.set(errorMessage(err));
    }
  }

  protected async revoke(user: AdminUser, share: ShareSummary): Promise<void> {
    const name = share.title || share.treeTitle;
    if (!confirm(`Revoke "${name}"? The link stops working for everyone, for good.`)) return;
    await this.run(share.id, async () => {
      const revoked = await this.api.adminRevokeShare(share.id);
      const list = this.shares().get(user.id);
      if (list)
        this.setShares(
          user.id,
          list.map((s) => (s.id === revoked.id ? revoked : s)),
        );
      const current = this.users().find((u) => u.id === user.id);
      if (current && share.state === 'active') {
        this.replaceUser({ ...current, activeShares: Math.max(0, current.activeShares - 1) });
      }
    });
  }

  private async load(cursor: string | null): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const page = await this.api.adminUsers(this.query || undefined, cursor);
      this.users.update((list) => (cursor ? [...list, ...page.users] : page.users));
      this.nextCursor.set(page.nextCursor);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  private replaceUser(updated: AdminUser): void {
    this.users.update((list) => list.map((u) => (u.id === updated.id ? updated : u)));
  }

  /** `undefined` collapses the user's row. */
  private setShares(userId: string, state: SharesState | undefined): void {
    this.shares.update((m) => {
      const next = new Map(m);
      if (state === undefined) next.delete(userId);
      else next.set(userId, state);
      return next;
    });
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
