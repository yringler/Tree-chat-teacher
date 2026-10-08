import { z } from 'zod';

/**
 * The open credit pool (docs/pool/SPEC.md): free credit Tangent provides
 * at its discretion (`POOL_FUNDING_TEXT`; nobody buys pool credit), spent at
 * cost by signed-in Learn users on one economical model within daily caps.
 *
 * Who pays for a request's model calls. The server decides it per request
 * from the payment header and the user's credit (never the client alone):
 * - `own-key`: the user's own provider key; nothing is metered.
 * - `personal`: the user's prepaid credit (the built-in provider, metered).
 * - `pool`: the open pool.
 */
export type FundingSource = 'own-key' | 'personal' | 'pool';

/**
 * Why the pool refused a request:
 * - `empty`: the pool can't cover the request right now;
 * - `cap_requests` / `cap_spend`: the user's daily replies or spend;
 * - `cap_ip`: the daily cap of the user's network;
 * - `cap_global`: the pool's daily ceiling, all users together;
 * - `rate`: too many requests this minute;
 * - `unpriced`: the pool can't price its model right now;
 * - `suspended`, `verify`, `duplicate_identity`, `too_new`: the account may not
 *   use the pool (yet).
 */
export const POOL_BLOCK_REASONS = [
  'empty',
  'cap_requests',
  'cap_spend',
  'cap_ip',
  'cap_global',
  'rate',
  'unpriced',
  'suspended',
  'verify',
  'duplicate_identity',
  'too_new',
] as const;
export type PoolBlockReason = (typeof POOL_BLOCK_REASONS)[number];

/** `ApiError.error.pool`: what a pool refusal hit, for the empty and cap-reached states. */
export const poolBlockDetailsSchema = z.object({
  reason: z.enum(POOL_BLOCK_REASONS),
  /** The cap that was hit (replies, or micro-USD of spend); null when no cap applies. */
  limit: z.number().int().nullable(),
  /** When the cap resets (the next 00:00 UTC, ISO); null when no cap applies. */
  resetAt: z.string().nullable(),
});
export type PoolBlockDetails = z.infer<typeof poolBlockDetailsSchema>;

/** The error code of a pool refusal (`ApiErrorCode`), by reason. */
export type PoolErrorCode = 'pool_empty' | 'pool_cap_reached' | 'pool_unavailable';

/**
 * 402 `pool_empty` (empty, or unpriced: either way the pool can't pay now),
 * 429 `pool_cap_reached` (caps and rate limits), 403 `pool_unavailable` (the
 * account may not use the pool).
 */
export function poolErrorCode(reason: PoolBlockReason): PoolErrorCode {
  switch (reason) {
    case 'empty':
    case 'unpriced':
      return 'pool_empty';
    case 'cap_requests':
    case 'cap_spend':
    case 'cap_ip':
    case 'cap_global':
    case 'rate':
      return 'pool_cap_reached';
    default:
      return 'pool_unavailable';
  }
}

/**
 * `POST /api/pool/verify`: a Cloudflare Turnstile token, for accounts with no
 * Turnstile pass on record. The first
 * pool use asks for it (`pool_unavailable`, reason `verify`).
 */
export const poolVerifyRequestSchema = z.object({
  token: z.string().min(1).max(2048),
});
export type PoolVerifyRequest = z.infer<typeof poolVerifyRequestSchema>;

/** `POST /api/pool/verify`: the account may now use the pool (subject to its caps). */
export interface PoolVerifyResponse {
  verified: true;
}

/**
 * The pool's model as the apps and pages name it: its label in Learn's
 * config (a tier's, e.g. "Normal", when the pool runs a tier's model; else
 * the pool's own, "Lite"), and, on a tier's model, how the pool asks it
 * differently from that tier. Absent `thinking` and `replies`: the same as
 * the tier (or no tier to compare with).
 */
export interface PoolModelInfo {
  id: string;
  label: string;
  /** The pool's reasoning effort against the tier's: lower, higher, or not comparable (one sends none). */
  thinking?: 'lighter' | 'more' | 'other';
  /** The pool's reply cap against the tier's. */
  replies?: 'shorter' | 'longer';
}

const THINKING_TEXT: Record<NonNullable<PoolModelInfo['thinking']>, string> = {
  lighter: 'lighter thinking',
  more: 'more thinking',
  other: 'a different thinking setting',
};

/**
 * How the pool asks a tier's model differently, as phrases ("lighter
 * thinking", "shorter replies"); empty when it asks it the same way. Without
 * `replies`, the reply length is left out (for copy that states the cap).
 */
export function poolModelDifferences(
  model: PoolModelInfo,
  opts: { replies?: boolean } = {},
): string[] {
  const parts: string[] = [];
  if (model.thinking) parts.push(THINKING_TEXT[model.thinking]);
  if (model.replies && opts.replies !== false) parts.push(`${model.replies} replies`);
  return parts;
}

/**
 * The pool's model in copy: the tier's label when the pool asks it the same
 * way ("Normal") or the model is no tier ("Lite"), else "Normal's model with
 * lighter thinking and shorter replies" (`poolModelDifferences`).
 */
export function poolModelText(model: PoolModelInfo, opts: { replies?: boolean } = {}): string {
  const parts = poolModelDifferences(model, opts);
  return parts.length === 0 ? model.label : `${model.label}'s model with ${parts.join(' and ')}`;
}

