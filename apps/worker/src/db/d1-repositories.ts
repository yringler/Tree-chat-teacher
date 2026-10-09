import { ConflictError, NotFoundError, pairKey } from '@tangent/core';
import type {
  Repositories,
  SettingsRepository,
  ShareRepository,
  ShareWithTree,
  SummaryRepository,
  TreeRepository,
} from '@tangent/core';
import {
  DEFAULT_GROUNDING_MODE,
  type Branch,
  type ChatNode,
  type Citation,
  type NodeLink,
  type Share,
  type SummaryRecord,
  type TokenUsage,
  type Tree,
  type TreeSummary,
} from '@tangent/shared';
import { and, asc, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { fromSqlRow, type SqlRow } from './rows.js';
import * as schema from './schema.js';
import {
  accountSettings,
  branches,
  nodeLinks,
  nodes,
  shareSnapshots,
  shares,
  summaries,
  trees,
} from './schema.js';

/** Snapshot JSON is stored in chunks of this many UTF-16 code units. */
export const SNAPSHOT_CHUNK_CHARS = 256_000;

/** D1 rejects statements with more than 100 bound parameters. */
const MAX_BOUND_PARAMS = 100;
/**
 * Rows per multi-row insert: each row binds one parameter per column of its
 * table, since its insert sets every column (`Required<…Insert>` below).
 */
function rowsPerInsert(table: typeof nodes | typeof branches | typeof nodeLinks): number {
  return Math.floor(MAX_BOUND_PARAMS / Object.keys(getTableColumns(table)).length);
}
const NODE_ROWS_PER_INSERT = rowsPerInsert(nodes);
const BRANCH_ROWS_PER_INSERT = rowsPerInsert(branches);
const LINK_ROWS_PER_INSERT = rowsPerInsert(nodeLinks);

/** Guards the recursive CTEs against a corrupted (cyclic) parent chain. */
const MAX_CTE_DEPTH = 100_000;

type Db = DrizzleD1Database<typeof schema>;
type Batch = BatchItem<'sqlite'>[];

type TreeRow = typeof trees.$inferSelect;
type BranchRow = typeof branches.$inferSelect;
type NodeRow = typeof nodes.$inferSelect;
type NodeInsert = typeof nodes.$inferInsert;
type BranchInsert = typeof branches.$inferInsert;
type LinkRow = typeof nodeLinks.$inferSelect;
type LinkInsert = typeof nodeLinks.$inferInsert;
type ShareRow = typeof shares.$inferSelect;
type SummaryRow = typeof summaries.$inferSelect;

// ---------------------------------------------------------------------------
// Row <-> domain mapping
// ---------------------------------------------------------------------------

function toTree(r: TreeRow): Tree {
  return {
    id: r.id,
    accountId: r.accountId,
    title: r.title,
    systemPrompt: r.systemPrompt,
    trunkBranchId: r.trunkBranchId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toBranch(r: BranchRow): Branch {
  return {
    id: r.id,
    treeId: r.treeId,
    parentBranchId: r.parentBranchId,
    branchPointNodeId: r.branchPointNodeId,
    contextMode: r.contextMode,
    anchorQuote: r.anchorQuote,
    title: r.title,
    titleSource: r.titleSource,
    isPrivate: r.isPrivate,
    providerId: r.providerId,
    model: r.model,
    funding: r.funding,
    grounding: r.grounding,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toUsage(input: number | null, output: number | null): TokenUsage | null {
  if (input === null && output === null) return null;
  return { inputTokens: input ?? 0, outputTokens: output ?? 0 };
}

/** Stored JSON Citation[]; malformed or absent reads as null (no sources). */
function parseSources(raw: string | null): Citation[] | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    const out: Citation[] = [];
    for (const c of value) {
      if (typeof c !== 'object' || c === null) continue;
      const rec = c as Record<string, unknown>;
      if (typeof rec['url'] !== 'string') continue;
      out.push({
        url: rec['url'],
        title: typeof rec['title'] === 'string' ? rec['title'] : null,
        excerpt: typeof rec['excerpt'] === 'string' ? rec['excerpt'] : null,
      });
    }
    return out;
  } catch {
    return null;
  }
}

function serializeSources(sources: Citation[] | null | undefined): string | null {
  return sources ? JSON.stringify(sources) : null;
}

function toNode(r: NodeRow): ChatNode {
  return {
    id: r.id,
    treeId: r.treeId,
    branchId: r.branchId,
    parentId: r.parentId,
    seq: r.seq,
    role: r.role,
    content: r.content,
    status: r.status,
    error: r.error,
    errorKind: r.errorKind,
    providerId: r.providerId,
    model: r.model,
    usage: toUsage(r.inputTokens, r.outputTokens),
    sources: parseSources(r.sources),
    createdAt: r.createdAt,
  };
}

function toLink(r: LinkRow): NodeLink {
  return {
    id: r.id,
    treeId: r.treeId,
    sourceNodeId: r.sourceNodeId,
    targetNodeId: r.targetNodeId,
    note: r.note,
    origin: r.origin,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function linkInsert(l: NodeLink): Required<LinkInsert> {
  return {
    id: l.id,
    treeId: l.treeId,
    sourceNodeId: l.sourceNodeId,
    targetNodeId: l.targetNodeId,
    pairKey: pairKey(l.sourceNodeId, l.targetNodeId),
    note: l.note,
    origin: l.origin,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

function toShare(r: ShareRow): Share {
  return {
    id: r.id,
    token: r.token,
    accountId: r.accountId,
    treeId: r.treeId,
    scope: r.scope,
    targetNodeId: r.targetNodeId,
    includeAncestors: r.includeAncestors,
    mode: r.mode,
    title: r.title,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    publishedAt: r.publishedAt,
    version: r.version,
    viewCount: r.viewCount,
  };
}

function toShareWithTree(r: { share: ShareRow; treeTitle: string }): ShareWithTree {
  return { ...toShare(r.share), treeTitle: r.treeTitle };
}

function toSummary(r: SummaryRow): SummaryRecord {
  return {
    anchorNodeId: r.anchorNodeId,
    sourceHash: r.sourceHash,
    providerId: r.providerId,
    model: r.model,
    content: r.content,
    treeId: r.treeId,
    createdAt: r.createdAt,
  };
}

function nodeInsert(n: ChatNode): Required<NodeInsert> {
  return {
    id: n.id,
    treeId: n.treeId,
    branchId: n.branchId,
    parentId: n.parentId,
    seq: n.seq,
    role: n.role,
    content: n.content,
    status: n.status,
    error: n.error,
    errorKind: n.errorKind ?? null,
    providerId: n.providerId,
    model: n.model,
    inputTokens: n.usage?.inputTokens ?? null,
    outputTokens: n.usage?.outputTokens ?? null,
    sources: serializeSources(n.sources),
    createdAt: n.createdAt,
  };
}

function branchInsert(b: Branch): Required<BranchInsert> {
  return {
    id: b.id,
    treeId: b.treeId,
    parentBranchId: b.parentBranchId,
    branchPointNodeId: b.branchPointNodeId,
    contextMode: b.contextMode,
    anchorQuote: b.anchorQuote,
    title: b.title,
    titleSource: b.titleSource,
    isPrivate: b.isPrivate,
    providerId: b.providerId,
    model: b.model,
    funding: b.funding,
    grounding: b.grounding ?? DEFAULT_GROUNDING_MODE,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Splits a snapshot into <= SNAPSHOT_CHUNK_CHARS pieces (always >= 1 chunk). */
export function splitSnapshot(json: string): string[] {
  if (json.length === 0) return [''];
  const out: string[] = [];
  for (let i = 0; i < json.length; i += SNAPSHOT_CHUNK_CHARS) {
    out.push(json.slice(i, i + SNAPSHOT_CHUNK_CHARS));
  }
  return out;
}

function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur instanceof Error; i++) {
    if (/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(cur.message)) return true;
    cur = cur.cause;
  }
  return false;
}

function isForeignKeyViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur instanceof Error; i++) {
    if (/FOREIGN KEY constraint failed|SQLITE_CONSTRAINT_FOREIGNKEY/i.test(cur.message))
      return true;
    cur = cur.cause;
  }
  return false;
}

function definedOnly<T extends object>(patch: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(patch) as [keyof T, T[keyof T]][]) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

async function runBatch(db: Db, items: Batch): Promise<void> {
  const [first, ...rest] = items;
  if (!first) return;
  await db.batch([first, ...rest]);
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export function createD1Repositories(d1: D1Database): Repositories {
  const db: Db = drizzle(d1, { schema });

  function nodeInserts(list: readonly ChatNode[]): Batch {
    return chunkArray(list, NODE_ROWS_PER_INSERT).map((chunk) =>
      db.insert(nodes).values(chunk.map(nodeInsert)),
    );
  }

  function branchInserts(list: readonly Branch[]): Batch {
    return chunkArray(list, BRANCH_ROWS_PER_INSERT).map((chunk) =>
      db.insert(branches).values(chunk.map(branchInsert)),
    );
  }

  function linkInserts(list: readonly NodeLink[]): Batch {
    return chunkArray(list, LINK_ROWS_PER_INSERT).map((chunk) =>
      db.insert(nodeLinks).values(chunk.map(linkInsert)),
    );
  }

  function snapshotInserts(shareId: string, json: string): Batch {
    // One chunk per statement: keeps each statement well below D1's size limits.
    return splitSnapshot(json).map((data, chunk) =>
      db.insert(shareSnapshots).values({ shareId, chunk, data }),
    );
  }

  const shareSelect = () =>
    db
      .select({ share: shares, treeTitle: trees.title })
      .from(shares)
      .innerJoin(trees, eq(trees.id, shares.treeId));

  const treeRepo: TreeRepository = {
    async listTrees(accountId): Promise<TreeSummary[]> {
      // Correlated subqueries reference "trees"."id" literally: drizzle renders
      // ${trees.id} unqualified in single-table selects, which would bind to
      // the subquery's own `id` column.
      const rows = await db
        .select({
          id: trees.id,
          title: trees.title,
          createdAt: trees.createdAt,
          updatedAt: trees.updatedAt,
          branchCount: sql<number>`(SELECT count(*) FROM "branches" b WHERE b.tree_id = "trees"."id")`,
          messageCount: sql<number>`(SELECT count(*) FROM "nodes" n WHERE n.tree_id = "trees"."id")`,
        })
        .from(trees)
        .where(eq(trees.accountId, accountId))
        .orderBy(desc(trees.updatedAt), asc(trees.id));
      return rows.map((r) => ({
        ...r,
        branchCount: Number(r.branchCount),
        messageCount: Number(r.messageCount),
      }));
    },

    async getTree(treeId) {
      const row = await db.select().from(trees).where(eq(trees.id, treeId)).get();
      return row ? toTree(row) : null;
    },

    async createTree(tree, trunk) {
      await runBatch(db, [
        db.insert(trees).values({
          id: tree.id,
          accountId: tree.accountId,
          title: tree.title,
          systemPrompt: tree.systemPrompt,
          trunkBranchId: tree.trunkBranchId,
          createdAt: tree.createdAt,
          updatedAt: tree.updatedAt,
        }),
        db.insert(branches).values(branchInsert(trunk)),
      ]);
    },

    async updateTree(treeId, patch) {
      const set = definedOnly({
        title: patch.title,
        systemPrompt: patch.systemPrompt,
        updatedAt: patch.updatedAt,
      });
      if (Object.keys(set).length === 0) return treeRepo.getTree(treeId);
      const row = await db.update(trees).set(set).where(eq(trees.id, treeId)).returning().get();
      return row ? toTree(row) : null;
    },

    async deleteTree(treeId) {
      // Branches, nodes, links, summaries, shares (and their snapshots) go via FK cascades.
      const rows = await db.delete(trees).where(eq(trees.id, treeId)).returning({ id: trees.id });
      return rows.length > 0;
    },

    async getBranch(branchId) {
      const row = await db.select().from(branches).where(eq(branches.id, branchId)).get();
      return row ? toBranch(row) : null;
    },

    async listBranches(treeId) {
      const rows = await db
        .select()
        .from(branches)
        .where(eq(branches.treeId, treeId))
        .orderBy(asc(branches.createdAt), asc(branches.id));
      return rows.map(toBranch);
    },

    async getBranchChain(branchId) {
      const { results } = await d1
        .prepare(
          `WITH RECURSIVE chain(id, parent_branch_id, depth) AS (
             SELECT id, parent_branch_id, 0 FROM branches WHERE id = ?1
             UNION ALL
             SELECT b.id, b.parent_branch_id, chain.depth + 1
               FROM branches b JOIN chain ON b.id = chain.parent_branch_id
              WHERE chain.depth < ?2
           )
           SELECT branches.* FROM branches JOIN chain ON branches.id = chain.id
           ORDER BY chain.depth DESC`,
        )
        .bind(branchId, MAX_CTE_DEPTH)
        .all<SqlRow<typeof branches>>();
      return results.map((r) => toBranch(fromSqlRow(branches, r)));
    },

    async createBranch(branch) {
      await db.insert(branches).values(branchInsert(branch));
    },

    async updateBranch(branchId, patch) {
      const set = definedOnly({
        title: patch.title,
        titleSource: patch.titleSource,
        contextMode: patch.contextMode,
        anchorQuote: patch.anchorQuote,
        isPrivate: patch.isPrivate,
        providerId: patch.providerId,
        model: patch.model,
        funding: patch.funding,
        grounding: patch.grounding,
        updatedAt: patch.updatedAt,
      });
      if (Object.keys(set).length === 0) return treeRepo.getBranch(branchId);
      const row = await db
        .update(branches)
        .set(set)
        .where(eq(branches.id, branchId))
        .returning()
        .get();
      return row ? toBranch(row) : null;
    },

    async deleteBranches(treeId, branchIds, treeUpdatedAt) {
      // One batch (= one transaction). Node ids are selected in subqueries so
      // only branch ids are bound, chunked under D1's parameter limit.
      const items: Batch = [];
      for (const chunk of chunkArray(branchIds, MAX_BOUND_PARAMS - 1)) {
        const doomedNodes = db
          .select({ id: nodes.id })
          .from(nodes)
          .where(and(eq(nodes.treeId, treeId), inArray(nodes.branchId, chunk)));
        items.push(
          // The node FKs would cascade too; this keeps it explicit. One statement
          // per end, so each binds the chunk once.
          db.delete(nodeLinks).where(inArray(nodeLinks.sourceNodeId, doomedNodes)),
          db.delete(nodeLinks).where(inArray(nodeLinks.targetNodeId, doomedNodes)),
          db.delete(summaries).where(inArray(summaries.anchorNodeId, doomedNodes)),
          // Snapshots go via FK cascade.
          db.delete(shares).where(inArray(shares.targetNodeId, doomedNodes)),
          db.delete(nodes).where(and(eq(nodes.treeId, treeId), inArray(nodes.branchId, chunk))),
          db.delete(branches).where(and(eq(branches.treeId, treeId), inArray(branches.id, chunk))),
        );
      }
      items.push(db.update(trees).set({ updatedAt: treeUpdatedAt }).where(eq(trees.id, treeId)));
      await runBatch(db, items);
    },

    async getNode(nodeId) {
      const row = await db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
      return row ? toNode(row) : null;
    },

    async listNodes(treeId) {
      const rows = await db
        .select()
        .from(nodes)
        .where(eq(nodes.treeId, treeId))
        .orderBy(asc(nodes.branchId), asc(nodes.seq));
      return rows.map(toNode);
    },

    async listBranchNodes(branchId) {
      const rows = await db
        .select()
        .from(nodes)
        .where(eq(nodes.branchId, branchId))
        .orderBy(asc(nodes.seq));
      return rows.map(toNode);
    },

    async getAncestorPath(nodeId) {
      const { results } = await d1
        .prepare(
          `WITH RECURSIVE anc(id, parent_id, depth) AS (
             SELECT id, parent_id, 0 FROM nodes WHERE id = ?1
             UNION ALL
             SELECT n.id, n.parent_id, anc.depth + 1
               FROM nodes n JOIN anc ON n.id = anc.parent_id
              WHERE anc.depth < ?2
           )
           SELECT nodes.* FROM nodes JOIN anc ON nodes.id = anc.id
           ORDER BY anc.depth DESC`,
        )
        .bind(nodeId, MAX_CTE_DEPTH)
        .all<SqlRow<typeof nodes>>();
      return results.map((r) => toNode(fromSqlRow(nodes, r)));
    },

    async appendNodes(list, treeUpdatedAt) {
      if (list.length === 0) return;
      const treeIds = [...new Set(list.map((n) => n.treeId))];
      const items: Batch = [
        ...nodeInserts(list),
        ...treeIds.map((id) =>
          db.update(trees).set({ updatedAt: treeUpdatedAt }).where(eq(trees.id, id)),
        ),
      ];
      try {
        await runBatch(db, items);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError('The branch changed concurrently; reload and try again');
        }
        throw err;
      }
    },

    async updateNode(nodeId, patch) {
      const set: Partial<NodeInsert> = definedOnly({
        content: patch.content,
        status: patch.status,
        error: patch.error,
        errorKind: patch.errorKind,
      });
      if (patch.usage !== undefined) {
        set.inputTokens = patch.usage?.inputTokens ?? null;
        set.outputTokens = patch.usage?.outputTokens ?? null;
      }
      if (patch.sources !== undefined) set.sources = serializeSources(patch.sources);
      if (Object.keys(set).length === 0) return;
      await db.update(nodes).set(set).where(eq(nodes.id, nodeId));
    },

    async listStreamingNodes(treeId) {
      const rows = await db
        .select()
        .from(nodes)
        .where(and(eq(nodes.treeId, treeId), eq(nodes.status, 'streaming')))
        .orderBy(asc(nodes.createdAt), asc(nodes.id));
      return rows.map(toNode);
    },

    async listLinks(treeId) {
      const rows = await db
        .select()
        .from(nodeLinks)
        .where(eq(nodeLinks.treeId, treeId))
        .orderBy(asc(nodeLinks.createdAt), asc(nodeLinks.id));
      return rows.map(toLink);
    },

    async getLink(linkId) {
      const row = await db.select().from(nodeLinks).where(eq(nodeLinks.id, linkId)).get();
      return row ? toLink(row) : null;
    },

    async createLink(link, treeUpdatedAt) {
      const key = pairKey(link.sourceNodeId, link.targetNodeId);
      const existing = async (): Promise<NodeLink | null> => {
        const row = await db.select().from(nodeLinks).where(eq(nodeLinks.pairKey, key)).get();
        return row ? toLink(row) : null;
      };
      const found = await existing();
      if (found) return { link: found, created: false };
      try {
        await runBatch(db, [
          db.insert(nodeLinks).values(linkInsert(link)),
          db.update(trees).set({ updatedAt: treeUpdatedAt }).where(eq(trees.id, link.treeId)),
        ]);
      } catch (err) {
        // A concurrent request linked the same pair first.
        if (isUniqueViolation(err)) {
          const raced = await existing();
          if (raced) return { link: raced, created: false };
        }
        // A message was deleted since the caller loaded it.
        if (isForeignKeyViolation(err)) throw new NotFoundError('Node');
        throw err;
      }
      return { link, created: true };
    },

    async updateLink(linkId, patch) {
      const row = await db
        .update(nodeLinks)
        .set({ note: patch.note, updatedAt: patch.updatedAt })
        .where(eq(nodeLinks.id, linkId))
        .returning()
        .get();
      return row ? toLink(row) : null;
    },

    async deleteLink(linkId) {
      const rows = await db
        .delete(nodeLinks)
        .where(eq(nodeLinks.id, linkId))
        .returning({ id: nodeLinks.id });
      return rows.length > 0;
    },

    async importTree(tree, branchList, nodeList, linkList = []) {
      await runBatch(db, [
        db.insert(trees).values({
          id: tree.id,
          accountId: tree.accountId,
          title: tree.title,
          systemPrompt: tree.systemPrompt,
          trunkBranchId: tree.trunkBranchId,
          createdAt: tree.createdAt,
          updatedAt: tree.updatedAt,
        }),
        ...branchInserts(branchList),
        ...nodeInserts(nodeList),
        ...linkInserts(linkList),
      ]);
    },
  };

  const summaryRepo: SummaryRepository = {
    async getSummary(anchorNodeId, sourceHash, model) {
      const row = await db
        .select()
        .from(summaries)
        .where(
          and(
            eq(summaries.anchorNodeId, anchorNodeId),
            eq(summaries.sourceHash, sourceHash),
            eq(summaries.model, model),
          ),
        )
        .get();
      return row ? toSummary(row) : null;
    },

    async putSummary(r) {
      await db
        .insert(summaries)
        .values({
          anchorNodeId: r.anchorNodeId,
          sourceHash: r.sourceHash,
          model: r.model,
          providerId: r.providerId,
          treeId: r.treeId,
          content: r.content,
          createdAt: r.createdAt,
        })
        .onConflictDoUpdate({
          target: [summaries.anchorNodeId, summaries.sourceHash, summaries.model],
          set: {
            providerId: r.providerId,
            treeId: r.treeId,
            content: r.content,
            createdAt: r.createdAt,
          },
        });
    },
  };

  const shareRepo: ShareRepository = {
    async listShares(accountId) {
      const rows = await shareSelect()
        .where(eq(shares.accountId, accountId))
        .orderBy(desc(shares.createdAt), asc(shares.id));
      return rows.map(toShareWithTree);
    },

    async getShare(shareId) {
      const row = await shareSelect().where(eq(shares.id, shareId)).get();
      return row ? toShareWithTree(row) : null;
    },

    async getShareByToken(token) {
      const row = await shareSelect().where(eq(shares.token, token)).get();
      return row ? toShareWithTree(row) : null;
    },

    async createShare(share, snapshotJson) {
      await runBatch(db, [
        db.insert(shares).values({
          id: share.id,
          token: share.token,
          accountId: share.accountId,
          treeId: share.treeId,
          scope: share.scope,
          targetNodeId: share.targetNodeId,
          includeAncestors: share.includeAncestors,
          mode: share.mode,
          title: share.title,
          expiresAt: share.expiresAt,
          revokedAt: share.revokedAt,
          createdAt: share.createdAt,
          updatedAt: share.updatedAt,
          publishedAt: share.publishedAt,
          version: share.version,
          viewCount: share.viewCount,
        }),
        ...(snapshotJson === null ? [] : snapshotInserts(share.id, snapshotJson)),
      ]);
    },

    async updateShare(shareId, patch, snapshotJson) {
      const set = definedOnly({
        title: patch.title,
        expiresAt: patch.expiresAt,
        revokedAt: patch.revokedAt,
        updatedAt: patch.updatedAt,
        publishedAt: patch.publishedAt,
        version: patch.version,
      });
      const items: Batch = [];
      if (Object.keys(set).length > 0) {
        items.push(db.update(shares).set(set).where(eq(shares.id, shareId)));
      }
      if (snapshotJson !== undefined) {
        // Only touch snapshots of an existing share (the FK would reject orphans anyway).
        const existing = await db
          .select({ id: shares.id })
          .from(shares)
          .where(eq(shares.id, shareId))
          .get();
        if (existing) {
          items.push(db.delete(shareSnapshots).where(eq(shareSnapshots.shareId, shareId)));
          if (snapshotJson !== null) items.push(...snapshotInserts(shareId, snapshotJson));
        }
      }
      await runBatch(db, items);
      return shareRepo.getShare(shareId);
    },

    async deleteShare(shareId) {
      // Snapshots go via FK cascade.
      const rows = await db
        .delete(shares)
        .where(eq(shares.id, shareId))
        .returning({ id: shares.id });
      return rows.length > 0;
    },

    async getSnapshot(shareId) {
      const rows = await db
        .select({ data: shareSnapshots.data })
        .from(shareSnapshots)
        .where(eq(shareSnapshots.shareId, shareId))
        .orderBy(asc(shareSnapshots.chunk));
      if (rows.length === 0) return null;
      return rows.map((r) => r.data).join('');
    },

    async incrementViewCount(shareId) {
      await db
        .update(shares)
        .set({ viewCount: sql`${shares.viewCount} + 1` })
        .where(eq(shares.id, shareId));
    },
  };

  const settingsRepo: SettingsRepository = {
    async getSettings(accountId) {
      const row = await db
        .select({ systemPrompt: accountSettings.systemPrompt })
        .from(accountSettings)
        .where(eq(accountSettings.accountId, accountId))
        .get();
      return row ? { systemPrompt: row.systemPrompt } : null;
    },

    async putSettings(accountId, settings, updatedAt) {
      await db
        .insert(accountSettings)
        .values({ accountId, systemPrompt: settings.systemPrompt, updatedAt })
        .onConflictDoUpdate({
          target: accountSettings.accountId,
          set: { systemPrompt: settings.systemPrompt, updatedAt },
        });
    },
  };

  return { trees: treeRepo, summaries: summaryRepo, shares: shareRepo, settings: settingsRepo };
}
