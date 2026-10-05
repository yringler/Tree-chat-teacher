import { z } from 'zod';
import { PURCHASE_TARGETS } from './billing.js';

/**
 * Admin contract (`/api/admin/*`, the admin app at `/admin/`). Only the
 * operator's own accounts (the ADMIN_USER_IDS secret) get past the server
 * check; to anyone else every admin route is 404.
 */

/** Largest page of `GET /api/admin/users`. */
export const ADMIN_USERS_PAGE = 50;

/** `GET /api/admin/users`: `q` matches an email substring (case-insensitive). */
export const adminUsersQuerySchema = z.object({
  q: z.string().trim().max(320).optional(),
  cursor: z.string().min(1).max(512).optional(),
});
export type AdminUsersQuery = z.infer<typeof adminUsersQuerySchema>;

/** A signed-up user as the admin page lists them. */
export interface AdminUser {
  /** Better Auth user id (what the user sees as "Account ID"). */
  id: string;
  email: string;
  name: string;
  /** ISO timestamp of sign-up. */
  createdAt: string;
  /**
   * The operator allows this user to publish share links while
   * DMCA_AGENT_REGISTERED is off. No effect while it is on.
   */
  shareAllowed: boolean;
  /** Listed in ADMIN_USER_IDS: may always share, and open the admin app. */
  isAdmin: boolean;
  /** Shares of either of the user's accounts that are neither revoked nor expired. */
  activeShares: number;
  /** The operator (or a lost dispute) suspended this user's community pool access. */
  poolSuspended: boolean;
}

/** `GET /api/admin/users`, newest sign-up first. */
export interface AdminUsersResponse {
  users: AdminUser[];
  /** Pass as `cursor` for the next page; null when there are no more users. */
  nextCursor: string | null;
}

