import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { maxUsageNote, TIER_LABELS, TIERS, type Branch, type ModelTier } from '@tangent/shared';
import { Icon, Segmented } from '@tangent/web-shared';
import { TierStore, tierOptions } from '../state/tier-store';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';

/** What the open branch replies on, as the bar under the message box shows it. */
export interface RouteView {
  branch: Branch;
  /** The provider entry's label ("OpenRouter", "Tangent credit"), else its id. */
  label: string;
  /** The tier it replies on, by name ("Normal"), else its model (`TierStore.modelLabel`). */
  model: string;
  /** On the user's own key, with none saved in this browser (`TreeStore.keyMissing`). */
  missing: boolean;
  /** Normal and Max are offered for this branch (TierStore `available`). */
  tiers: boolean;
  /** The tier the branch replies on; null = another model. */
  tier: ModelTier | null;
}

/**
 * Under the message box: the Normal | Max switch (TierStore; "Edit Normal
 * and Max…" opens Settings there, where each tier's model is chosen) with
 * what Max costs while it is on, then what the open branch replies on
 * (provider, who pays, model), as a button to where that and web search can
 * be changed at any point of the conversation: Tangent settings in a
 * tangent, and on the main thread Conversation settings, at its replies. A branch's route is where it
 * starts, and every send uses its current one.
 * On the user's own key with none saved in this browser (another device, or
 * it expired), it says so before anything is sent, with one click to
 * Tangent credit (where it can carry on) or to the key.
 */
@Component({
  selector: 'app-route-bar',
  imports: [Icon, Segmented],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'route-bar-host' },
  template: `
    @if (view(); as r) {
      <div class="route-bar">
        @if (r.tiers) {
          <app-segmented
            label="Model tier"
            [options]="tierOptions()"
            [value]="r.tier"
            [disabled]="store.busy() || switching()"
            (changed)="switchTier(r.branch.id, $event)"
          />
        }
        <span class="muted small">Replies on</span>
        <button
          type="button"
          class="route-chip"
          [class.is-warn]="r.missing"
          title="Change the model or who pays"
          [attr.aria-label]="
            'Replies on ' + r.label + ', ' + r.model + '. Change the model or who pays'
          "
          (click)="openSettings(r.branch)"
        >
          <span class="route-chip-text"
            ><strong>{{ r.label }}</strong> · {{ r.model }}</span
          >
          <app-icon name="sliders" [size]="13" />
        </button>
        @if (r.tiers) {
          <button
            type="button"
            class="link-btn small"
            title="Choose the model of each, in Settings"
            (click)="ui.dialogs.open({ kind: 'settings', section: 'tiers' })"
          >
            {{ editTiers }}
          </button>
        }
        @if (r.missing) {
          <span class="route-warn small">No {{ r.label }} key in this browser.</span>
          @if (store.account.creditRoute()) {
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
            (click)="ui.dialogs.open({ kind: 'keys', provider: r.branch.providerId })"
          >
            Add your key
          </button>
        }
      </div>
      @if (r.tier === 'max') {
        <p class="tier-note route-tier-note">{{ maxNote() }}</p>
      }
    }
  `,
})
export class RouteBar {
  protected readonly store = inject(TreeStore);
  protected readonly ui = inject(UiStore);
  private readonly tiers = inject(TierStore);
  protected readonly switching = signal(false);
  /** In the tiers' own words (`TIER_LABELS`). */
  protected readonly editTiers = `Edit ${TIER_LABELS.normal} and ${TIER_LABELS.max}…`;

  /** What Max uses compared with Normal, for the open branch's routes. */
  protected readonly maxNote = computed(() =>
    maxUsageNote(this.tiers.usageFactor(this.store.selectedBranch())),
  );

  protected readonly tierOptions = computed(() => tierOptions(this.maxNote()));

  protected readonly view = computed<RouteView | null>(() => {
    const branch = this.store.selectedBranch();
    if (!branch) return null;
    const tier = this.tiers.tierOfBranch(branch);
    return {
      branch,
      label: this.store.account.providerOf(branch)?.label ?? branch.providerId,
      model: tier ? TIER_LABELS[tier] : this.tiers.modelLabel(branch),
      missing: this.store.account.keyMissing(branch),
      tiers: this.tiers.available(branch),
      tier,
    };
  });

  protected async switchTier(branchId: string, id: string): Promise<void> {
    const tier = TIERS.find((t) => t === id);
    if (!tier) return;
    this.switching.set(true);
    try {
      await this.tiers.switchTier(branchId, tier);
    } finally {
      this.switching.set(false);
    }
  }

  /**
   * Where the branch's route is changed: a tangent's own settings, and the
   * main thread's in the conversation's.
   */
  protected openSettings(branch: Branch): void {
    this.ui.dialogs.open(
      branch.parentBranchId
        ? { kind: 'branch-settings' }
        : { kind: 'tree-settings', section: 'replies' },
    );
  }

  protected async useCredit(branchId: string): Promise<void> {
    this.switching.set(true);
    try {
      await this.store.switchToCredit(branchId);
    } finally {
      this.switching.set(false);
    }
  }
}
