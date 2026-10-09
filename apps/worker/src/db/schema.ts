import type { NodeErrorKind, SubscriptionStatus } from '@tangent/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * D1 schema. Source of truth for migrations (`pnpm db:generate` runs
 * drizzle-kit, output applied with `wrangler d1 migrations apply`); `pnpm lint`
 * fails while a change here has no migration (scripts/check-migrations.mjs).
 *
 * Ancestor lookups use a recursive CTE over nodes.parent_id (PK lookups per
 * level, O(depth)), so nothing has to be kept in step at write time.
 */

/**
 * Per-account settings, one row per account, written on the first save
 * (`PATCH /api/settings`); no row = the defaults. An account is an id, not a
 * row: every user has one account `u_<userId>` in every app
 * (auth/account.ts), and the dev bypass uses `default_simple`. No FK, like
 * the other `account_id` columns.
 */
export const accountSettings = sqliteTable('account_settings', {
  accountId: text('account_id').primaryKey(),
  /** System prompt of new trees; null = the built-in default. */
  systemPrompt: text('system_prompt'),
  updatedAt: text('updated_at').notNull(),
});

export const trees = sqliteTable(
  'trees',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    systemPrompt: text('system_prompt'),
    // No FK: trees and trunk branches reference each other; inserted in one batch.
    trunkBranchId: text('trunk_branch_id').notNull(),
    // No FK: SQLite cannot ALTER TABLE ADD COLUMN with REFERENCES and a non-null default.
    accountId: text('account_id').notNull().default('default'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('trees_account_idx').on(t.accountId, t.updatedAt)],
);

