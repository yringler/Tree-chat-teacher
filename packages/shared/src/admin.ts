import type { ShareSummary } from './api.js';
import type { ShareTakedown } from './domain.js';
import { z } from './zod.js';

/**
 * Admin contract (`/api/admin/*`, the admin app at `/admin/`). Only the
 * operator's own accounts (the ADMIN_USER_IDS secret) get past the server
 * check; to anyone else every admin route is 404.
 */

/**
 * Who may publish share links and whose links open (`SHARING`): nobody
 * (admins included), admins and the users the operator allowed, or everyone.
 */
export const SHARING_MODES = ['off', 'allowlist', 'everyone'] as const;
export type SharingMode = (typeof SHARING_MODES)[number];

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
   * The operator allows this user to publish share links while `SHARING` is
   * `allowlist`. No effect under `off` or `everyone`.
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
  /**
   * The user may not publish, and their links don't open
   * (`auth_users.sharing_suspended`): set here, or by the strike rule when a
   * second of their shares is removed after a report.
   */
  sharingSuspended: boolean;
  /** The user's shares an admin removed (`takedown = 'removed'`). */
  removedShares: number;
  /** Reports of the user's shares no admin has decided yet. */
  openReports: number;
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
    /** Stops the user publishing and takes their links down (or lifts that). */
    sharingSuspended: z.boolean().optional(),
  })
  .refine(
    (r) =>
      r.shareAllowed !== undefined ||
      r.poolSuspended !== undefined ||
      r.membershipWaived !== undefined ||
      r.sharingSuspended !== undefined,
    { message: 'Nothing to update' },
  );
export type UpdateAdminUserRequest = z.infer<typeof updateAdminUserRequestSchema>;

