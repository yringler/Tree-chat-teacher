import { z } from 'zod';

/**
 * The community credit pool (docs/pool/SPEC.md): credit anyone may add, spent
 * by signed-in Learn users on one economical model within daily caps.
 *
 * Who pays for a request's model calls. The server decides it per request
 * from the payment header and the user's credit (never the client alone):
 * - `own-key`: the user's own provider key; nothing is metered.
 * - `personal`: the user's prepaid credit (the built-in provider, metered).
 * - `pool`: the community pool.
 */
export type FundingSource = 'own-key' | 'personal' | 'pool';

/**
 * Why the pool refused a request:
 * - `empty`: the pool can't cover the request right now;
 * - `cap_requests` / `cap_spend`: the user's daily replies or spend;
 * - `cap_ip`: the daily cap of the user's network;
 * - `cap_global`: the free tier's daily ceiling, all users together;
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
  /** Whether the user has the supporter caps. */
  supporter: z.boolean(),
  /** The same cap for supporters, for "supporters get more"; null when it doesn't differ. */
  supporterLimit: z.number().int().nullable(),
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
 * Turnstile pass on record (they predate the check at sign-in). The first
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
