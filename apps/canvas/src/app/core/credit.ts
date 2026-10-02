import type { BillingSummary } from '@tangent/shared';
import { creditFeeText } from '@tangent/web-shared';

/**
 * The one line that says what a call on Tangent credit costs (the power
 * app's wording in apps/web/src/app/ui/credit.ts; canvas doesn't import from
 * apps/web).
 */
export function feeSentence(b: Pick<BillingSummary, 'openRouterFeeBps' | 'markupBps'>): string {
  return `Each call costs ${creditFeeText(b.markupBps, b.openRouterFeeBps)}, taken from your credit.`;
}