/** `GET /api/admin/status`: what the admin page explains the allowlist against. */
export interface AdminStatusResponse {
  /**
   * `SHARING`: `everyone` may share and the per-user permission has no
   * effect; `allowlist`: only admins and allowed users may; `off`: nobody may
   * and no link opens.
   */
  sharing: SharingMode;
  /**
   * The membership is required (ANNUAL_FEE_ENABLED and the payment provider
   * sells it). False: nobody needs one, so a waiver changes nothing until it is.
   */
  membershipRequired: boolean;
  /**
   * `SHARING` says `everyone` but `MODERATION_API_KEY` is missing, so nothing
   * would be screened and `sharing` reads `allowlist` instead.
   */
  moderationKeyMissing: boolean;
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
 * - `simulated_purchase`: fulfils a personal purchase of `amountCents` of
 *   credit as the payment webhook would, recorded as paid with its service
 *   fee. Personal only: nobody buys credit for the pool. Only
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

/** What a report from a share page says is wrong with the conversation (`share_reports.category`). */
export const REPORT_CATEGORIES = [
  'copyright',
  'defamation',
  'violent_or_illegal',
  'csam',
  'harassment_privacy',
  'other',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/**
 * Why evidence is held (`legal_holds.reason`): apparent child sexual abuse
 * material, violent or other illegal content, a law-enforcement request, or
 * anything else the operator must preserve.
 */
export const LEGAL_HOLD_REASONS = [
  'csam',
  'violent_or_illegal',
  'law_enforcement',
  'other',
] as const;
export type LegalHoldReason = (typeof LEGAL_HOLD_REASONS)[number];

/** Where a hold was reported: NCMEC's CyberTipline, or a law-enforcement agency. */
export const HOLD_REPORT_KINDS = ['ncmec', 'law_enforcement'] as const;
export type HoldReportKind = (typeof HOLD_REPORT_KINDS)[number];

/**
 * A legal hold as the admin page lists it: what it is about and who placed
 * and released it, never the held copies (only `wrangler d1 execute` reads
 * those, docs/runbooks/csam.md).
 */
export interface AdminHold {
  id: string;
  reason: LegalHoldReason;
  reportId: string | null;
  shareId: string | null;
  /** The share owner's user id, kept after their account is deleted. */
  subjectUserId: string | null;
  subjectEmail: string | null;
  /** ISO timestamp. */
  createdAt: string;
  /** The admin who placed it; null when the system did. */
  createdBy: string | null;
  /** ISO timestamp; null while the hold is in force. */
  releasedAt: string | null;
  releasedBy: string | null;
  notes: string | null;
  /** Reports of the hold filed outside Tangent, oldest first. */
  externalReports: { kind: HoldReportKind; reference: string; at: string }[];
}

/** `GET /api/admin/holds`: every hold, newest first; released ones too. */
export interface AdminHoldsResponse {
  holds: AdminHold[];
}

/** `POST /api/admin/shares/:shareId/hold`. */
export const adminPlaceHoldRequestSchema = z.object({
  reason: z.enum(LEGAL_HOLD_REASONS),
  notes: z.string().trim().max(2000).optional(),
});
export type AdminPlaceHoldRequest = z.infer<typeof adminPlaceHoldRequestSchema>;

/** `POST /api/admin/holds/:holdId/release`. */
export const adminReleaseHoldRequestSchema = z.object({
  notes: z.string().trim().max(2000).optional(),
});
export type AdminReleaseHoldRequest = z.infer<typeof adminReleaseHoldRequestSchema>;

/**
 * `POST /api/admin/holds/:holdId/external-report`: records that the hold was
 * reported (the report itself is filed by hand), with the report's number.
 */
export const adminHoldReportRequestSchema = z.object({
  kind: z.enum(HOLD_REPORT_KINDS),
  reference: z.string().trim().min(1).max(200),
});
export type AdminHoldReportRequest = z.infer<typeof adminHoldReportRequestSchema>;

/**
 * A share as the admin page lists it: the owner's view (`ShareSummary`, whose
 * `state` says only `unavailable`) plus why it is down.
 */
export interface AdminShare extends ShareSummary {
  /** `pending_review` after a report, `removed` by an admin; null while it is up. */
  takedown: ShareTakedown | null;
}

/** Where a report stands (`share_reports.resolution`): undecided, acted on (a strike), or rejected. */
export const REPORT_RESOLUTIONS = ['pending', 'actioned', 'rejected'] as const;
export type ReportResolution = (typeof REPORT_RESOLUTIONS)[number];

/** Largest page of `GET /api/admin/reports` and `GET /api/admin/users/:userId/events`. */
export const ADMIN_MODERATION_PAGE = 50;

/** `GET /api/admin/reports`: the undecided ones, oldest first, or every report, newest first. */
export const adminReportsQuerySchema = z.object({
  status: z.enum(['pending', 'all']).default('pending'),
  cursor: z.string().min(1).max(512).optional(),
});
export type AdminReportsQuery = z.infer<typeof adminReportsQuerySchema>;

/** Where the reported share is now. */
export type AdminReportShareState =
  'active' | 'pending_review' | 'removed' | 'revoked' | 'expired' | 'deleted';

/** A report from a share page, as the admin queue lists it. */
export interface AdminReport {
  id: string;
  shareId: string;
  shareToken: string;
  /** The share owner's user id; null for an account that isn't a user's (the dev bypass). */
  ownerUserId: string | null;
  /** Null once the account is deleted and no hold kept the address. */
  ownerEmail: string | null;
  category: ReportCategory;
  /** The reporter's words. */
  details: string;
  /** Given for a reply; null when the reporter left none. */
  reporterEmail: string | null;
  /** ISO timestamp. */
  createdAt: string;
  resolution: ReportResolution;
  resolvedAt: string | null;
  /** The deciding admin's user id. */
  resolvedBy: string | null;
  notes: string | null;
  shareState: AdminReportShareState;
  /** Different people who reported the share, this one included, however decided. */
  shareReporters: number;
  /** A legal hold of the share is in force. */
  held: boolean;
}

/** `GET /api/admin/reports`. */
export interface AdminReportsResponse {
  reports: AdminReport[];
  /** Pass as `cursor` for the next page; null when there are no more reports. */
  nextCursor: string | null;
}

/**
 * What an admin decides about a report: `remove` takes the share down for
 * good and counts a strike against its owner; `restore` puts it back up and
 * rejects its reports (so a removal's strike goes); `reject` rejects this
 * report only, putting the share back up when nothing left pending would
 * have taken it down.
 */
export const REPORT_ACTIONS = ['remove', 'restore', 'reject'] as const;
export type ReportAction = (typeof REPORT_ACTIONS)[number];

/** `POST /api/admin/reports/:reportId/resolve`. */
export const adminResolveReportRequestSchema = z.object({
  action: z.enum(REPORT_ACTIONS),
  notes: z.string().trim().max(2000).optional(),
});
export type AdminResolveReportRequest = z.infer<typeof adminResolveReportRequestSchema>;

/** `GET /api/admin/users/:userId/events`: the newest first. */
export const adminUserEventsQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
});
export type AdminUserEventsQuery = z.infer<typeof adminUserEventsQuerySchema>;

/** One row of the moderation audit log about a user: ids and metadata, never content. */
export interface AdminAuditEvent {
  id: string;
  /** ISO timestamp. */
  at: string;
  /** `share_created`, `report_received`, `share_takedown`, `sharing_suspended`, … */
  kind: string;
  actor: 'user' | 'admin' | 'system' | 'reporter';
  actorUserId: string | null;
  shareId: string | null;
  reportId: string | null;
  holdId: string | null;
  /** The event's metadata (versions, categories, scores, decisions). */
  data: Record<string, unknown> | null;
}

/** `GET /api/admin/users/:userId/events`. */
export interface AdminUserEventsResponse {
  events: AdminAuditEvent[];
  /** Pass as `cursor` for the next page; null when there are no more events. */
  nextCursor: string | null;
}
