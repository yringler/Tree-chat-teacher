import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * D1 schema. Source of truth for migrations (`pnpm db:generate` runs
 * drizzle-kit, output applied with `wrangler d1 migrations apply`).
 *
 * Ancestor lookups use a recursive CTE over nodes.parent_id (PK lookups per
 * level, O(depth)); see docs/DECISIONS.md.
 */

/**
 * Owner of trees and shares. Every user has a `power` account `p_<userId>`
 * and a `simple` (Learn) account `u_<userId>`, created on first request
 * (migrations 0003 and 0005). The seeded `default` account (migration 0001)
 * is the dev bypass's power account.
 */
export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    createdAt: text('created_at').notNull(),
    /** Better Auth user id of the account's owner; null for the dev bypass accounts. */
    userId: text('user_id'),
    /** Each user has one account per mode: `p_<userId>` (power) and `u_<userId>` (simple). */
    mode: text('mode', { enum: ['power', 'simple'] })
      .notNull()
      .default('power'),
  },
  (t) => [uniqueIndex('accounts_user_mode_uq').on(t.userId, t.mode)],
);

/**
 * Per-account settings, one row per account, written on the first save
 * (`PATCH /api/settings`); no row = the defaults. A table of its own rather
 * than columns on `accounts`: settings are large (a system prompt can be
 * 20k chars), change rarely and are read only when needed, while `accounts`
 * stays the small row every request ensures. No FK, like the other
 * `account_id` columns.
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
    contextMode: text('context_mode', { enum: ['path', 'summary', 'independent'] }).notNull(),
    anchorQuote: text('anchor_quote'),
    title: text('title').notNull(),
    titleSource: text('title_source', { enum: ['default', 'auto', 'user'] }).notNull(),
    isPrivate: integer('is_private', { mode: 'boolean' }).notNull().default(false),
    providerId: text('provider_id').notNull(),
    model: text('model').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('branches_tree_idx').on(t.treeId),
    index('branches_parent_idx').on(t.parentBranchId),
    index('branches_point_idx').on(t.branchPointNodeId),
  ],
);

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
    providerId: text('provider_id'),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
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
     * The operator suspended this user's community pool access (the admin
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

// ---- Billing (see src/billing/ and, for the community pool, src/pool/)
//
// Ledger in integer micro-USD. Balance = Σ credit_grants.amount_micros
// − Σ settled usage_events.charge_micros; pending usage holds `hold_micros`.
// No cached balance column: every write is one idempotent statement. Each
// user's credit is the account `u_<userId>`; the community pool is one more
// account (`POOL_ACCOUNT_ID`, default `pool`) in the same two tables.

/** Credits (purchases, membership credit, pool contributions) and debits (refunds, manual adjustments). */
export const creditGrants = sqliteTable(
  'credit_grants',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    /** `contribution`: the pool's share of Tangent's revenue (pool/revenue-share.ts) or its reversal. */
    kind: text('kind', {
      enum: ['purchase', 'subscription', 'refund', 'adjustment', 'contribution'],
    }).notNull(),
    /** Signed: refunds are negative. For purchases, the credit net of the processing fee (older pool purchases: of the margin). */
    amountMicros: integer('amount_micros').notNull(),
    /**
     * Purchases: the pre-tax amount paid (`amount + fee` for personal credit); refunds and
     * disputes (since migration 0010): minus the refunded pre-tax amount, unclamped. Null for
     * adjustments and older refunds.
     */
    grossMicros: integer('gross_micros'),
    /** Purchases: the payment provider's actual processing fee (deducted from personal credit; recorded only for the pool). */
    feeMicros: integer('fee_micros').notNull().default(0),
    /** Older pool purchases: the margin taken, in bps (`amount = gross / (1 + margin)`); 0 otherwise, and since the pool moved to a per-call markup. */
    marginBps: integer('margin_bps').notNull().default(0),
    /** The buyer or beneficiary (Better Auth user id); null on rows before migration 0010 and pool adjustments. */
    userId: text('user_id'),
    /**
     * Idempotency key, unique: a payment provider's namespaced object ref
     * (`<provider>:<object>:<id>`, billing/payments/refs.ts), `admin:<key>`,
     * `dev:<key>`, or a bare object id of the previous processor on rows from before migration 0014.
     */
    providerRef: text('provider_ref').unique(),
    note: text('note'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('credit_grants_account_idx').on(t.accountId),
    index('credit_grants_user_idx').on(t.userId, t.kind),
    index('credit_grants_account_created_idx').on(t.accountId, t.createdAt),
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
    status: text('status').notNull(),
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
    /** The branch the call served (rows since migration 0010). */
    branchId: text('branch_id'),
    /** Who made the call (rows since migration 0010). */
    userId: text('user_id'),
    /** `personal` (the user's credit) or `pool` (the community pool, `account_id` = the pool). */
    funding: text('funding', { enum: ['personal', 'pool'] })
      .notNull()
      .default('personal'),
    /** Pool rows: a daily-rotating keyed hash of the caller's network (pool/ids.ts `ipKey`). */
    ipKey: text('ip_key'),
    /** Pool rows: the caller's cap tier when the call was reserved. */
    tier: text('tier', { enum: ['free', 'supporter'] }),
    purpose: text('purpose', {
      enum: ['reply', 'summary', 'title', 'review', 'tagging', 'other'],
    }).notNull(),
    providerId: text('provider_id').notNull(),
    model: text('model').notNull(),
    /** Upstream (OpenRouter) generation id, once known. */
    generationId: text('generation_id').unique(),
    status: text('status', { enum: ['pending', 'settled', 'unresolved'] }).notNull(),
    holdMicros: integer('hold_micros').notNull(),
    markupBps: integer('markup_bps').notNull(),
    /** OpenRouter's credit-purchase fee in force at the call (rows before 0004: 0). */
    feeBps: integer('fee_bps').notNull().default(0),
    costNanos: integer('cost_nanos'),
    /** Pool rows: never more than `hold_micros` (the excess is `overage_micros`). */
    chargeMicros: integer('charge_micros'),
    /** Pool rows: what the call cost beyond its hold, absorbed by the operator (feeds the breaker). */
    overageMicros: integer('overage_micros').notNull().default(0),
    /** How the row settled: `cost|generation|tokens|hold|released|unresolved` (rows since 0010). */
    settleReason: text('settle_reason', {
      enum: ['cost', 'generation', 'tokens', 'hold', 'released', 'unresolved'],
    }),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
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
    index('usage_events_pool_tier_idx').on(t.accountId, t.tier, t.createdAt),
    // The weekly impact job's tag retention: a branch's latest pool reply.
    index('usage_events_branch_idx').on(t.branchId, t.createdAt),
    // The pool's daily revenue share: personal charges settled in a UTC day (pool/revenue-share.ts).
    index('usage_events_personal_settled_idx')
      .on(t.settledAt)
      .where(sql`funding = 'personal' AND status = 'settled'`),
  ],
);

