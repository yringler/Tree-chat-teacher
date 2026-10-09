import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ShareMode, ShareScope, ShareSummary } from '@tangent/shared';
import { ApiClient, Icon, Modal, ToastStore } from '@tangent/web-shared';
import { copyText } from '../core/selection';
import { ShareCard } from '../shares/share-card';
import { shareBranchTitle, sharesOfTree } from '../shares/share-list';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { ExpiryPicker } from '../ui/expiry-picker';
import { ScopePicker } from '../ui/scope-picker';

/**
 * Create a public read-only link (snapshot or live) for the tree, a subtree, or a path.
 * Above the form (below the new link, once made), the links this conversation already
 * has, as on the Shares page (ShareCard), so a second one isn't made by mistake.
 */
@Component({
  selector: 'app-share-dialog',
  imports: [Modal, ScopePicker, ExpiryPicker, Icon, RouterLink, NgTemplateOutlet, ShareCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal heading="Share" (closed)="close()">
      @if (created(); as s) {
        <div class="form">
          <p>
            Anyone with this link can read {{ scopeLabel() }}. Private branches are never included.
          </p>
          <div class="copy-row">
            <input
              type="text"
              readonly
              [value]="s.url"
              aria-label="Share link"
              #u
              (click)="u.select()"
            />
            <button type="button" class="btn btn-primary" (click)="copy(s.url)">
              <app-icon name="copy" /> Copy
            </button>
          </div>
          <div class="form-actions">
            <a routerLink="/shares" class="btn btn-ghost" (click)="close()">Manage shares</a>
            <a [href]="s.url" target="_blank" rel="noopener" class="btn btn-ghost"
              ><app-icon name="external" /> Open</a
            >
            <button type="button" class="btn" (click)="close()">Done</button>
          </div>
        </div>
        <ng-container [ngTemplateOutlet]="existing" />
      } @else {
        <ng-container [ngTemplateOutlet]="existing" />
        <form class="form" (submit)="$event.preventDefault(); create()">
          <app-scope-picker [(scope)]="scope" [(includeAncestors)]="includeAncestors" />
          @if (missingTarget()) {
            <p class="notice">
              This branch has no messages yet; share the whole conversation or add a message first.
            </p>
          }

          <fieldset class="radio-group">
            <legend class="field-label">Mode</legend>
            <label class="radio">
              <input
                type="radio"
                name="share-mode"
                value="snapshot"
                [checked]="mode() === 'snapshot'"
                (change)="mode.set('snapshot')"
              />
              <span
                ><strong>Snapshot</strong>
                <span class="muted small">Frozen now; republish to update it.</span></span
              >
            </label>
            <label class="radio">
              <input
                type="radio"
                name="share-mode"
                value="live"
                [checked]="mode() === 'live'"
                (change)="mode.set('live')"
              />
              <span
                ><strong>Live</strong>
                <span class="muted small">Always shows the current messages.</span></span
              >
            </label>
          </fieldset>

          <label class="field">
            <span class="field-label">Title <span class="muted">(optional)</span></span>
            <input
              type="text"
              maxlength="200"
              [value]="title()"
              (input)="title.set(t.value)"
              #t
              [placeholder]="store.detail()?.tree?.title ?? ''"
            />
          </label>

          <app-expiry-picker [(expiresAt)]="expiresAt" />

          <div class="form-actions">
            <button type="button" class="btn btn-ghost" (click)="close()">Cancel</button>
            <button type="submit" class="btn btn-primary" [disabled]="saving() || missingTarget()">
              {{ saving() ? 'Creating…' : 'Create link' }}
            </button>
          </div>
        </form>
      }

      <ng-template #existing>
        <section class="share-existing" aria-labelledby="share-existing-h">
          <h3 id="share-existing-h" class="field-label">
            Links to this conversation
            @if (!loading() && !loadError() && rows().length) {
              <span class="badge">{{ rows().length }}</span>
            }
          </h3>
          @if (loading()) {
            <p class="muted small" role="status">Loading shares…</p>
          } @else if (loadError(); as err) {
            <p class="notice notice-error" role="alert">
              {{ err }}
              <button type="button" class="btn btn-sm" (click)="load()">Retry</button>
            </p>
          } @else if (rows().length === 0) {
            <p class="muted small">No shares of this conversation yet.</p>
          } @else {
            <ul class="card-list">
              @for (r of rows(); track r.share.id) {
                <li
                  app-share-card
                  [share]="r.share"
                  [showTree]="false"
                  [branch]="r.branch"
                  (changed)="replace($event)"
                  (deleted)="drop($event)"
                ></li>
              }
            </ul>
          }
        </section>
      </ng-template>
    </app-modal>
  `,
})
export class ShareDialog {
  protected readonly store = inject(TreeStore);
  private readonly ui = inject(UiStore);
  private readonly toast = inject(ToastStore);
  private readonly api = inject(ApiClient);

  protected readonly scope = signal<ShareScope>('tree');
  protected readonly includeAncestors = signal(false);
  protected readonly mode = signal<ShareMode>('snapshot');
  protected readonly title = signal('');
  protected readonly expiresAt = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly created = signal<ShareSummary | null>(null);

  /** Every share of the account (the list endpoint has no per-tree filter); `rows` narrows it. */
  private readonly all = signal<ShareSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  /** This conversation's shares, newest first, each with the branch it starts from or ends in. */
  protected readonly rows = computed(() => {
    const treeId = this.store.selectedTreeId();
    const index = this.store.index();
    return treeId
      ? sharesOfTree(this.all(), treeId).map((share) => ({
          share,
          branch: shareBranchTitle(share, index),
        }))
      : [];
  });

  protected readonly missingTarget = computed(
    () => this.scope() !== 'tree' && !this.store.targetNodeFor(this.scope()),
  );
  protected readonly scopeLabel = computed(() => {
    const s = this.created()?.scope;
    return s === 'tree'
      ? 'this conversation'
      : s === 'subtree'
        ? 'this part of the conversation'
        : 'this thread';
  });

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      const list = await this.api.listShares();
      // A link made while the list was loading may be missing from it.
      const made = this.created();
      this.all.set(made && !list.some((s) => s.id === made.id) ? [made, ...list] : list);
    } catch (err) {
      this.loadError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected replace(updated: ShareSummary): void {
    this.all.update((list) => list.map((s) => (s.id === updated.id ? updated : s)));
  }

  protected drop(shareId: string): void {
    this.all.update((list) => list.filter((s) => s.id !== shareId));
    // The link shown after creating it is gone too.
    if (this.created()?.id === shareId) this.created.set(null);
  }

  protected close(): void {
    this.ui.shareDialogOpen.set(false);
  }

  protected async copy(url: string): Promise<void> {
    if (await copyText(url)) this.toast.notify('Link copied');
  }

  protected async create(): Promise<void> {
    const treeId = this.store.selectedTreeId();
    if (!treeId) return;
    const scope = this.scope();
    const title = this.title().trim();
    this.saving.set(true);
    try {
      const share = await this.api.createShare({
        treeId,
        scope,
        nodeId: scope === 'tree' ? null : this.store.targetNodeFor(scope),
        includeAncestors: scope === 'subtree' && this.includeAncestors(),
        mode: this.mode(),
        title: title || null,
        expiresAt: this.expiresAt(),
      });
      this.created.set(share);
      this.all.update((list) => [share, ...list.filter((s) => s.id !== share.id)]);
    } catch (err) {
      this.store.fail(err);
    } finally {
      this.saving.set(false);
    }
  }
}
