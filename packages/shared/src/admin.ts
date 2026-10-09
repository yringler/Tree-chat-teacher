import { z } from './zod.js';

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
  /** The operator (or a lost dispute) suspended this user's open pool access. */
  poolSuspended: boolean;
  /**
   * The user's prepaid credit (their `u_<id>` ledger, shared by both apps),
   * micro-USD: Σ grants − Σ settled charges, pending holds not deducted (like
   * `AdminCreditResponse.balanceMicros`). Changed with `POST /api/admin/credit`.
   */
  creditBalanceMicros: number;
  /**
   * The operator waived the membership for this user (`auth_users.membership_waived`):
   * a member whatever their subscription says, while the membership is required.
   * Set here or by redeeming MEMBERSHIP_WAIVER_CODE.
   */
  membershipWaived: boolean;
  /** The user has a paid membership subscription that counts (active, trialing or past due). */
  membershipPaid: boolean;
}

/** `GET /api/admin/users`, newest sign-up first. */
export interface AdminUsersResponse {
  users: AdminUser[];
  /** Pass as `cursor` for the next page; null when there are no more users. */
  nextCursor: string | null;
}

/** Any of the fields; omitted ones are left as they are. */
export const updateAdminUserRequestSchema = z
  .object({
    shareAllowed: z.boolean().optional(),
    poolSuspended: z.boolean().optional(),
    /** Makes the user a member without a payment (or takes that back; a paid membership stays). */
    membershipWaived: z.boolean().optional(),
  })
  .refine(
    (r) =>
      r.shareAllowed !== undefined ||
      r.poolSuspended !== undefined ||
      r.membershipWaived !== undefined,
    { message: 'Nothing to update' },
  );
export type UpdateAdminUserRequest = z.infer<typeof updateAdminUserRequestSchema>;

/** `GET /api/admin/status`: what the admin page explains the allowlist against. */
export interface AdminStatusResponse {
  /**
   * DMCA_AGENT_REGISTERED is "true": everyone may share, and the per-user
   * permission has no effect. False: only admins and allowed users may.
   */
  dmcaAgentRegistered: boolean;
  /**
   * The membership is required (ANNUAL_FEE_ENABLED and the payment provider
   * sells it). False: nobody needs one, so a waiver changes nothing until it is.
   */
  membershipRequired: boolean;
}

/** `GET /api/admin/pool/usage`: the last `days` UTC days (today included), `limit` users. */
export const adminPoolUsageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AdminPoolUsageQuery = z.infer<typeof adminPoolUsageQuerySchema>;

/** One user's open pool consumption over the report's days. */
export interface AdminPoolUsageRow {
  userId: string;
  /** Null when the user has been deleted. */
  email: string | null;
  /** Pool replies (released ones, which never reached the model, excluded). */
  requests: number;
  /** Charged plus still held, micro-USD. */
  spendMicros: number;
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
 * `GET /api/admin/pool`: the open pool's ledger and its overage breaker,
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

/** The ledgers an admin can credit: a user's own, or the open pool. */
export const ADMIN_CREDIT_TARGETS = ['personal', 'pool'] as const;

/** Largest admin credit, either way, in US cents ($500). */
export const ADMIN_CREDIT_MAX_CENTS = 50_000;

/**
 * `POST /api/admin/credit`: credit (or debit) a user's personal ledger or the
 * open pool without a payment.
 * - `adjustment`: a signed ledger adjustment (goodwill credit, a correction, or
 *   the operator adding credit to the pool). A negative pool adjustment is
 *   clamped to what the pool has available.
 * - `simulated_purchase`: fulfils a personal purchase as the payment webhook
 *   would, with no processing fee, so the full
 *   amount is credited. Personal only: nobody buys credit for the pool. Only
 *   where the server allows it (`DEV_PURCHASES_ENABLED`, never in production);
 *   otherwise 404.
 * `idempotencyKey` makes a retry a no-op (`credited: false`).
 */
export const adminCreditRequestSchema = z
  .object({
    target: z.enum(ADMIN_CREDIT_TARGETS),
    /**
     * The beneficiary (personal: required) or, for the pool, the user the
     * adjustment is recorded for; omitted
     * or null for an operator top-up of the pool.
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
  .refine((r) => r.mode !== 'simulated_purchase' || r.target === 'personal', {
    message: 'Only personal credit can be bought',
    path: ['target'],
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
