import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ShareSummary } from '@tangent/shared';
import { ApiClient, Icon } from '@tangent/web-shared';
import { copyText } from '../core/selection';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { ExpiryPicker } from '../ui/expiry-picker';

const SCOPE_LABEL: Record<ShareSummary['scope'], string> = {
  tree: 'Whole conversation',
  subtree: 'Subtree',
  path: 'Path',
};

/** `/shares`: every public link, with copy / open / edit / republish / revoke. */
@Component({
  selector: 'app-shares-page',
  imports: [DatePipe, RouterLink, Icon, ExpiryPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './shares-page.html',
  host: { class: 'page' },
})
export class SharesPage {
  private readonly api = inject(ApiClient);
  private readonly store = inject(TreeStore);
  protected readonly ui = inject(UiStore);

  protected readonly shares = signal<ShareSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly busyId = signal<string | null>(null);
  protected readonly editingId = signal<string | null>(null);
  protected readonly editTitle = signal('');
  protected readonly editExpires = signal<string | null>(null);
  protected readonly scopeLabel = SCOPE_LABEL;

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.shares.set(await this.api.listShares());
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected async copy(s: ShareSummary): Promise<void> {
    if (await copyText(s.url)) this.ui.notify('Link copied');
  }

  protected republish(s: ShareSummary): Promise<void> {
    return this.act(s, () => this.api.republishShare(s.id), 'Snapshot republished');
  }

  protected revoke(s: ShareSummary): Promise<void> {
    if (
      !confirm(
        `Revoke “${s.title ?? s.treeTitle}”? The link stops working immediately and cannot be re-enabled.`,
      )
    ) {
      return Promise.resolve();
    }
    return this.act(s, () => this.api.revokeShare(s.id), 'Link revoked');
  }

  protected startEdit(s: ShareSummary): void {
    this.editingId.set(s.id);
    this.editTitle.set(s.title ?? '');
    this.editExpires.set(s.expiresAt);
  }

  protected saveEdit(s: ShareSummary): Promise<void> {
    const title = this.editTitle().trim() || null;
    return this.act(
      s,
      () => this.api.updateShare(s.id, { title, expiresAt: this.editExpires() }),
      'Share updated',
    ).then(() => this.editingId.set(null));
  }

  private async act(s: ShareSummary, op: () => Promise<ShareSummary>, done: string): Promise<void> {
    this.busyId.set(s.id);
    try {
      const updated = await op();
      this.shares.update((list) => list.map((x) => (x.id === updated.id ? updated : x)));
      this.ui.notify(done);
    } catch (err) {
      this.store.fail(err);
    } finally {
      this.busyId.set(null);
    }
  }
}
