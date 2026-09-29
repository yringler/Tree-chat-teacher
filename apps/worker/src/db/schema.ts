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
 * Owner of trees and shares. Single-user today: every row belongs to the
 * seeded `default` account (see migration 0001). Multi-user later means
 * mapping verified identities to accounts; the data is already partitioned.
 */
export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
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