/**
 * `GET /api/pool/status` (public, cached for a minute): the pool meter of the
 * landing page and the apps. Aggregates only; no user data.
 */
export interface PoolStatusResponse {
  /** The pool is on (`POOL_ENABLED` and a usable built-in provider). */
  enabled: boolean;
  /** Credit the pool can still spend (held reservations excluded), micro-USD. */
  availableMicros: number;
  /** About how many learning sessions that covers (`POOL_SESSION_ESTIMATE_MICROS` each). */
  sessionsRemaining: number;
  /** The one model pool replies use, and how the pool asks it (`poolModelText`). */
  model: PoolModelInfo;
}

/**
 * `GET /api/pool/me`: where the caller stands with the pool today. Spend
 * counts replies, summaries and titles (settled charges plus pending holds).
 */
export interface PoolMeResponse {
  /** The caller may be offered the pool (it is on and they are signed in). */
  available: boolean;
  /** A Turnstile pass is on record (otherwise the first pool use asks for one). */
  verified: boolean;
  suspended: boolean;
  caps: {
    requestsPerDay: number;
    spendMicrosPerDay: number;
    usedRequests: number;
    usedSpendMicros: number;
    /** The next 00:00 UTC, ISO. */
    resetAt: string;
  };
  /** The caller's own credit, spendable now (the funding toggle offers it when > 0). */
  personalAvailableMicros: number;
  /** The latest pool notice version the caller acknowledged; null = never. */
  consentVersion: number | null;
  /** The version a pool request needs (`consentVersion` below it: show the notice first). */
  currentNoticeVersion: number;
}

/**
 * The pool notice (docs/pool/SPEC.md), shown before the first pool request. Changing the
 * text means bumping the version: everyone acknowledges the new text before
 * their next pool request (403 `pool_consent_required` until they do).
 */
export const POOL_NOTICE_VERSION = 1;
export const POOL_NOTICE_TEXT =
  "Pool conversations contribute anonymously to aggregate topic stats shown publicly (e.g., 'Roman history: 40 learners this week'). Your questions are never shown.";

/** `ApiError.error.consent` of a 403 `pool_consent_required`: the version to acknowledge. */
export interface PoolConsentDetails {
  currentVersion: number;
}

/** `POST /api/pool/consent`: the notice version the user read and acknowledged. */
export const poolConsentRequestSchema = z.object({
  version: z.number().int().positive(),
});
export type PoolConsentRequest = z.infer<typeof poolConsentRequestSchema>;

/** `POST /api/pool/consent`: the acknowledgment on record (the first one, on a repeat). */
export interface PoolConsentResponse {
  version: number;
  /** ISO. */
  acknowledgedAt: string;
}

/**
 * The empty state, wherever it shows. Only Tangent adds credit to
 * the pool (`POOL_FUNDING_TEXT`), so the copy never says people refill it.
 */
export const POOL_EMPTY_TEXT = 'The open pool is empty until Tangent adds more credit.';

/** `about 1,240 learning sessions`; `1` is singular and 0 reads "no learning sessions". */
export function poolSessionsText(sessions: number): string {
  const n = Math.max(0, Math.floor(sessions));
  if (n === 0) return 'no learning sessions';
  return `about ${n.toLocaleString('en-US')} learning ${n === 1 ? 'session' : 'sessions'}`;
}

/** The meter's headline: `About 1,240 learning sessions` (or `No learning sessions`). */
export function poolSessionsHeadline(sessions: number): string {
  const text = poolSessionsText(sessions);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Where the pool's credit comes from, as every public page states it
 * (docs/DECISIONS.md): Tangent adds it with admin adjustments. Nobody can buy
 * credit for the pool.
 */
export const POOL_FUNDING_TEXT = 'The open pool is free credit Tangent provides.';

/** The pool's motto: Tangent, not its customers, keeps learning open. */
export const POOL_MOTTO = 'Tangent keeps learning open.';

/**
 * How the pool comes about, as three short steps for the landing and pricing
 * pages. Tangent is the subject of every step that moves money: a customer
 * pays for Tangent, never for someone else's learning (docs/DECISIONS.md).
 */
export function poolSteps(memberships: boolean): [string, string, string] {
  return [
    `Tangent earns money from ${memberships ? 'memberships and credit' : 'the credit people buy'}, like any software business.`,
    'It sets aside free credit as the open pool.',
    'Anyone signed in can learn free from the pool, within daily limits, while it has credit.',
  ];
}

/** What a pool reply costs the pool: its true cost, with no markup (Tangent funds the pool). */
export const POOL_AT_COST_TEXT =
  "Each pool reply is charged to the pool at the AI provider's price, with no markup, and costs the learner nothing.";

/**
 * Words pool copy must never use: the pool is free credit Tangent provides,
 * not a donation, a sponsorship or anything people pay into (spec reasoning
 * 3; the payment provider's acceptable use policy, docs/DECISIONS.md).
 * Tests run every pool page and template through it. "Contribute" isn't
 * here: the pool notice uses it for the topic tags.
 */
export const FORBIDDEN_POOL_COPY =
  /donat|donor|tax[- ]?deductible|charit|sponsor|crowdfund|patron|pledge|give back|pay(s|ing)? it forward|helped|supporter|community/i;