/** Either field or both; omitted ones are left as they are. */
export const updateAdminUserRequestSchema = z
  .object({
    shareAllowed: z.boolean().optional(),
    poolSuspended: z.boolean().optional(),
  })
  .refine((r) => r.shareAllowed !== undefined || r.poolSuspended !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateAdminUserRequest = z.infer<typeof updateAdminUserRequestSchema>;

/** `GET /api/admin/status`: what the admin page explains the allowlist against. */
export interface AdminStatusResponse {
  /**
   * DMCA_AGENT_REGISTERED is "true": everyone may share, and the per-user
   * permission has no effect. False: only admins and allowed users may.
   */
  dmcaAgentRegistered: boolean;
}

/** `GET /api/admin/pool/usage`: the last `days` UTC days (today included), `limit` users. */
export const adminPoolUsageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AdminPoolUsageQuery = z.infer<typeof adminPoolUsageQuerySchema>;

/** One user's community pool consumption over the report's days. */
export interface AdminPoolUsageRow {
  userId: string;
  /** Null when the user has been deleted. */
  email: string | null;
  /** Pool replies (released ones, which never reached the model, excluded). */
  requests: number;
  /** Charged plus still held, micro-USD, topic tagging excluded. */
  spendMicros: number;
  /** Topic tagging charged to the pool for the user's exchanges, micro-USD. */
  taggingMicros: number;
  /** ISO timestamp of the user's latest pool call. */
  lastAt: string;
}

/**
 * Today's pool use from one network key (a daily-rotating keyed hash of an
 * IPv4 address or IPv6 /64, never the address): many users on one key is
 * what an account farm looks like.
 */
export interface AdminPoolIpKeyRow {
  ipKey: string;
  users: number;
  requests: number;
  spendMicros: number;
}

/** `GET /api/admin/pool/usage`. */
export interface AdminPoolUsageResponse {
  /** ISO start of the report: 00:00 UTC, `days − 1` days before today. */
  since: string;
  /** Most spend first. */
  rows: AdminPoolUsageRow[];
  /** Today (UTC) only, most users first. */
  ipKeys: AdminPoolIpKeyRow[];
}

/**
 * `GET /api/admin/pool`: the community pool's ledger and its overage breaker,
 * for the admin pool panel (read-only; top-ups and corrections go through
 * `POST /api/admin/credit`).
 */
export interface AdminPoolResponse {
  /** POOL_ENABLED (and a usable built-in provider): the pool takes requests. */
  enabled: boolean;
  /** The pool's ledger account id (POOL_ACCOUNT_ID). */
  accountId: string;
  /** Σ grants − Σ settled charges, micro-USD (pending holds not deducted). */
  balanceMicros: number;
  /** Held by pending reservations, micro-USD. */
  heldMicros: number;
  /** Pending reservations. */
  pendingCalls: number;
  /** `balanceMicros − heldMicros`, floored at 0: what requests can still reserve. */
  availableMicros: number;
  /** Simulated purchases are allowed (DEV_PURCHASES_ENABLED). */
  devPurchasesEnabled: boolean;
  /**
   * The overage breaker (PoolBank): settled overage (charges above their
   * holds) summed over the last `windowMs`; while it exceeds `maxMicros` the
   * pool refuses every request. `tripped` is read from D1 now; PoolBank
   * re-reads it at most once a minute.
   */
  breaker: {
    overageMicros: number;
    maxMicros: number;
    windowMs: number;
    tripped: boolean;
  };
}

/** Largest admin credit, either way, in US cents ($500). */
export const ADMIN_CREDIT_MAX_CENTS = 50_000;

/**
 * `POST /api/admin/credit`: credit (or debit) a user's personal ledger or the
 * community pool without a payment.
 * - `adjustment`: a signed ledger adjustment (goodwill credit, a correction).
 *   A negative pool adjustment is clamped to what the pool has available.
 * - `simulated_purchase`: fulfils a purchase as the payment webhook would (pool:
 *   the buyer becomes a supporter), with no processing fee, so the full amount
 *   is credited. Only where the server allows it (`DEV_PURCHASES_ENABLED`, never in
 *   production); otherwise 404.
 * `idempotencyKey` makes a retry a no-op (`credited: false`).
 */
export const adminCreditRequestSchema = z
  .object({
    target: z.enum(PURCHASE_TARGETS),
    /**
     * The beneficiary (personal: required) or, for the pool, the buyer credited
     * as supporter; omitted or null for an anonymous pool top-up.
     */
    userId: z.string().min(1).nullable().default(null),
    amountCents: z
      .number()
      .int()
      .min(-ADMIN_CREDIT_MAX_CENTS)
      .max(ADMIN_CREDIT_MAX_CENTS)
      .refine((n) => n !== 0, { message: 'amountCents must not be 0' }),
    mode: z.enum(['adjustment', 'simulated_purchase']),
    idempotencyKey: z.string().min(8).max(64),
    note: z.string().max(200).optional(),
  })
  .refine((r) => r.target !== 'personal' || r.userId !== null, {
    message: 'userId is required for personal credit',
    path: ['userId'],
  })
  .refine((r) => r.mode !== 'simulated_purchase' || r.amountCents > 0, {
    message: 'A simulated purchase must be positive',
    path: ['amountCents'],
  });
export type AdminCreditRequest = z.infer<typeof adminCreditRequestSchema>;

/** `POST /api/admin/credit`. */
export interface AdminCreditResponse {
  /** False when `idempotencyKey` was already used: nothing changed. */
  credited: boolean;
  /** The amount the ledger row moved (signed micro-USD; a clamped pool debit moves less than asked). */
  amountMicros: number;
  /** The target ledger's balance afterwards (settled; pending holds not deducted). */
  balanceMicros: number;
}

/**
 * The impact feed's review queue: the first time a topic would be named
 * publicly it is queued `pending` instead; `approved` topics publish from the
 * next weekly snapshot on, `rejected` ones never.
 */
export const POOL_TOPIC_REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type PoolTopicReviewStatus = (typeof POOL_TOPIC_REVIEW_STATUSES)[number];

/** `GET /api/admin/pool/topics`: one status (default `pending`, the queue). */
export const adminPoolTopicsQuerySchema = z.object({
  status: z.enum(POOL_TOPIC_REVIEW_STATUSES).default('pending'),
});
export type AdminPoolTopicsQuery = z.infer<typeof adminPoolTopicsQuerySchema>;

/** A topic in the review queue (or decided). */
export interface AdminPoolTopic {
  /** Taxonomy leaf id. */
  id: string;
  label: string;
  /** Its parent's label (`History` for `history.ancient-rome`). */
  group: string;
  status: PoolTopicReviewStatus;
  /** The week (`YYYY-MM-DD`) it first had enough learners to be named. */
  firstSeenWeek: string;
  /** ISO; null while pending. */
  decidedAt: string | null;
  /** The deciding admin's user id; null while pending. */
  decidedBy: string | null;
  /** On POOL_TOPIC_BLOCKLIST: never published, whatever its status. */
  blocklisted: boolean;
}

/** `GET /api/admin/pool/topics`, oldest first. */
export interface AdminPoolTopicsResponse {
  topics: AdminPoolTopic[];
}

/** `POST /api/admin/pool/topics/:topicId`: approve or reject a queued topic (or change a decision). */
export const adminPoolTopicDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
});
export type AdminPoolTopicDecision = z.infer<typeof adminPoolTopicDecisionSchema>;
