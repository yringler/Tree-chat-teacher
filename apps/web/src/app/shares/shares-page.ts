import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { ShareSummary } from '@tangent/shared';
import { ApiClient, Icon } from '@tangent/web-shared';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { ShareCard } from './share-card';

/** `/shares`: every public link, with copy / open / edit / republish / revoke / delete (ShareCard). */
@Component({
  selector: 'app-shares-page',
  imports: [Icon, ShareCard],
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
  /** Reachable only by URL then (the sidebar hides it); kept so old links can still be revoked. */
  protected readonly sharingOff = computed(() => this.store.me()?.sharing === false);

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

  protected replace(updated: ShareSummary): void {
    this.shares.update((list) => list.map((x) => (x.id === updated.id ? updated : x)));
  }

  protected drop(shareId: string): void {
    this.shares.update((list) => list.filter((x) => x.id !== shareId));
  }
}
