import {
  formatMicros,
  POOL_EMPTY_TEXT,
  poolSessionsHeadline,
  poolWeekText,
  type PoolBlockDetails,
  type PoolStatusResponse,
} from '@tangent/shared';
import { ApiError, isPoolCapReached, isPoolEmpty } from '../core/api-client';

/*
 * The open pool as both apps word it: the meter and the inline empty and
 * cap-reached states. Plain functions, so the specs check the exact copy.
 * The pool is free credit Tangent provides (`poolFundingText`); nothing here
 * offers it for sale, and nothing calls it a donation.
 */

/** `About 120 learning sessions`, the meter's headline. */
export function sessionsLabel(status: Pick<PoolStatusResponse, 'sessionsRemaining'>): string {
  return poolSessionsHeadline(status.sessionsRemaining);
}

/** `$2.40 in the pool`, next to the sessions. */
export function poolDollarsLabel(status: Pick<PoolStatusResponse, 'availableMicros'>): string {
  return `${formatMicros(status.availableMicros)} in the pool`;
}

/** `This week: 12 learners, 340 free replies`. */
export function poolWeekLabel(status: Pick<PoolStatusResponse, 'week'>): string {
  return poolWeekText(status.week);
}

/**
 * A refused pool request, as the chat shows it inline (never as a generic
 * error): `empty` (402 `pool_empty`) or `cap` (429 `pool_cap_reached`), with
 * what was hit.
 */
export interface PoolBlock {
  kind: 'empty' | 'cap';
  details: PoolBlockDetails;
}

/** The inline state of a pool refusal; null for any other error. */
export function poolBlockOf(err: unknown): PoolBlock | null {
  if (!isPoolEmpty(err) && !isPoolCapReached(err)) return null;
  const kind = isPoolEmpty(err) ? 'empty' : 'cap';
  const details = (err as ApiError).pool ?? {
    reason: kind === 'empty' ? 'empty' : 'cap_requests',
    limit: null,
    resetAt: null,
  };
  return { kind, details };
}

/** `5 h`, `40 min`, `a minute` until `resetAt`. */
export function untilText(resetAt: string, now: Date): string {
  const ms = Math.max(0, new Date(resetAt).getTime() - now.getTime());
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return 'a minute';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

/** The words of an inline pool state: a headline and, mostly, when or how to try again. */
export interface PoolBlockText {
  title: string;
  detail: string | null;
}

function limitText(reason: PoolBlockDetails['reason'], limit: number): string {
  return reason === 'cap_spend'
    ? `${formatMicros(limit)} of open-pool use`
    : `${limit.toLocaleString('en-US')} open-pool ${limit === 1 ? 'reply' : 'replies'}`;
}

/**
 * What the chat says when the pool refused a message:
 * - empty: `POOL_EMPTY_TEXT` (Tangent refills it);
 * - a daily cap: the cap and when it resets (one set of caps for everyone,
 *   paying or not, so there is no higher tier to point to);
 * - the network's or everyone's daily ceiling: "busy today";
 * - per-minute: try again in a minute.
 */
export function poolBlockText(block: PoolBlock, now: Date = new Date()): PoolBlockText {
  const d = block.details;
  if (block.kind === 'empty') {
    return d.reason === 'unpriced'
      ? {
          title: "The open pool is paused for a moment. It isn't taking replies right now.",
          detail: 'Try again later.',
        }
      : { title: POOL_EMPTY_TEXT, detail: null };
  }
  const reset = d.resetAt ? `00:00 UTC (in ${untilText(d.resetAt, now)})` : '00:00 UTC';
  switch (d.reason) {
    case 'rate':
      return {
        title: "You're sending messages faster than the open pool allows.",
        detail: `Try again in ${d.resetAt ? untilText(d.resetAt, now) : 'a minute'}.`,
      };
    case 'cap_ip':
    case 'cap_global':
      return {
        title: 'The open pool is busy today.',
        detail: `It resets at ${reset}.`,
      };
    default: {
      const title =
        d.limit === null
          ? "You've reached today's open-pool limit."
          : `You've used today's ${limitText(d.reason, d.limit)}.`;
      return { title, detail: `The limit resets at ${reset}.` };
    }
  }
}