export const branches = sqliteTable(
  'branches',
  {
    id: text('id').primaryKey(),
    treeId: text('tree_id')
      .notNull()
      .references(() => trees.id, { onDelete: 'cascade' }),
    parentBranchId: text('parent_branch_id'),
    branchPointNodeId: text('branch_point_node_id'),
    contextMode: text('context_mode', {
      enum: ['path', 'summary', 'message', 'independent'],
    }).notNull(),
    anchorQuote: text('anchor_quote'),
    title: text('title').notNull(),
    titleSource: text('title_source', { enum: ['default', 'auto', 'user'] }).notNull(),
    isPrivate: integer('is_private', { mode: 'boolean' }).notNull().default(false),
    /** The endpoint (`openrouter`, `anthropic`, …); the same in both modes. */
    providerId: text('provider_id').notNull(),
    model: text('model').notNull(),
    /**
     * Who pays for the branch's calls in power mode: `own-key` or `credit`
     * (Tangent credit). Learn pays per request and writes `own-key`.
     */
    funding: text('funding', { enum: ['own-key', 'credit'] })
      .notNull()
      .default('own-key'),
    grounding: text('grounding', { enum: ['off', 'auto', 'always'] })
      .notNull()
      .default('auto'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('branches_tree_idx').on(t.treeId),
    index('branches_parent_idx').on(t.parentBranchId),
    index('branches_point_idx').on(t.branchPointNodeId),
  ],
);

/** `NodeErrorKind`, spelled out: drizzle-kit loads this file without the workspace packages. */
const ERROR_KINDS = [
  'cut_off',
  'thinking_only',
  'empty',
  'cancelled',
  'interrupted',
  'provider',
  'failed',
] as const satisfies readonly NodeErrorKind[];

export const nodes = sqliteTable(
  'nodes',
  {
    id: text('id').primaryKey(),
    treeId: text('tree_id')
      .notNull()
      .references(() => trees.id, { onDelete: 'cascade' }),
    branchId: text('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    parentId: text('parent_id'),
    seq: integer('seq').notNull(),
    role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
    content: text('content').notNull(),
    status: text('status', { enum: ['streaming', 'complete', 'error'] }).notNull(),
    error: text('error'),
    /** Why the node is `error` (NodeErrorKind); null otherwise. */
    errorKind: text('error_kind', { enum: ERROR_KINDS }),
    providerId: text('provider_id'),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /** JSON Citation[] of a grounded reply; null when it didn't search. */
    sources: text('sources'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('nodes_branch_seq_uq').on(t.branchId, t.seq),
    index('nodes_tree_idx').on(t.treeId),
    index('nodes_parent_idx').on(t.parentId),
    index('nodes_streaming_idx')
      .on(t.treeId)
      .where(sql`status = 'streaming'`),
  ],
);

/**
 * Cross-links between two messages of one tree (NodeLink). Stored directed
 * (`source` is where the link was made from), shown on both ends. `pair_key`
 * is the unordered pair (`min|max` of the node ids, written by the
 * repository), so a pair is linked at most once whichever way round. Both node
 * FKs cascade, so a link goes with either of its messages; the indexes on them
 * keep those cascades from scanning the table.
 */
export const nodeLinks = sqliteTable(
  'node_links',
  {
    id: text('id').primaryKey(),
    treeId: text('tree_id')
      .notNull()
      .references(() => trees.id, { onDelete: 'cascade' }),
    sourceNodeId: text('source_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    targetNodeId: text('target_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    pairKey: text('pair_key').notNull(),
    note: text('note'),
    /** `ai` is reserved for suggested links; everything is `user` so far. */
    origin: text('origin', { enum: ['user', 'ai'] })
      .notNull()
      .default('user'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('node_links_pair_uq').on(t.pairKey),
    index('node_links_tree_idx').on(t.treeId),
    index('node_links_source_idx').on(t.sourceNodeId),
    index('node_links_target_idx').on(t.targetNodeId),
    check('node_links_distinct_ends', sql`source_node_id <> target_node_id`),
  ],
);

export const summaries = sqliteTable(
  'summaries',
  {
    anchorNodeId: text('anchor_node_id').notNull(),
    sourceHash: text('source_hash').notNull(),
    model: text('model').notNull(),
    providerId: text('provider_id').notNull(),
    treeId: text('tree_id')
      .notNull()
      .references(() => trees.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.anchorNodeId, t.sourceHash, t.model] }),
    index('summaries_tree_idx').on(t.treeId),
  ],
);

export const shares = sqliteTable(
  'shares',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull(),
    accountId: text('account_id').notNull().default('default'),
    treeId: text('tree_id')
      .notNull()
      .references(() => trees.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['tree', 'subtree', 'path'] }).notNull(),
    targetNodeId: text('target_node_id'),
    includeAncestors: integer('include_ancestors', { mode: 'boolean' }).notNull().default(false),
    mode: text('mode', { enum: ['snapshot', 'live'] }).notNull(),
    title: text('title'),
    expiresAt: text('expires_at'),
    revokedAt: text('revoked_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    publishedAt: text('published_at'),
    version: integer('version').notNull().default(1),
    viewCount: integer('view_count').notNull().default(0),
  },
  (t) => [
    uniqueIndex('shares_token_uq').on(t.token),
    index('shares_tree_idx').on(t.treeId),
    index('shares_account_idx').on(t.accountId),
  ],
);

/**
 * Snapshot payload JSON split into chunks (<= 256K chars each, i.e. < 1 MB
 * UTF-8) to stay under D1's 2 MB row limit. Replaced atomically via batch.
 */
export const shareSnapshots = sqliteTable(
  'share_snapshots',
  {
    shareId: text('share_id')
      .notNull()
      .references(() => shares.id, { onDelete: 'cascade' }),
    chunk: integer('chunk').notNull(),
    data: text('data').notNull(),
  },
  (t) => [primaryKey({ columns: [t.shareId, t.chunk] })],
);

// ---- Authentication (Better Auth, see src/auth/auth.ts)
//
// Better Auth's models, mapped onto `auth_*` tables so its `account` model
// (linked OAuth identities) can't be confused with our `accounts` (data
// ownership). Property names are the field names Better Auth uses; columns are
// snake_case like the rest of the schema. Better Auth generates the ids.

export const authUsers = sqliteTable(
  'auth_users',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
    image: text('image'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    /**
     * The operator waived the membership fee (by hand, or the user redeemed
     * MEMBERSHIP_WAIVER_CODE). Wins over the membership subscription; clear it to revoke.
     */
    membershipWaived: integer('membership_waived', { mode: 'boolean' }).notNull().default(false),
    /** ISO timestamp of when the waiver was first granted; null when never waived. */
    membershipWaivedAt: text('membership_waived_at'),
    /**
     * The operator lets this user publish share links while DMCA_AGENT_REGISTERED
     * is off (the admin page, `PATCH /api/admin/users/:userId`). Ignored while it
     * is on: everyone may share then. Not a Better Auth field, so no auth
     * endpoint can set it.
     */
    shareAllowed: integer('share_allowed', { mode: 'boolean' }).notNull().default(false),
    /**
     * The operator suspended this user's open pool access (the admin
     * page, `PATCH /api/admin/users/:userId`), or a lost dispute of their pool
     * purchase did. Like the next two columns, not a Better Auth field, so no
     * auth endpoint can set it.
     */
    poolSuspended: integer('pool_suspended', { mode: 'boolean' }).notNull().default(false),
    /**
     * ISO timestamp of the user's first Cloudflare Turnstile pass (a magic-link
     * sign-in, the interstitial after a first OAuth sign-in, or
     * `POST /api/pool/verify`); null = the pool asks for one first.
     */
    poolVerifiedAt: text('pool_verified_at'),
    /**
     * SHA-256 of the user's normalised email (pool/identity.ts): one pool
     * identity per mailbox, so `a.b+x@gmail.com` can't be a second free tier
     * next to `ab@gmail.com`. Claimed at verification; null until then.
     */
    poolIdentity: text('pool_identity'),
  },
  (t) => [
    uniqueIndex('auth_users_pool_identity_idx')
      .on(t.poolIdentity)
      .where(sql`${t.poolIdentity} IS NOT NULL`),
  ],
);

export const authSessions = sqliteTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('auth_sessions_user_idx').on(t.userId)],
);

