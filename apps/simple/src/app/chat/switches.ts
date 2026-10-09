import { maxUsageNote, type ModelInfo } from '@tangent/shared';
import type { SegmentedOption } from '@tangent/web-shared';

/** What a Learn reply can run on when both are offered (the composer's funding switch). */
export type FundingOption = 'credit' | 'pool';

export const FUNDING_OPTIONS: readonly (SegmentedOption & { id: FundingOption; hint: string })[] = [
  { id: 'credit', label: 'My credit', hint: 'Pay for replies from your own credit' },
  { id: 'pool', label: 'Open pool', hint: 'Use the open pool, within its daily limits' },
];

/** The Normal/Max switch over the provider's models (the tiers come from `ModelInfo.tier`). */
export interface TierSwitch {
  options: readonly SegmentedOption[];
  value: string | null;
  /**
   * Why it is locked (on the open pool, which uses one model), read with
   * the switch; null when it isn't.
   */
  lockedHint: string | null;
  /**
   * The locked hint, when the locked model is none of the listed ones (the
   * pool's "Lite"): no segment could be on, so the hint shows as text in the
   * switch's place (a title alone never reaches touch screens).
   */
  unlisted: string | null;
}

function tierHint(m: ModelInfo): string {
  switch (m.tier) {
    case 'normal':
      return 'Normal: clear, thorough answers';
    case 'max':
      return `Max: our strongest model. ${maxUsageNote(m.usageFactor)}`;
    default:
      return m.label;
  }
}

export function tierSwitch(
  models: readonly ModelInfo[],
  value: string | null,
  lockedHint: string | null,
): TierSwitch {
  return {
    options: models.map((m) => ({ id: m.id, label: m.label, hint: lockedHint ?? tierHint(m) })),
    value,
    lockedHint,
    unlisted: lockedHint !== null && !models.some((m) => m.id === value) ? lockedHint : null,
  };
}
