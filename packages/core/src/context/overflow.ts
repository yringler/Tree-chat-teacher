import type { InputOverflow } from '@tangent/shared';
import type { AssembleBudget } from './assemble.js';

/**
 * The budget fields that make `assembleContext` handle a context over its
 * budget the way `overflow` asks (power's setting, `SendMessageRequest.inputOverflow`):
 *
 * - `compact` (and absent): the budget pass's own order, a summary of the
 *   oldest segments first, then dropping the oldest when even that can't fit
 *   (or a summary failed and was left out).
 * - `truncate`: no summary. A summary is assumed infinitely large, so no
 *   prefix ever fits with one and the pass goes straight to its last resort,
 *   dropping the oldest non-system segments (never the target message).
 */
export function overflowBudget(overflow: InputOverflow | undefined): Partial<AssembleBudget> {
  return overflow === 'truncate' ? { compactionSummaryTokens: Number.POSITIVE_INFINITY } : {};
}
