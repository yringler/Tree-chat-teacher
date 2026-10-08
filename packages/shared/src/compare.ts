import { z } from 'zod';
import type { Branch, BranchFunding, ChatNode, TokenUsage } from './domain.js';
import type { Citation } from './grounding.js';
import { fromLegacyRoute } from './route.js';

/**
 * Compare ("ask Normal and Max, keep one"). Each model answers the same
 * question as a candidate reply to the branch's current leaf; the user picks
 * one and only that exchange enters the tree. The client streams one request
 * per candidate:
 *
 *   POST /api/branches/:branchId/candidates  CandidateRequest -> text/event-stream of CandidateEvent
 *     Order: (`status`)* → (`delta`)* → exactly one of `done` | `error`.
 *     Nothing is stored in the tree until a commit; the Worker holds a
 *     finished candidate for `CANDIDATE_TTL_MS`.
 *
 *   POST /api/branches/:branchId/candidates/:candidateId/commit  (no body) -> CommitCandidateResponse
 *     Appends the question and the candidate's answer to the branch.
 *     404 unknown or another account's candidate, 409 the branch moved on
 *     (or a reply is streaming), 410 expired; 403 on the open pool.
 *
 * Every candidate is a metered reply, so comparing uses both models' usage.
 */

/** How long a finished candidate can still be committed. */
export const CANDIDATE_TTL_MS = 30 * 60_000;

export const candidateRequestSchema = z
  .object({
    /** The question, as the user would send it. */
    content: z.string().min(1).max(200_000),
    /** Absent = the branch's route (Learn always omits it). */
    providerId: z.string().min(1).max(64).optional(),
    /** How power pays for this candidate (default `own-key`); Learn pays per request. */
    funding: z.enum(['own-key', 'credit']).optional() satisfies z.ZodType<
      BranchFunding | undefined
    >,
    model: z.string().min(1).max(200),
  })
  .transform(fromLegacyRoute);
export type CandidateRequest = z.infer<typeof candidateRequestSchema>;

/**
 * Same SSE framing as StreamEvent (`event: <type>\ndata: <json>\n\n`).
 * `done` carries what the commit route needs (`candidateId`) and when it
 * stops accepting it (`expiresAt`, ISO).
 */
export type CandidateEvent =
  | { type: 'status'; message: string }
  | { type: 'delta'; text: string }
  | {
      type: 'done';
      candidateId: string;
      providerId: string;
      funding: BranchFunding;
      model: string;
      usage: TokenUsage | null;
      sources: Citation[] | null;
      expiresAt: string;
    }
  | { type: 'error'; message: string };

export const CANDIDATE_EVENT_TYPES: ReadonlySet<string> = new Set<CandidateEvent['type']>([
  'status',
  'delta',
  'done',
  'error',
]);

/** The exchange a commit appended, and the branch after it (it may have been auto-titled). */
export interface CommitCandidateResponse {
  userNode: ChatNode;
  assistantNode: ChatNode;
  branch: Branch;
}
