import type {
  Branch,
  ChatNode,
  Citation,
  Share,
  SummaryRecord,
  TokenUsage,
  Tree,
  TreeSummary,
} from '@tangent/shared';

/**
 * Storage ports. The D1 implementation in apps/worker is the only code that
 * knows about D1; a Node port would add e.g. a better-sqlite3/Postgres one.
 *
 * All methods reject with a plain Error on storage failure. "Not found" is
 * signalled by `null` / `false`, never by throwing.
 */
export interface TreeRepository {
  /** Trees owned by `accountId`, most recently updated first. */
  listTrees(accountId: string): Promise<TreeSummary[]>;
  getTree(treeId: string): Promise<Tree | null>;
  /** Atomically inserts the tree and its trunk branch. */
  createTree(tree: Tree, trunk: Branch): Promise<void>;
  updateTree(
    treeId: string,
    patch: Partial<Pick<Tree, 'title' | 'systemPrompt' | 'updatedAt'>>,
  ): Promise<Tree | null>;
  /** Deletes the tree with all branches, nodes, summaries and shares. */
  deleteTree(treeId: string): Promise<boolean>;

  getBranch(branchId: string): Promise<Branch | null>;
  listBranches(treeId: string): Promise<Branch[]>;
  /** Trunk → branch (inclusive), following parentBranchId. Empty if not found. */
  getBranchChain(branchId: string): Promise<Branch[]>;
  createBranch(branch: Branch): Promise<void>;
  updateBranch(
    branchId: string,
    patch: Partial<
      Pick<
        Branch,
        | 'title'
        | 'titleSource'
        | 'contextMode'
        | 'anchorQuote'
        | 'isPrivate'
        | 'providerId'
        | 'model'
        | 'grounding'
        | 'updatedAt'
      >
    >,
  ): Promise<Branch | null>;
  /**
   * Atomically deletes the given branches of `treeId` with their nodes, the
   * summaries anchored on those nodes, and the shares (with snapshots) whose
   * target is one of those nodes; then bumps the tree's updatedAt. The caller
   * passes a whole subtree (see ChatService.deleteBranch).
   */
  deleteBranches(
    treeId: string,
    branchIds: readonly string[],
    treeUpdatedAt: string,
  ): Promise<void>;

  getNode(nodeId: string): Promise<ChatNode | null>;
  listNodes(treeId: string): Promise<ChatNode[]>;
  /** Nodes of one branch ordered by seq. */
  listBranchNodes(branchId: string): Promise<ChatNode[]>;
  /** Root → node (inclusive) following parentId. Empty if not found. */
  getAncestorPath(nodeId: string): Promise<ChatNode[]>;
  /**
   * Atomically appends nodes (in order) and bumps the tree's updatedAt.
   * Rejects with ConflictError if a (branchId, seq) pair is already taken.
   */
  appendNodes(nodes: ChatNode[], treeUpdatedAt: string): Promise<void>;
  updateNode(
    nodeId: string,
    patch: Partial<{
      content: string;
      status: ChatNode['status'];
      error: string | null;
      usage: TokenUsage | null;
      sources: Citation[] | null;
    }>,
  ): Promise<void>;
  /** Nodes left in `streaming` state (e.g. after a crash). */
  listStreamingNodes(treeId: string): Promise<ChatNode[]>;

  /**
   * Imports a full tree (backup restore) atomically. Ids are expected to be
   * fresh (the caller remaps them).
   */
  importTree(tree: Tree, branches: Branch[], nodes: ChatNode[]): Promise<void>;
}

export interface SummaryRepository {
  getSummary(
    anchorNodeId: string,
    sourceHash: string,
    model: string,
  ): Promise<SummaryRecord | null>;
  putSummary(record: SummaryRecord): Promise<void>;
}

export interface ShareWithTree extends Share {
  treeTitle: string;
}

export interface ShareRepository {
  /** Shares owned by `accountId`, newest first. */
  listShares(accountId: string): Promise<ShareWithTree[]>;
  getShare(shareId: string): Promise<ShareWithTree | null>;
  getShareByToken(token: string): Promise<ShareWithTree | null>;
  /** Atomically inserts the share and (for snapshots) its serialized payload. */
  createShare(share: Share, snapshotJson: string | null): Promise<void>;
  /**
   * Atomically updates the share row and, when `snapshotJson` is not
   * undefined, replaces (string) or deletes (null) the stored snapshot.
   */
  updateShare(
    shareId: string,
    patch: Partial<
      Pick<Share, 'title' | 'expiresAt' | 'revokedAt' | 'updatedAt' | 'publishedAt' | 'version'>
    >,
    snapshotJson?: string | null,
  ): Promise<ShareWithTree | null>;
  getSnapshot(shareId: string): Promise<string | null>;
  incrementViewCount(shareId: string): Promise<void>;
}

/**
 * Per-account settings (one row per account, created on the first save). An
 * account with no row has the defaults: every field null.
 */
export interface AccountSettings {
  /** System prompt of new trees; null = the built-in default. */
  systemPrompt: string | null;
}

export interface SettingsRepository {
  /** The account's settings, or null when it has never saved any. */
  getSettings(accountId: string): Promise<AccountSettings | null>;
  /** Creates or replaces the account's settings. */
  putSettings(accountId: string, settings: AccountSettings, updatedAt: string): Promise<void>;
}

export interface Repositories {
  trees: TreeRepository;
  summaries: SummaryRepository;
  shares: ShareRepository;
  settings: SettingsRepository;
}
