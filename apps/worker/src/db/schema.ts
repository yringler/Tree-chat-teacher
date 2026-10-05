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
    /** Stripe customer (Better Auth Stripe plugin field); set lazily on the first checkout. */
    stripeCustomerId: text('stripe_customer_id'),
    /**
     * The operator waived the membership fee (by hand, or the user redeemed
     * MEMBERSHIP_WAIVER_CODE). Wins over the Stripe subscription; clear it to revoke.
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
  },
  (t) => [index('auth_users_stripe_customer_idx').on(t.stripeCustomerId)],
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

/**
 * Better Auth Stripe plugin `subscription` model: the membership (plan `membership`).
 * `referenceId` is the Better Auth user id. Mapped as `subscription` in the
 * drizzleAdapter schema (src/auth/auth.ts).
 */
export const authSubscriptions = sqliteTable(
  'auth_subscriptions',
  {
    id: text('id').primaryKey(),
    plan: text('plan').notNull(),
    referenceId: text('reference_id').notNull(),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    status: text('status').notNull().default('incomplete'),
    periodStart: integer('period_start', { mode: 'timestamp_ms' }),
    periodEnd: integer('period_end', { mode: 'timestamp_ms' }),
    trialStart: integer('trial_start', { mode: 'timestamp_ms' }),
    trialEnd: integer('trial_end', { mode: 'timestamp_ms' }),
    cancelAtPeriodEnd: integer('cancel_at_period_end', { mode: 'boolean' })
      .notNull()
      .default(false),
    cancelAt: integer('cancel_at', { mode: 'timestamp_ms' }),
    canceledAt: integer('canceled_at', { mode: 'timestamp_ms' }),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
    seats: integer('seats'),
    billingInterval: text('billing_interval'),
    stripeScheduleId: text('stripe_schedule_id'),
  },
  (t) => [
    index('auth_subscriptions_reference_idx').on(t.referenceId),
    index('auth_subscriptions_stripe_sub_idx').on(t.stripeSubscriptionId),
  ],
);

// ---- Billing (simple accounts; see src/billing/)
//
// Ledger in integer micro-USD. Balance = Σ credit_grants.amount_micros
// − Σ settled usage_events.charge_micros; pending usage holds `hold_micros`.
// No cached balance column: every write is one idempotent statement.

/** Credits (purchases, subscription invoices) and debits (refunds, manual adjustments). */
export const creditGrants = sqliteTable(
  'credit_grants',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    kind: text('kind', { enum: ['purchase', 'subscription', 'refund', 'adjustment'] }).notNull(),
    /** Signed: refunds are negative. For purchases, the credit net of Stripe's fee. */
    amountMicros: integer('amount_micros').notNull(),
    /** Purchases: the pre-tax amount paid (`amount + fee`); null for refunds and adjustments. */
    grossMicros: integer('gross_micros'),
    /** Purchases: Stripe's actual processing fee, deducted from the credit. */
    feeMicros: integer('fee_micros').notNull().default(0),
    /** Stripe object id (checkout session, invoice, refund); unique for idempotency. */
    stripeRef: text('stripe_ref').unique(),
    note: text('note'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('credit_grants_account_idx').on(t.accountId)],
);

/** One metered provider call. No FK to trees: billing history outlives deleted trees. */
export const usageEvents = sqliteTable(
  'usage_events',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    treeId: text('tree_id'),
    nodeId: text('node_id'),
    purpose: text('purpose', { enum: ['reply', 'summary', 'title', 'review', 'other'] }).notNull(),
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
    chargeMicros: integer('charge_micros'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    createdAt: text('created_at').notNull(),
    settledAt: text('settled_at'),
  },
  (t) => [
    index('usage_events_account_idx').on(t.accountId, t.createdAt),
    index('usage_events_pending_idx')
      .on(t.createdAt)
      .where(sql`status = 'pending'`),
  ],
);
