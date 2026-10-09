import { z } from './zod.js';
import { generationLimitsShape } from './api.js';
import type { BranchFunding, TokenUsage } from './domain.js';

/**
 * Reviewer ("fact check up to here"). A second, usually stronger, model reads
 * the conversation exactly as the branch's model saw it, up to and including
 * one assistant message, and reports corrections plus whether the thread
 * should continue on a more capable model.
 *
 *   POST /api/nodes/:nodeId/review  ReviewRequest -> text/event-stream of ReviewEvent
 *
 * Reviews are not stored: they are advice about the tree, not part of it, so
 * they never enter the context of later replies unless the user sends them.
 */

export const reviewRequestSchema = z.object({
  providerId: z.string().min(1).max(64),
  /** How power pays for the reviewer (default `own-key`); Learn pays per request. */
  funding: z.enum(['own-key', 'credit']).optional() satisfies z.ZodType<BranchFunding | undefined>,
  model: z.string().min(1).max(200),
  /**
   * Power's reply length (the review's cap) and input limit (what of the
   * conversation the reviewer reads), as on a send (Learn sends none).
   */
  ...generationLimitsShape,
});
export type ReviewRequest = z.infer<typeof reviewRequestSchema>;

/**
 * Order: (`status`)* → (`delta`)* → exactly one of `done` | `error`.
 * Same SSE framing as StreamEvent (`event: <type>\ndata: <json>\n\n`).
 */
export type ReviewEvent =
  | { type: 'status'; message: string }
  | { type: 'delta'; text: string }
  | {
      type: 'done';
      providerId: string;
      funding: BranchFunding;
      model: string;
      usage: TokenUsage | null;
    }
  | { type: 'error'; message: string };

export const REVIEW_EVENT_TYPES: ReadonlySet<string> = new Set<ReviewEvent['type']>([
  'status',
  'delta',
  'done',
  'error',
]);

export type ReviewAccuracy = 'ok' | 'minor' | 'major';
export type ReviewRecommendation = 'stay' | 'upgrade';

/**
 * Machine-readable trailer the reviewer is asked to end with. The prompt
 * (in @tangent/core) and the parser below share these so they can't drift.
 */
export const REVIEW_ACCURACY_LABEL = 'ACCURACY';
export const REVIEW_RECOMMENDATION_LABEL = 'RECOMMENDATION';
export const REVIEW_ACCURACY_VALUES = { OK: 'ok', MINOR: 'minor', MAJOR: 'major' } as const;
export const REVIEW_RECOMMENDATION_VALUES = { STAY: 'stay', UPGRADE: 'upgrade' } as const;

export interface ParsedReview {
  /** The review with the trailer lines removed. */
  body: string;
  /** null when the reviewer didn't emit (or garbled) the line. */
  accuracy: ReviewAccuracy | null;
  recommendation: ReviewRecommendation | null;
}

const TRAILER = /^[\s>*_`-]*(ACCURACY|RECOMMENDATION)[\s*_`]*:[\s*_`]*([A-Za-z_]+)[\s*_`.]*$/i;

/**
 * Splits a (possibly still streaming) review into its prose and verdict.
 * Lenient on purpose: models wrap the trailer in bold/backticks or add a
 * period. The last occurrence of each label wins.
 */
export function parseReview(text: string): ParsedReview {
  let accuracy: ReviewAccuracy | null = null;
  let recommendation: ReviewRecommendation | null = null;
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = TRAILER.exec(line);
    if (!m) {
      kept.push(line);
      continue;
    }
    const label = m[1]!.toUpperCase();
    const value = m[2]!.toUpperCase();
    if (label === REVIEW_ACCURACY_LABEL) {
      const v = lookup(REVIEW_ACCURACY_VALUES, value.replace(/_ISSUES?$/, ''));
      if (v) accuracy = v;
    } else {
      const v = lookup(REVIEW_RECOMMENDATION_VALUES, value);
      if (v) recommendation = v;
    }
  }
  return { body: kept.join('\n').trim(), accuracy, recommendation };
}

function lookup<T extends string>(table: Readonly<Record<string, T>>, key: string): T | null {
  return Object.hasOwn(table, key) ? (table[key] ?? null) : null;
}
