import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ShareMode, ShareScope, ShareSummary } from '@tangent/shared';
import { ApiClient, Icon, Modal } from '@tangent/web-shared';
import { copyText } from '../core/selection';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { ExpiryPicker } from '../ui/expiry-picker';
import { ScopePicker } from '../ui/scope-picker';

/** Create a public read-only link (snapshot or live) for the tree, a subtree, or a path. */
@Component({
  selector: 'app-share-dialog',
  imports: [Modal, ScopePicker, ExpiryPicker, Icon, RouterLink],
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
      } @else {
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
    </app-modal>
  `,
})
export class ShareDialog {
  protected readonly store = inject(TreeStore);
  private readonly ui = inject(UiStore);
  private readonly api = inject(ApiClient);

  protected readonly scope = signal<ShareScope>('tree');
  protected readonly includeAncestors = signal(false);
  protected readonly mode = signal<ShareMode>('snapshot');
  protected readonly title = signal('');
  protected readonly expiresAt = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly created = signal<ShareSummary | null>(null);

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

  protected close(): void {
    this.ui.shareDialogOpen.set(false);
  }

  protected async copy(url: string): Promise<void> {
    if (await copyText(url)) this.ui.notify('Link copied');
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
    } catch (err) {
      this.store.fail(err);
    } finally {
      this.saving.set(false);
    }
  }
}
