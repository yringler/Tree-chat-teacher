import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ShareSummary } from '@tangent/shared';
import { ApiClient, Icon, ToastStore } from '@tangent/web-shared';
import { copyText } from '../core/selection';
import { TreeStore } from '../state/tree-store';
import { ExpiryPicker } from '../ui/expiry-picker';
import { SCOPE_LABEL } from './share-list';

/**
 * One share as a card (`<li app-share-card>` in a `.card-list`), shared by the
 * Shares page and the share dialog: scope, mode, state, dates, the link, and
 * copy / open / edit / republish / revoke / delete. Emits the share the server
 * returns after each change, which the list owning it swaps in, and the id of a
 * deleted share, which it drops.
 */
@Component({
  selector: 'li[app-share-card]',
  imports: [DatePipe, RouterLink, Icon, ExpiryPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'card share-card',
    '[class.is-inactive]': "share().state !== 'active'",
    '[attr.aria-busy]': 'busy()',
  },
  template: `
    @let s = share();
    <div class="share-top">
      <strong class="share-title">{{ s.title ?? s.treeTitle }}</strong>
      <span class="badge state-{{ s.state }}">{{ s.state }}</span>
      <span class="badge">{{ s.mode }}</span>
      <span class="badge"
        >{{ scopeLabel[s.scope]
        }}{{ s.scope === 'subtree' && s.includeAncestors ? ' + context' : '' }}</span
      >
    </div>
    <div class="muted small">
      @if (showTree()) {
        <a [routerLink]="['/t', s.treeId]">{{ s.treeTitle }}</a> ·
      }
      @if (branch(); as b) {
        {{ s.scope === 'path' ? 'ends in' : 'from' }} “{{ b }}” ·
      }
      created {{ s.createdAt | date: 'medium' }} · updated {{ s.updatedAt | date: 'medium' }}
      @if (s.publishedAt) {
        · published {{ s.publishedAt | date: 'medium' }}
      }
      @if (s.expiresAt) {
        · {{ s.state === 'expired' ? 'expired' : 'expires' }} {{ s.expiresAt | date: 'medium' }}
      }
      · {{ s.viewCount }} {{ s.viewCount === 1 ? 'view' : 'views' }}
    </div>
    <span class="share-url">{{ s.url }}</span>

    @if (editing()) {
      <form class="form share-edit" (submit)="$event.preventDefault(); saveEdit()">
        <label class="field">
          <span class="field-label">Title</span>
          <input
            type="text"
            maxlength="200"
            [value]="editTitle()"
            (input)="editTitle.set(t.value)"
            #t
            [placeholder]="s.treeTitle"
          />
        </label>
        <app-expiry-picker [(expiresAt)]="editExpires" />
        <div class="form-actions">
          <button type="button" class="btn btn-ghost btn-sm" (click)="editing.set(false)">
            Cancel
          </button>
          <button type="submit" class="btn btn-primary btn-sm" [disabled]="busy()">Save</button>
        </div>
      </form>
    }

    <div class="share-actions">
      <button type="button" class="btn btn-sm" (click)="copy()" [disabled]="s.state !== 'active'">
        <app-icon name="copy" /> Copy link
      </button>
      <a class="btn btn-sm btn-ghost" [href]="s.url" target="_blank" rel="noopener"
        ><app-icon name="external" /> Open</a
      >
      @if (s.state !== 'revoked') {
        <button type="button" class="btn btn-sm btn-ghost" (click)="startEdit()">
          <app-icon name="edit" /> Edit
        </button>
      }
      @if (s.mode === 'snapshot' && s.state === 'active') {
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          [disabled]="busy()"
          (click)="republish()"
        >
          <app-icon name="refresh" /> Republish
        </button>
      }
      @if (s.state !== 'revoked') {
        <button
          type="button"
          class="btn btn-sm btn-danger-ghost"
          [disabled]="busy()"
          (click)="revoke()"
        >
          Revoke
        </button>
      }
      <button
        type="button"
        class="btn btn-sm btn-danger-ghost"
        [disabled]="busy()"
        (click)="remove()"
      >
        <app-icon name="trash" /> Delete
      </button>
    </div>
  `,
})
export class ShareCard {
  private readonly api = inject(ApiClient);
  private readonly store = inject(TreeStore);
  private readonly toast = inject(ToastStore);

  readonly share = input.required<ShareSummary>();
  /** Link to the conversation (the Shares page); the share dialog is already in it. */
  readonly showTree = input(true);
  /** Branch a subtree/path share starts from or ends in, when the caller knows it. */
  readonly branch = input<string | null>(null);
  /** The share as the server returned it after a republish, revoke or edit. */
  readonly changed = output<ShareSummary>();
  /** Id of the share once the server has deleted it. */
  readonly deleted = output<string>();

  protected readonly busy = signal(false);
  protected readonly editing = signal(false);
  protected readonly editTitle = signal('');
  protected readonly editExpires = signal<string | null>(null);
  protected readonly scopeLabel = SCOPE_LABEL;

  protected async copy(): Promise<void> {
    if (await copyText(this.share().url)) this.toast.notify('Link copied');
  }

  protected republish(): Promise<boolean> {
    const id = this.share().id;
    return this.act(() => this.api.republishShare(id), 'Snapshot republished');
  }

  protected revoke(): Promise<boolean> {
    const s = this.share();
    if (
      !confirm(
        `Revoke “${s.title ?? s.treeTitle}”? The link stops working immediately and cannot be re-enabled.`,
      )
    ) {
      return Promise.resolve(false);
    }
    return this.act(() => this.api.revokeShare(s.id), 'Link revoked');
  }

  /** Deletes the share (after a confirm); false when cancelled or it failed. */
  protected async remove(): Promise<boolean> {
    const s = this.share();
    const stops = s.state === 'active' ? ' The link stops working immediately.' : '';
    if (!confirm(`Delete “${s.title ?? s.treeTitle}”?${stops} This cannot be undone.`)) {
      return false;
    }
    this.busy.set(true);
    try {
      await this.api.deleteShare(s.id);
      this.deleted.emit(s.id);
      this.toast.notify('Share deleted');
      return true;
    } catch (err) {
      this.store.fail(err);
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  protected startEdit(): void {
    const s = this.share();
    this.editing.set(true);
    this.editTitle.set(s.title ?? '');
    this.editExpires.set(s.expiresAt);
  }

  protected async saveEdit(): Promise<void> {
    const id = this.share().id;
    const title = this.editTitle().trim() || null;
    const saved = await this.act(
      () => this.api.updateShare(id, { title, expiresAt: this.editExpires() }),
      'Share updated',
    );
    if (saved) this.editing.set(false);
  }

  /** Runs `op`, hands its result to the list; false when it failed (the store shows why). */
  private async act(op: () => Promise<ShareSummary>, done: string): Promise<boolean> {
    this.busy.set(true);
    try {
      this.changed.emit(await op());
      this.toast.notify(done);
      return true;
    } catch (err) {
      this.store.fail(err);
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