// ---- Community pool identities (src/pool/identity.ts)
//
// A mailbox's pool identity (`auth_users.pool_identity`, a SHA-256 of the
// normalised email) outlives the account that claimed it: deleting the
// account and signing up again with the same mailbox must not lift a
// suspension or reset the daily caps. These two tables hold only that hash
// and user ids, and account deletion keeps them, like the ledger.

/** Per mailbox: an operator suspension that survives the account's deletion. */
export const poolIdentities = sqliteTable('pool_identities', {
  identity: text('identity').primaryKey(),
  /** Set with the holder's `pool_suspended` (admin PATCH, account deletion); cleared by an admin unsuspend. */
  suspended: integer('suspended', { mode: 'boolean' }).notNull().default(false),
});

/** Every account that has held a pool identity, so the daily caps count the mailbox's usage. */
export const poolIdentityHolders = sqliteTable(
  'pool_identity_holders',
  {
    userId: text('user_id').primaryKey(),
    identity: text('identity').notNull(),
    claimedAt: text('claimed_at').notNull(),
  },
  (t) => [index('pool_identity_holders_identity_idx').on(t.identity)],
);

// ---- Community pool consent and topic tags (src/pool/consent.ts, src/pool/tagging.ts)

/**
 * Who acknowledged which version of the pool notice (packages/shared/src/pool.ts
 * `POOL_NOTICE_TEXT`), and when. A pool request needs a row at the current
 * version (`pool_consent_required`). Kept until the account is deleted.
 */
