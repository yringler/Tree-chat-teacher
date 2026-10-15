import type { SegmentedOption } from '@tangent/web-shared';

/** What a Learn reply can run on when both are offered (the composer's funding switch). */
export type FundingOption = 'credit' | 'pool';

export const FUNDING_OPTIONS: readonly (SegmentedOption & { id: FundingOption; hint: string })[] = [
  { id: 'credit', label: 'My credit', hint: 'Pay for replies from your own credit' },
  { id: 'pool', label: 'Open pool', hint: 'Use the open pool, within its daily limits' },
];
