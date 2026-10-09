import { inject, Injectable } from '@angular/core';
import {
  isModelAllowed,
  routeKey,
  TIER_LABELS,
  TIERS,
  tierModel,
  type Branch,
  type BranchFunding,
  type ModelTier,
  type ProviderInfo,
} from '@tangent/shared';
import {
  ComposerController,
  suggestionText,
  ToastStore,
  type SegmentedOption,
} from '@tangent/web-shared';
import { type ModelChoice, SettingsStore } from './settings-store';
import { TreeStore } from './tree-store';
import { UiStore } from './ui-store';

/** The route a tier choice is resolved against: a branch's provider and who pays. */
export type TierRoute = { providerId: string; funding?: BranchFunding };

/** The choice of `model` on provider entry `p`. */
function choiceOn(p: ProviderInfo, model: string): ModelChoice {
  return {
    providerId: p.id,
    ...(p.funding === 'credit' ? { funding: 'credit' as const } : {}),
    model,
  };
}

/** Two choices name the same route and model. */
export function sameChoice(a: ModelChoice, b: TierRoute & { model: string }): boolean {
  return routeKey(a) === routeKey(b) && a.model === b.model;
}

/** The Normal | Max switch's options (route bar, home page); `maxNote` is `maxUsageNote`. */
export function tierOptions(maxNote: string): SegmentedOption[] {
  return TIERS.map((tier) => ({
    id: tier,
    label: TIER_LABELS[tier],
    hint:
      tier === 'max'
        ? `${TIER_LABELS.max}: the strongest model. ${maxNote}`
        : `${TIER_LABELS.normal}: clear, thorough answers`,
  }));
}

/**
 * Normal and Max in power: which provider and model each tier means (the
 * user's own pick in Settings, else the suggested model of that tier), for
 * the Normal | Max switch under the message box, the home page and Compare.
 * Providers mark their tier models (`ModelInfo.tier`): the own-key
 * OpenRouter suggestions and Tangent credit both list one of each.
 */
@Injectable({ providedIn: 'root' })
export class TierStore {
  private readonly tree = inject(TreeStore);
  private readonly settings = inject(SettingsStore);
  private readonly ui = inject(UiStore);
  private readonly composer = inject(ComposerController);
  private readonly toast = inject(ToastStore);

  /**
   * The provider and model of `tier`, for a message in `branch` (null = a new
   * conversation): the saved choice (Settings) while its route is usable and
   * allows the model, else the suggested one (`suggested`). Null when none.
   */
  choice(tier: ModelTier, branch?: TierRoute | null): ModelChoice | null {
    const saved = this.settings.settings().tiers[tier];
    if (saved) {
      const p = this.tree.account.providerOf(saved);
      if (this.usable(p) && isModelAllowed(p, saved.model)) return choiceOn(p, saved.model);
    }
    return this.suggested(tier, branch);
  }

  /**
   * The model a provider marks as `tier`: on the branch's own route, so
   * switching keeps who pays; else on the default route; else on the first
   * usable route listing one (own keys come before credit). Never a route
   * whose funding needs the membership the user lacks.
   */
  suggested(tier: ModelTier, branch?: TierRoute | null): ModelChoice | null {
    // The branch's own route and the default one may lack a key in this
    // browser: the route bar says so, and sending asks for it.
    const listed = (p: ProviderInfo | null | undefined): ModelChoice | null => {
      const m = this.open(p) ? tierModel(p.models, tier) : undefined;
      return p && m ? choiceOn(p, m.id) : null;
    };
    return (
      (branch ? listed(this.tree.account.providerOf(branch)) : null) ??
      listed(this.tree.account.defaultProvider()) ??
      this.tree.account
        .providers()
        .filter((p) => this.usable(p))
        .map(listed)
        .find((c) => c !== null) ??
      null
    );
  }

  /** The tier `branch` replies on (its route and model are that tier's choice); null = another model. */
  tierOfBranch(branch: Pick<Branch, 'providerId' | 'funding' | 'model'>): ModelTier | null {
    for (const tier of TIERS) {
      const c = this.choice(tier, branch);
      if (c && sameChoice(c, branch)) return tier;
    }
    return null;
  }

  /**
   * About how many Normal replies one Max reply uses, when known: the
   * server's `ModelInfo.usageFactor`, which prices an entry's suggested Max
   * against that entry's suggested Normal. So only that pair gets a number;
   * with a custom Normal or Max (Settings) it is undefined and the note stays
   * vague rather than wrong.
   */
  usageFactor(branch?: TierRoute | null): number | undefined {
    const normal = this.choice('normal', branch);
    const max = this.choice('max', branch);
    if (!normal || !max) return undefined;
    const models = this.tree.account.providerOf(max)?.models ?? [];
    const suggestedMax = tierModel(models, 'max');
    if (tierModel(models, 'normal')?.id !== normal.model || suggestedMax?.id !== max.model)
      return undefined;
    return suggestedMax.usageFactor;
  }

  /** Both tiers resolve, to different models: the switch and Compare are offered. */
  available(branch?: TierRoute | null): boolean {
    const normal = this.choice('normal', branch);
    const max = this.choice('max', branch);
    return !!normal && !!max && !sameChoice(normal, max);
  }

  /**
   * What a choice's model is called, beside its tier's name: its label on
   * its route, or its id where the label only names the tier ("Max
   * (suggested)" reads "claude-sonnet-5.5") or it isn't listed.
   */
  modelLabel(choice: ModelChoice): string {
    const m = this.tree.account.providerOf(choice)?.models.find((x) => x.id === choice.model);
    if (!m) return choice.model;
    const text = suggestionText(m);
    return TIERS.some((t) => TIER_LABELS[t] === text.name) ? (text.id ?? m.id) : text.name;
  }

  private open(p: ProviderInfo | null | undefined): p is ProviderInfo {
    return !!p && !this.tree.account.routeLocked(p);
  }

  /** Has a key (or needs none) and isn't locked. */
  private usable(p: ProviderInfo | null | undefined): p is ProviderInfo {
    return this.open(p) && p.available;
  }

  /**
   * The Normal | Max switch: moves the branch onto the tier's choice, like
   * `TreeStore.switchToCredit` (every later send uses it). The notice names
   * the new route when the tier lives on another one (e.g. a branch on a
   * provider without tiers moves to Tangent credit). Resolves true once the
   * server has it.
   */
  async switchTier(branchId: string, tier: ModelTier): Promise<boolean> {
    const branch = this.tree.index()?.branches.get(branchId);
    const target = branch ? this.choice(tier, branch) : null;
    if (!branch || !target) return false;
    const ok = await this.tree.updateBranch(branch.id, {
      providerId: target.providerId,
      funding: target.funding ?? 'own-key',
      model: target.model,
    });
    if (ok) {
      const moved = routeKey(target) !== routeKey(branch);
      const where = moved
        ? ` (${this.tree.account.providerOf(target)?.label ?? target.providerId})`
        : '';
      this.toast.notify(`Replies now on ${TIER_LABELS[tier]}${where}`);
      this.composer.focus();
    }
    return ok;
  }
}
