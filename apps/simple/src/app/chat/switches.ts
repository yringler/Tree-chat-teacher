import type { SegmentedOption } from '@tangent/web-shared';

/** What a Learn reply can run on from the composer's funding switch. */
export type FundingOption = 'credit' | 'pool' | 'own-key';

type FundingStop = SegmentedOption & { id: FundingOption; hint: string };

/** The switch while both credit and the pool can pay. */
export const FUNDING_OPTIONS: readonly FundingStop[] = [
  { id: 'credit', label: 'My credit', hint: 'Pay for replies from your own credit' },
  { id: 'pool', label: 'Open pool', hint: 'Use the open pool, within its daily limits' },
];

/** Its third stop, while the learner's own key could reply too: "Anthropic key". */
export function ownKeyOption(provider: string): FundingStop {
  return {
    id: 'own-key',
    label: `${provider} key`,
    hint: `Pay for replies with your own ${provider} API key`,
  };
}