/** OAuth identities (Google, GitHub) linked to a user. There are no password rows: password sign-in is off. */
export const authAccounts = sqliteTable(
  'auth_accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('auth_accounts_user_idx').on(t.userId)],
);

/** Short-lived tokens: magic links, OAuth state. */
export const authVerifications = sqliteTable(
  'auth_verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('auth_verifications_identifier_idx').on(t.identifier)],
);

export const authPasskeys = sqliteTable(
  'auth_passkeys',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    credentialID: text('credential_id').notNull(),
    counter: integer('counter').notNull(),
    deviceType: text('device_type').notNull(),
    backedUp: integer('backed_up', { mode: 'boolean' }).notNull(),
    transports: text('transports'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }),
    aaguid: text('aaguid'),
  },
  (t) => [
    index('auth_passkeys_user_idx').on(t.userId),
    index('auth_passkeys_credential_idx').on(t.credentialID),
  ],
);

/** Better Auth's rate-limit counters (per IP and path); D1 so limits hold across isolates. */
export const authRateLimits = sqliteTable('auth_rate_limits', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: integer('last_request').notNull(),
});

// ---- Billing (see src/billing/ and, for the open pool, src/pool/)
//
// Ledger in integer micro-USD. Balance = Σ credit_grants.amount_micros
// − Σ settled usage_events.charge_micros; pending usage holds `hold_micros`.
// No cached balance column: every write is one idempotent statement. Each
// user's credit is the account `u_<userId>`; the open pool is one more
// account (`POOL_ACCOUNT_ID`, default `pool`) in the same two tables.

/** Credits (purchases) and debits (refunds, manual adjustments). */
export const creditGrants = sqliteTable(
  'credit_grants',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    kind: text('kind', {
      enum: ['purchase', 'refund', 'adjustment'],
    }).notNull(),
    /** Signed: refunds are negative. For purchases, the credit net of the processing fee. */
    amountMicros: integer('amount_micros').notNull(),
    /**
     * Purchases: the pre-tax amount paid (`amount + fee` for personal credit); refunds and
     * disputes: minus the refunded pre-tax amount, unclamped. Null for adjustments and the
     * oldest refunds.
     */
    grossMicros: integer('gross_micros'),
    /** Purchases: the payment provider's actual processing fee, deducted from the credit. */
    feeMicros: integer('fee_micros').notNull().default(0),
    /** The buyer or beneficiary (Better Auth user id); null on the oldest rows and pool adjustments. */
    userId: text('user_id'),
    /**
     * Idempotency key, unique: a payment provider's namespaced object ref
     * (`<provider>:<object>:<id>`, billing/payments/refs.ts), `admin:<key>`,
     * or `dev:<key>`.
     */
    providerRef: text('provider_ref').unique(),
    /**
     * Refunds, disputes and their reinstatements (null on the oldest): the payment they
     * take back from, so together they never take back more than it granted
     * (billing/payments/apply.ts).
     */
    paymentRef: text('payment_ref'),
    note: text('note'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('credit_grants_account_idx').on(t.accountId),
    index('credit_grants_user_idx').on(t.userId, t.kind),
    index('credit_grants_account_created_idx').on(t.accountId, t.createdAt),
    index('credit_grants_payment_idx').on(t.paymentRef),
  ],
);

/**
 * Who a user is at a payment provider: written from any payment event that
 * carries both ids (billing/payments/customers.ts). It tells account deletion
 * whether the provider holds a customer, and serves admin lookups. Keyed per
 * provider, so a provider switch needs no schema change.
 */
