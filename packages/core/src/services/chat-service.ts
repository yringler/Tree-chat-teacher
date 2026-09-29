import type {
  Branch,
  ChatNode,
  ContextPlanResponse,
  CreateBranchRequest,
  CreateTreeRequest,
  ProviderRegistry,
  StreamEvent,
  Tree,
  TreeBackup,
  TreeDetail,
  TreeSummary,
  UpdateBranchRequest,
  UpdateTreeRequest,
} from '@tangent/shared';
import type { Repositories } from '../repository.js';
import type { Clock } from '../util.js';

export interface ChatSettings {
  /** Provider/model used for summaries; null = use the branch's own provider/model. */
  summaryProviderId: string | null;
  summaryModel: string | null;
  /** Output tokens reserved when computing the input budget. Default 4096. */
  reservedOutputTokens: number;
  /** Optional cap below the provider's context window (e.g. to save cost). */
  maxInputTokens: number | null;
  /** Generate a branch title after the first assistant reply. */
  autoTitle: boolean;
}

export interface ChatServiceDeps {
  repos: Repositories;
  providers: ProviderRegistry;
  settings: ChatSettings;
  clock?: Clock;
  newId?: () => string;
}

export interface BeginSendResult {
  branch: Branch;
  userNode: ChatNode;
  assistantNode: ChatNode;
}

/**
 * Runtime-agnostic application service for trees, branches and messages.
 * The Worker wraps it in a Durable Object (one per tree) that owns
 * generations; a Node port would wrap it in an in-process per-tree mutex.
 */
export class ChatService {
  constructor(readonly deps: ChatServiceDeps) {}

  listTrees(): Promise<TreeSummary[]> {
    throw new Error('not implemented');
  }
  /** Creates the tree and an empty trunk (provider/model default from the registry). */
  createTree(request: CreateTreeRequest): Promise<TreeDetail> {
    void request;
    throw new Error('not implemented');
  }
  getTreeDetail(treeId: string): Promise<TreeDetail> {
    void treeId;
    throw new Error('not implemented');
  }
  updateTree(treeId: string, request: UpdateTreeRequest): Promise<Tree> {
    void treeId;
    void request;
    throw new Error('not implemented');
  }
  deleteTree(treeId: string): Promise<void> {
    void treeId;
    throw new Error('not implemented');
  }

  /** New branch hanging off `fromNodeId`; inherits provider/model from the parent branch. */
  createBranch(request: CreateBranchRequest): Promise<Branch> {
    void request;
    throw new Error('not implemented');
  }
  updateBranch(branchId: string, request: UpdateBranchRequest): Promise<Branch> {
    void branchId;
    void request;
    throw new Error('not implemented');
  }

  /**
   * Plans the context for replying at `nodeId` (default: branch leaf). With
   * `resolveSummaries`, missing summaries are generated (and cached) first.
   */
  planContext(
    branchId: string,
    nodeId: string | null,
    options: { resolveSummaries: boolean; signal?: AbortSignal },
  ): Promise<ContextPlanResponse> {
    void branchId;
    void nodeId;
    void options;
    throw new Error('not implemented');
  }

  /**
   * Appends a user node to the branch leaf (or the branch point for an empty
   * branch) and a `streaming` assistant node after it, atomically.
   * Rejects with ConflictError if the branch leaf is still streaming.
   */
  beginSend(branchId: string, content: string): Promise<BeginSendResult> {
    void branchId;
    void content;
    throw new Error('not implemented');
  }

  /**
   * Runs the generation for a `beginSend` result: resolves summaries (yielding
   * `status`), streams `delta`/`usage`, then persists the assistant node and
   * yields exactly one terminal `done` or `error`. Never throws. Persists
   * partial content on abort/error. Auto-titles the branch when enabled.
   */
  runGeneration(begin: BeginSendResult, signal: AbortSignal): AsyncIterable<StreamEvent> {
    void begin;
    void signal;
    throw new Error('not implemented');
  }

  /** Marks leftover `streaming` nodes of a tree as `error` ("interrupted"). */
  recoverInterrupted(treeId: string): Promise<number> {
    void treeId;
    throw new Error('not implemented');
  }

  exportBackup(treeId: string): Promise<TreeBackup> {
    void treeId;
    throw new Error('not implemented');
  }
  /** Restores a backup under fresh ids. */
  importBackup(backup: TreeBackup): Promise<TreeDetail> {
    void backup;
    throw new Error('not implemented');
  }
}
