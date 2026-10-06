import type {
  Branch,
  ChatNode,
  NodeLink,
  Share,
  SummaryRecord,
  Tree,
  TreeSummary,
} from '@tangent/shared';
import { ConflictError, NotFoundError } from '../errors.js';
import { pairKey } from '../links.js';
import type { AccountSettings, Repositories, ShareWithTree } from '../repository.js';

/**
 * In-memory implementation of the repository ports. Used by service tests and
 * as a reference implementation for new storage adapters (a Node port can
 * start from it). Not optimized; everything is copied to avoid aliasing.
 */
export function createMemoryRepositories(): Repositories & { dump(): MemoryState } {
  const state: MemoryState = {
    trees: new Map(),
    branches: new Map(),
    nodes: new Map(),
    links: new Map(),
    summaries: new Map(),
    shares: new Map(),
    snapshots: new Map(),
    settings: new Map(),
  };
  const clone = <T>(v: T): T => structuredClone(v);
  const withTree = (s: Share): ShareWithTree => ({
    ...clone(s),
    treeTitle: state.trees.get(s.treeId)?.title ?? '',
  });
  /** What the D1 adapter's FK cascades do: links go with either of their nodes. */
  const dropLinksOf = (nodeIds: ReadonlySet<string>): void => {
    for (const [id, l] of state.links) {
      if (nodeIds.has(l.sourceNodeId) || nodeIds.has(l.targetNodeId)) state.links.delete(id);
    }
  };

  return {
    dump: () => state,
    trees: {
      async listTrees(accountId): Promise<TreeSummary[]> {
        return [...state.trees.values()]
          .filter((t) => t.accountId === accountId)
          .map((t) => ({
            id: t.id,
            title: t.title,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
            branchCount: [...state.branches.values()].filter((b) => b.treeId === t.id).length,
            messageCount: [...state.nodes.values()].filter((n) => n.treeId === t.id).length,
          }))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      },
      async getTree(treeId) {
        const t = state.trees.get(treeId);
        return t ? clone(t) : null;
      },
      async createTree(tree, trunk) {
        state.trees.set(tree.id, clone(tree));
        state.branches.set(trunk.id, clone(trunk));
      },
      async updateTree(treeId, patch) {
        const t = state.trees.get(treeId);
        if (!t) return null;
        Object.assign(t, patch);
        return clone(t);
      },
      async deleteTree(treeId) {
        if (!state.trees.delete(treeId)) return false;
        for (const [id, b] of state.branches) if (b.treeId === treeId) state.branches.delete(id);
        for (const [id, n] of state.nodes) if (n.treeId === treeId) state.nodes.delete(id);
        for (const [id, l] of state.links) if (l.treeId === treeId) state.links.delete(id);
        for (const [id, s] of state.summaries) if (s.treeId === treeId) state.summaries.delete(id);
        for (const [id, s] of state.shares) {
          if (s.treeId === treeId) {
            state.shares.delete(id);
            state.snapshots.delete(id);
          }
        }
        return true;
      },
      async getBranch(branchId) {
        const b = state.branches.get(branchId);
        return b ? clone(b) : null;
      },
      async listBranches(treeId) {
        return [...state.branches.values()].filter((b) => b.treeId === treeId).map(clone);
      },
      async getBranchChain(branchId) {
        const chain: Branch[] = [];
        let cur = state.branches.get(branchId);
        while (cur) {
          chain.unshift(clone(cur));
          cur = cur.parentBranchId ? state.branches.get(cur.parentBranchId) : undefined;
        }
        return chain;
      },
      async createBranch(branch) {
        state.branches.set(branch.id, clone(branch));
      },
      async updateBranch(branchId, patch) {
        const b = state.branches.get(branchId);
        if (!b) return null;
        Object.assign(b, patch);
        return clone(b);
      },
      async deleteBranches(treeId, branchIds, treeUpdatedAt) {
        const ids = new Set(branchIds);
        const nodeIds = new Set<string>();
        for (const [id, b] of state.branches) {
          if (b.treeId === treeId && ids.has(id)) state.branches.delete(id);
        }
        for (const [id, n] of state.nodes) {
          if (n.treeId === treeId && ids.has(n.branchId)) {
            nodeIds.add(id);
            state.nodes.delete(id);
          }
        }
        dropLinksOf(nodeIds);
        for (const [key, s] of state.summaries) {
          if (nodeIds.has(s.anchorNodeId)) state.summaries.delete(key);
        }
        for (const [id, s] of state.shares) {
          if (s.targetNodeId !== null && nodeIds.has(s.targetNodeId)) {
            state.shares.delete(id);
            state.snapshots.delete(id);
          }
        }
        const t = state.trees.get(treeId);
        if (t) t.updatedAt = treeUpdatedAt;
      },
      async getNode(nodeId) {
        const n = state.nodes.get(nodeId);
        return n ? clone(n) : null;
      },
      async listNodes(treeId) {
        return [...state.nodes.values()].filter((n) => n.treeId === treeId).map(clone);
      },
      async listBranchNodes(branchId) {
        return [...state.nodes.values()]
          .filter((n) => n.branchId === branchId)
          .sort((a, b) => a.seq - b.seq)
          .map(clone);
      },
      async getAncestorPath(nodeId) {
        const path: ChatNode[] = [];
        let cur = state.nodes.get(nodeId);
        while (cur) {
          path.unshift(clone(cur));
          cur = cur.parentId ? state.nodes.get(cur.parentId) : undefined;
        }
        return path;
      },
      async appendNodes(nodes, treeUpdatedAt) {
        const taken = new Set([...state.nodes.values()].map((n) => `${n.branchId}:${n.seq}`));
        for (const n of nodes) {
          const k = `${n.branchId}:${n.seq}`;
          if (taken.has(k)) throw new ConflictError('Branch was modified concurrently');
          taken.add(k);
        }
        for (const n of nodes) state.nodes.set(n.id, clone(n));
        const treeId = nodes[0]?.treeId;
        const t = treeId ? state.trees.get(treeId) : undefined;
        if (t) t.updatedAt = treeUpdatedAt;
      },
      async updateNode(nodeId, patch) {
        const n = state.nodes.get(nodeId);
        if (n) Object.assign(n, clone(patch));
      },
      async listStreamingNodes(treeId) {
        return [...state.nodes.values()]
          .filter((n) => n.treeId === treeId && n.status === 'streaming')
          .map(clone);
      },
      async listLinks(treeId) {
        return [...state.links.values()]
          .filter((l) => l.treeId === treeId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
          .map(clone);
      },
      async getLink(linkId) {
        const l = state.links.get(linkId);
        return l ? clone(l) : null;
      },
      async createLink(link, treeUpdatedAt) {
        const key = pairKey(link.sourceNodeId, link.targetNodeId);
        const existing = [...state.links.values()].find(
          (l) => pairKey(l.sourceNodeId, l.targetNodeId) === key,
        );
        if (existing) return { link: clone(existing), created: false };
        if (!state.nodes.has(link.sourceNodeId) || !state.nodes.has(link.targetNodeId)) {
          throw new NotFoundError('Node');
        }
        state.links.set(link.id, clone(link));
        const t = state.trees.get(link.treeId);
        if (t) t.updatedAt = treeUpdatedAt;
        return { link: clone(link), created: true };
      },
      async updateLink(linkId, patch) {
        const l = state.links.get(linkId);
        if (!l) return null;
        Object.assign(l, clone(patch));
        return clone(l);
      },
      async deleteLink(linkId) {
        return state.links.delete(linkId);
      },
      async importTree(tree, branches, nodes, links = []) {
        state.trees.set(tree.id, clone(tree));
        for (const b of branches) state.branches.set(b.id, clone(b));
        for (const n of nodes) state.nodes.set(n.id, clone(n));
        for (const l of links) state.links.set(l.id, clone(l));
      },
    },
    summaries: {
      async getSummary(anchorNodeId, sourceHash, model) {
        const s = state.summaries.get(`${anchorNodeId}|${sourceHash}|${model}`);
        return s ? clone(s) : null;
      },
      async putSummary(record) {
        state.summaries.set(
          `${record.anchorNodeId}|${record.sourceHash}|${record.model}`,
          clone(record),
        );
      },
    },
    shares: {
      async listShares(accountId) {
        return [...state.shares.values()]
          .filter((s) => s.accountId === accountId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(withTree);
      },
      async getShare(shareId) {
        const s = state.shares.get(shareId);
        return s ? withTree(s) : null;
      },
      async getShareByToken(token) {
        const s = [...state.shares.values()].find((x) => x.token === token);
        return s ? withTree(s) : null;
      },
      async createShare(share, snapshotJson) {
        state.shares.set(share.id, clone(share));
        if (snapshotJson !== null) state.snapshots.set(share.id, snapshotJson);
      },
      async updateShare(shareId, patch, snapshotJson) {
        const s = state.shares.get(shareId);
        if (!s) return null;
        Object.assign(s, patch);
        if (snapshotJson === null) state.snapshots.delete(shareId);
        else if (snapshotJson !== undefined) state.snapshots.set(shareId, snapshotJson);
        return withTree(s);
      },
      async getSnapshot(shareId) {
        return state.snapshots.get(shareId) ?? null;
      },
      async incrementViewCount(shareId) {
        const s = state.shares.get(shareId);
        if (s) s.viewCount += 1;
      },
    },
    settings: {
      async getSettings(accountId) {
        const s = state.settings.get(accountId);
        return s ? clone(s) : null;
      },
      async putSettings(accountId, settings) {
        state.settings.set(accountId, clone(settings));
      },
    },
  };
}

export interface MemoryState {
  trees: Map<string, Tree>;
  branches: Map<string, Branch>;
  nodes: Map<string, ChatNode>;
  links: Map<string, NodeLink>;
  summaries: Map<string, SummaryRecord>;
  shares: Map<string, Share>;
  snapshots: Map<string, string>;
  /** Keyed by account id. */
  settings: Map<string, AccountSettings>;
}