export const billingCustomers = sqliteTable(
  'billing_customers',
  {
    /** A `ProviderId` (billing/payments/port.ts). */
    provider: text('provider').notNull(),
    userId: text('user_id').notNull(),
    /** The provider's own customer id. */
    customerRef: text('customer_ref').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.userId] }),
    index('billing_customers_ref_idx').on(t.provider, t.customerRef),
  ],
);

/**
 * Payment events decided once that move no money (billing/payments/apply.ts):
 * `<disputeRef>:ignored`, a dispute that will never be debited, and
 * `<disputeRef>:lost`, a lost dispute whose buyer's pool access was suspended.
 * Kept apart from `credit_grants`, which holds money only.
 */
export const billingMarkers = sqliteTable('billing_markers', {
  ref: text('ref').primaryKey(),
  createdAt: text('created_at').notNull(),
});

/**
 * The membership subscription, as its provider last reported it: a snapshot
 * upserted from `membership.changed` events (billing/payments/apply.ts),
 * guarded by `version` so late or duplicate deliveries never roll it back.
 */
export const billingSubscriptions = sqliteTable(
  'billing_subscriptions',
  {
    /** Namespaced provider ref, e.g. `polar:subscription:<id>`. */
    ref: text('ref').primaryKey(),
    provider: text('provider').notNull(),
    /** The Better Auth user id. */
    userId: text('user_id').notNull(),
    /** What the subscription is for; only `membership` today. */
    kind: text('kind').notNull(),
    /** Normalised `SubscriptionStatus` (@tangent/shared). */
    status: text('status').$type<SubscriptionStatus>().notNull(),
    /** The provider's own status, for support; never sent to the apps. */
    providerStatus: text('provider_status').notNull(),
    /** ISO timestamp of the current period's end. */
    currentPeriodEnd: text('current_period_end'),
    cancelAtPeriodEnd: integer('cancel_at_period_end', { mode: 'boolean' })
      .notNull()
      .default(false),
    endedAt: text('ended_at'),
    /** Monotonic per subscription (an ISO timestamp from the provider); older snapshots are dropped. */
    version: text('version').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('billing_subscriptions_user_idx').on(t.userId, t.kind)],
);

/**
 * One metered provider call. No FK to trees: billing history outlives deleted
 * trees. A row never changes once it leaves `pending`; for the pool, inserting
 * the pending row is the reservation and settling it is the settlement (or,
 * with `settle_reason = 'released'`, the refund of the reservation).
 */
export const usageEvents = sqliteTable(
  'usage_events',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    treeId: text('tree_id'),
    nodeId: text('node_id'),
    /** The branch the call served; null on the oldest rows. */
    branchId: text('branch_id'),
    /** Who made the call; null on the oldest rows. */
    userId: text('user_id'),
    /**
     * `personal` (the user's credit: the payer `credit`, mapped in usage-store.ts) or
     * `pool` (the open pool, `account_id` = the pool).
     */
    funding: text('funding', { enum: ['personal', 'pool'] })
      .notNull()
      .default('personal'),
    /** Pool rows: a daily-rotating keyed hash of the caller's network (pool/ids.ts `ipKey`). */
    ipKey: text('ip_key'),
    purpose: text('purpose', {
      enum: ['reply', 'summary', 'title', 'review', 'other'],
    }).notNull(),
    providerId: text('provider_id').notNull(),
    model: text('model').notNull(),
    /** Upstream (OpenRouter) generation id, once known. */
    generationId: text('generation_id').unique(),
    status: text('status', { enum: ['pending', 'settled', 'unresolved'] }).notNull(),
    holdMicros: integer('hold_micros').notNull(),
    markupBps: integer('markup_bps').notNull(),
    /** OpenRouter's credit-purchase fee in force at the call (0 on the oldest rows). */
    feeBps: integer('fee_bps').notNull().default(0),
    costNanos: integer('cost_nanos'),
    /** Pool rows: never more than `hold_micros` (the excess is `overage_micros`). */
    chargeMicros: integer('charge_micros'),
    /** Pool rows: what the call cost beyond its hold, absorbed by the operator (feeds the breaker). */
    overageMicros: integer('overage_micros').notNull().default(0),
    /** How the row settled: `cost|generation|tokens|hold|released|unresolved`; null on the oldest rows. */
    settleReason: text('settle_reason', {
      enum: ['cost', 'generation', 'tokens', 'hold', 'released', 'unresolved'],
    }),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /** Web searches the call ran (grounding); their cost is inside cost_nanos. */
    webSearches: integer('web_searches').notNull().default(0),
    createdAt: text('created_at').notNull(),
    /** Pool rows: when the request was handed to the provider (null = never sent: released at 0). */
    dispatchedAt: text('dispatched_at'),
    settledAt: text('settled_at'),
  },
  (t) => [
    index('usage_events_account_idx').on(t.accountId, t.createdAt),
    index('usage_events_pending_idx')
      .on(t.createdAt)
      .where(sql`status = 'pending'`),
    index('usage_events_account_status_idx').on(t.accountId, t.status, t.createdAt),
    index('usage_events_pool_user_idx').on(t.accountId, t.userId, t.createdAt),
    index('usage_events_pool_ip_idx').on(t.accountId, t.ipKey, t.createdAt),
  ],
);

