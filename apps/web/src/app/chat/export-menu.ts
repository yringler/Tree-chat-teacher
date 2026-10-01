import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { ShareScope } from '@tangent/shared';
import { ApiClient, Icon } from '@tangent/web-shared';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { ScopePicker } from '../ui/scope-picker';

/** Export dropdown: Markdown / HTML (with scope) and JSON backup, as download links. */
@Component({
  selector: 'app-export-menu',
  imports: [Icon, ScopePicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="menu-wrap">
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        aria-haspopup="true"
        aria-controls="export-menu"
        [attr.aria-expanded]="ui.exportMenuOpen()"
        (click)="ui.exportMenuOpen.set(!ui.exportMenuOpen())"
      >
        <app-icon name="download" /> <span class="hide-narrow">Export</span>
      </button>
      @if (ui.exportMenuOpen()) {
        <div class="menu-scrim" (click)="ui.exportMenuOpen.set(false)"></div>
        <div class="menu" id="export-menu" role="group" aria-label="Export">
          <app-scope-picker [(scope)]="scope" [(includeAncestors)]="includeAncestors" />
          <label class="check">
            <input
              type="checkbox"
              [checked]="includePrivate()"
              (change)="includePrivate.set(!includePrivate())"
            />
            Include private branches
          </label>
          @if (disabled()) {
            <p class="muted small">This branch has no messages to export yet.</p>
          } @else {
            <div class="menu-actions">
              <a
                class="btn btn-sm"
                [href]="url('md')"
                download
                (click)="ui.exportMenuOpen.set(false)"
                >Markdown</a
              >
              <a
                class="btn btn-sm"
                [href]="url('html')"
                download
                (click)="ui.exportMenuOpen.set(false)"
                >HTML</a
              >
            </div>
          }
          <hr />
          @if (store.selectedTreeId(); as treeId) {
            <a
              class="btn btn-sm btn-ghost"
              [href]="api.backupUrl(treeId)"
              download
              (click)="ui.exportMenuOpen.set(false)"
            >
              <app-icon name="download" /> JSON backup (everything)
            </a>
          }
        </div>
      }
    </div>
  `,
})
export class ExportMenu {
  protected readonly store = inject(TreeStore);
  protected readonly ui = inject(UiStore);
  protected readonly api = inject(ApiClient);
  protected readonly scope = signal<ShareScope>('tree');
  protected readonly includeAncestors = signal(false);
  protected readonly includePrivate = signal(false);
  protected readonly disabled = computed(
    () => this.scope() !== 'tree' && !this.store.targetNodeFor(this.scope()),
  );

  protected url(format: 'md' | 'html'): string {
    const treeId = this.store.selectedTreeId() ?? '';
    return this.api.exportUrl({
      treeId,
      scope: this.scope(),
      nodeId: this.store.targetNodeFor(this.scope()),
      format,
      includeAncestors: this.scope() === 'subtree' && this.includeAncestors(),
      includePrivate: this.includePrivate(),
    });
  }
}