export const poolConsents = sqliteTable(
  'pool_consents',
  {
    userId: text('user_id').notNull(),
    noticeVersion: integer('notice_version').notNull(),
    acknowledgedAt: text('acknowledged_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.noticeVersion] })],
);

/**
 * One topic per pool-funded branch, from the classifier's reading of the pool
 * exchange that first completed there (src/pool/taxonomy.ts leaf ids, or the
 * sentinel `sensitive`). No user id, no tree id and no text: per-topic
 * learners come from `usage_events`, joined on `branch_id`. Deleted 14 days
 * after the branch's last pool use, or with the account.
 */
export const poolTopicTags = sqliteTable(
  'pool_topic_tags',
  {
    branchId: text('branch_id').primaryKey(),
    topicId: text('topic_id').notNull(),
    /** The branch's depth in its tree when tagged: 0 = the trunk. */
    branchDepth: integer('branch_depth').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('pool_topic_tags_topic_idx').on(t.topicId, t.createdAt)],
);

// ---- Community pool impact feed (src/pool/impact.ts, docs/pool/PLAN.md §S8b)

/**
 * One immutable public snapshot per ISO week (`week_start`: its Monday,
 * `YYYY-MM-DD`), written by the weekly cron. Totals cover every funded pool
 * reply of the week, sensitive and unnamed topics included.
 */
export const poolImpactSnapshots = sqliteTable('pool_impact_snapshots', {
  weekStart: text('week_start').primaryKey(),
  /** Pool replies settled above 0 in the week. */
  exchanges: integer('exchanges').notNull(),
  /** Distinct users of those replies. */
  learners: integer('learners').notNull(),
  /** Distinct topics touched (the sentinel `sensitive` counts as one). */
  topics: integer('topics').notNull(),
  /** Average branch depth of the tagged replies, × 1000. */
  avgDepthMilli: integer('avg_depth_milli').notNull(),
  maxDepth: integer('max_depth').notNull(),
  /** The published topic with the greatest average depth; null when none is published. */
  deepestTopicId: text('deepest_topic_id'),
  createdAt: text('created_at').notNull(),
});

/** The topics a snapshot names: published ones only (threshold, not sensitive or blocked, approved). */
export const poolImpactTopics = sqliteTable(
  'pool_impact_topics',
  {
    weekStart: text('week_start').notNull(),
    topicId: text('topic_id').notNull(),
    learners: integer('learners').notNull(),
    exchanges: integer('exchanges').notNull(),
    avgDepthMilli: integer('avg_depth_milli').notNull(),
  },
  (t) => [primaryKey({ columns: [t.weekStart, t.topicId] })],
);

/**
 * The admin review queue: a topic that first qualifies to be named is queued
 * `pending`; only `approved` topics are ever published, from the next week on.
 */
export const poolTopicReviews = sqliteTable('pool_topic_reviews', {
  topicId: text('topic_id').primaryKey(),
  status: text('status', { enum: ['pending', 'approved', 'rejected'] }).notNull(),
  /** The week (`YYYY-MM-DD`) it first qualified. */
  firstSeenWeek: text('first_seen_week').notNull(),
  decidedAt: text('decided_at'),
  /** The admin's user id. */
  decidedBy: text('decided_by'),
});