// ---- Open pool identities (src/pool/identity.ts)
//
// A mailbox's pool identity (`auth_users.pool_identity`, a SHA-256 of the
// normalised email) outlives the account that claimed it by
// `POOL_IDENTITY_RETENTION_DAYS`: deleting the account and signing up again
// with the same mailbox must not lift a suspension or reset the day's caps.
// Account deletion takes the user id off everything else the pool keeps.

/**
 * Per mailbox: an operator suspension, and what a deleted account that held
 * the identity leaves to the next one. The daily cron deletes the row
 * `POOL_IDENTITY_RETENTION_DAYS` after `deleted_at`, unless an account holds
 * the identity again.
 */
export const poolIdentities = sqliteTable('pool_identities', {
  identity: text('identity').primaryKey(),
  /** Set with the holder's `pool_suspended` (admin PATCH, account deletion); cleared by an admin unsuspend. */
  suspended: integer('suspended', { mode: 'boolean' }).notNull().default(false),
  /** ISO time the last account that held the identity was deleted; null while none was. */
  deletedAt: text('deleted_at'),
  /** That account's pool replies on `deleted_at`'s UTC day, counted toward the next holder's caps that day. */
  deletedDayRequests: integer('deleted_day_requests').notNull().default(0),
  /** Its pool spend that day (micro-USD), likewise. */
  deletedDaySpendMicros: integer('deleted_day_spend_micros').notNull().default(0),
});

/**
 * Unread: account deletion removes the user's row, and nothing writes one.
 * Kept until a migration can drop it without breaking a Worker that still
 * runs code writing it.
 */
export const poolIdentityHolders = sqliteTable(
  'pool_identity_holders',
  {
    userId: text('user_id').primaryKey(),
    identity: text('identity').notNull(),
    claimedAt: text('claimed_at').notNull(),
  },
  (t) => [index('pool_identity_holders_identity_idx').on(t.identity)],
);

/**
 * OpenRouter list prices of the priced models, refreshed daily by the price
 * sync (pool/price-sync.ts). They replace the built-in placeholder prices of
 * `DEFAULT_MODEL_PRICES`; an explicit `MODEL_PRICES` entry still wins.
 */
export const modelPrices = sqliteTable('model_prices', {
  model: text('model').primaryKey(),
  inMicrosPerMTok: integer('in_micros_per_mtok').notNull(),
  outMicrosPerMTok: integer('out_micros_per_mtok').notNull(),
  /** OpenRouter's `context_length`; null when not reported. */
  contextTokens: integer('context_tokens'),
  /** OpenRouter's `input_cache_read` price; null when not listed. */
  cacheReadMicrosPerMTok: integer('cache_read_micros_per_mtok'),
  /** OpenRouter's `input_cache_write` price; null when not listed. */
  cacheWriteMicrosPerMTok: integer('cache_write_micros_per_mtok'),
  /** When a sync last confirmed the price (ISO). */
  fetchedAt: text('fetched_at').notNull(),
});

/**
 * Every model in OpenRouter's catalog with its real limits, refreshed daily
 * with the prices (model-windows.ts): what ChatService budgets an OpenRouter
 * model with when its provider config names no window (instead of the kind's
 * 128,000 default), and below a configured one. Any listed model, priced or
 * not; a model that leaves the catalog keeps its last row.
 */
export const modelWindows = sqliteTable('model_windows', {
  model: text('model').primaryKey(),
  /** OpenRouter's `context_length`: input plus output. */
  contextTokens: integer('context_tokens').notNull(),
  /** OpenRouter's `top_provider.max_completion_tokens`; null when not reported. */
  maxOutputTokens: integer('max_output_tokens'),
  /** When the row last changed (ISO). */
  updatedAt: text('updated_at').notNull(),
});
