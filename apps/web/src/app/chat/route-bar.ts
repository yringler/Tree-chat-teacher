import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { Branch } from '@tangent/shared';
import { Icon } from '@tangent/web-shared';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';

/** What the open branch replies on, as the bar under the message box shows it. */
export interface RouteView {
  branch: Branch;
  /** The provider entry's label ("OpenRouter", "Tangent credit"), else its id. */
  label: string;
  /** The model's label where the provider lists it, else its id. */
  model: string;
  /** On the user's own key, with none saved in this browser (`TreeStore.keyMissing`). */
  missing: boolean;
}

/**
 * Under the message box: what the open branch replies on (provider, who pays,
 * model), as a button to its settings, where that and the rest of them
 * (context, web search, …) can be changed at any point of the conversation:
 * a branch's route is where it starts, and every send uses its current one.
 * On the user's own key with none saved in this browser (another device, or
 * it expired), it says so before anything is sent, with one click to
 * Tangent credit (where it can carry on) or to the key.
 */
@Component({
  selector: 'app-route-bar',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'route-bar-host' },
  template: `
    @if (view(); as r) {
      <div class="route-bar">
        <span class="muted small">Replies on</span>
        <button
          type="button"
          class="route-chip"
          [class.is-warn]="r.missing"
          title="Change the provider, model or who pays (branch settings)"
          [attr.aria-label]="
            'Replies on ' + r.label + ', ' + r.model + '. Change them in the branch settings'
          "
          (click)="ui.branchSettingsOpen.set(true)"
        >
          <span class="route-chip-text"
            ><strong>{{ r.label }}</strong> · {{ r.model }}</span
          >
          <app-icon name="settings" [size]="13" />
        </button>
        @if (r.missing) {
          <span class="route-warn small">No {{ r.label }} key in this browser.</span>
          @if (store.creditRoute()) {
            <button
              type="button"
              class="link-btn small"
              [disabled]="switching()"
              (click)="useCredit(r.branch.id)"
            >
              Use Tangent credit
            </button>
          }
          <button
            type="button"
            class="link-btn small"
            (click)="ui.keysDialog.set({ provider: r.branch.providerId })"
          >
            Add your key
          </button>
        }
      </div>
    }
  `,
})
export class RouteBar {
  protected readonly store = inject(TreeStore);
  protected readonly ui = inject(UiStore);
  protected readonly switching = signal(false);

  protected readonly view = computed<RouteView | null>(() => {
    const branch = this.store.selectedBranch();
    if (!branch) return null;
    const provider = this.store.providerOf(branch);
    return {
      branch,
      label: provider?.label ?? branch.providerId,
      model: provider?.models.find((m) => m.id === branch.model)?.label ?? branch.model,
      missing: this.store.keyMissing(branch),
    };
  });

  protected async useCredit(branchId: string): Promise<void> {
    this.switching.set(true);
    try {
      await this.store.switchToCredit(branchId);
    } finally {
      this.switching.set(false);
    }
  }
}
