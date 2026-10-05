import type { Branch, ChatNode, NodeStatus, Role } from '@tangent/shared';

/** Distinctive markers so leak tests can grep serialized output. */
export const ID_MARK = 'ZQXID';
export const PROVIDER_MARK = 'PROVIDERZQX';
export const MODEL_MARK = 'MODELZQX';
export const TREE_ID = `${ID_MARK}tree`;

export interface AddOptions {
  status?: NodeStatus;
  createdAt?: string;
}

export interface BranchOptions {
  title?: string;
  anchorQuote?: string | null;
  isPrivate?: boolean;
  createdAt?: string;
  id?: string;
}

/** Builds a consistent in-memory tree respecting the branch/node invariants. */
export class TreeBuilder {
  readonly branches: Branch[] = [];
  readonly nodes: ChatNode[] = [];
  readonly trunk: Branch;
  private counter = 0;

  constructor(trunkTitle = 'Trunk') {
    this.trunk = this.makeBranch(null, null, { title: trunkTitle });
  }

  add(branch: Branch, role: Role, content: string, opts: AddOptions = {}): ChatNode {
    const own = this.nodes.filter((n) => n.branchId === branch.id);
    const prev = own[own.length - 1];
    const node: ChatNode = {
      id: `${ID_MARK}node${this.counter++}`,
      treeId: TREE_ID,
      branchId: branch.id,
      parentId: prev ? prev.id : branch.branchPointNodeId,
      seq: own.length,
      role,
      content,
      status: opts.status ?? 'complete',
      error: opts.status === 'error' ? 'boom' : null,
      providerId: role === 'assistant' ? PROVIDER_MARK : null,
      model: role === 'assistant' ? MODEL_MARK : null,
      usage: role === 'assistant' ? { inputTokens: 987654, outputTokens: 876543 } : null,
      createdAt:
        opts.createdAt ?? `2026-01-01T00:00:${String(this.counter % 60).padStart(2, '0')}.000Z`,
    };
    this.nodes.push(node);
    return node;
  }

  /** Convenience: user + assistant exchange. Returns [user, assistant]. */
  exchange(branch: Branch, question: string, answer: string): [ChatNode, ChatNode] {
    return [this.add(branch, 'user', question), this.add(branch, 'assistant', answer)];
  }

  branch(from: ChatNode, opts: BranchOptions = {}): Branch {
    return this.makeBranch(from.branchId, from.id, opts);
  }

  private makeBranch(
    parentBranchId: string | null,
    branchPointNodeId: string | null,
    opts: BranchOptions,
  ): Branch {
    const b: Branch = {
      id: opts.id ?? `${ID_MARK}branch${this.counter++}`,
      treeId: TREE_ID,
      parentBranchId,
      branchPointNodeId,
      contextMode: 'path',
      anchorQuote: opts.anchorQuote ?? null,
      title: opts.title ?? `Branch ${this.counter}`,
      titleSource: 'user',
      isPrivate: opts.isPrivate ?? false,
      providerId: PROVIDER_MARK,
      model: MODEL_MARK,
      funding: 'own-key',
      createdAt: opts.createdAt ?? '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    this.branches.push(b);
    return b;
  }
}
