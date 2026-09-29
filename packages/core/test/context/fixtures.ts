import type {
  Branch,
  ChatNode,
  ContextMode,
  ContextPlan,
  ContextSegment,
  NodeStatus,
  Role,
  SummaryRequest,
  SummarySegment,
} from '@tangent/shared';
import { assembleContext, summaryKeyString } from '../../src/context/assemble.js';
import type { AssembleBudget, AssembleInput } from '../../src/context/assemble.js';

export const TREE_ID = 'tree-1';
export const TS = '2026-01-01T00:00:00.000Z';

export interface BranchOptions {
  id?: string;
  title?: string;
  anchor?: string | null;
}

export interface NodeOptions {
  id?: string;
  status?: NodeStatus;
}

/**
 * Tiny tree builder. Node ids default to `<branchId>.<seq>` and, unless given,
 * content equals the id so assertions can use ids as texts.
 */
export class Fixture {
  readonly branches: Branch[] = [];
  readonly nodes: ChatNode[] = [];
  systemPrompt: string | null = null;
  readonly trunkId: string;
  private branchCounter = 0;

  constructor(trunkId = 'T') {
    this.trunkId = trunkId;
    this.branches.push(this.makeBranch(trunkId, null, null, 'path', 'Trunk', null));
  }

  private makeBranch(
    id: string,
    parentBranchId: string | null,
    branchPointNodeId: string | null,
    mode: ContextMode,
    title: string,
    anchor: string | null,
  ): Branch {
    return {
      id,
      treeId: TREE_ID,
      parentBranchId,
      branchPointNodeId,
      contextMode: mode,
      anchorQuote: anchor,
      title,
      titleSource: 'user',
      isPrivate: false,
      providerId: 'fake',
      model: 'fake-model',
      createdAt: TS,
      updatedAt: TS,
    };
  }

  node(id: string): ChatNode {
    const n = this.nodes.find((x) => x.id === id);
    if (!n) throw new Error(`no node ${id}`);
    return n;
  }

  branch(id: string): Branch {
    const b = this.branches.find((x) => x.id === id);
    if (!b) throw new Error(`no branch ${id}`);
    return b;
  }

  /** Appends one message to `branchId`; returns its id. */
  add(branchId: string, role: Role, content?: string, options: NodeOptions = {}): string {
    const own = this.nodes.filter((n) => n.branchId === branchId);
    const seq = own.length;
    const id = options.id ?? `${branchId}.${seq}`;
    let parentId: string | null;
    const prev = own.at(-1);
    if (prev) parentId = prev.id;
    else parentId = this.branch(branchId).branchPointNodeId;
    this.nodes.push({
      id,
      treeId: TREE_ID,
      branchId,
      parentId,
      seq,
      role,
      content: content ?? id,
      status: options.status ?? 'complete',
      error: null,
      providerId: role === 'assistant' ? 'fake' : null,
      model: role === 'assistant' ? 'fake-model' : null,
      usage: null,
      createdAt: TS,
    });
    return id;
  }

  /** Appends `count` alternating user/assistant messages (starting with user); returns ids. */
  messages(branchId: string, count: number, firstRole: 'user' | 'assistant' = 'user'): string[] {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const even = i % 2 === 0;
      const role =
        firstRole === 'user' ? (even ? 'user' : 'assistant') : even ? 'assistant' : 'user';
      ids.push(this.add(branchId, role));
    }
    return ids;
  }

  /** Creates a child branch hanging off `pointNodeId`; returns its id. */
  fork(pointNodeId: string, mode: ContextMode, options: BranchOptions = {}): string {
    const point = this.node(pointNodeId);
    this.branchCounter += 1;
    const id = options.id ?? `B${this.branchCounter}`;
    this.branches.push(
      this.makeBranch(
        id,
        point.branchId,
        pointNodeId,
        mode,
        options.title ?? id,
        options.anchor ?? null,
      ),
    );
    return id;
  }

  input(targetBranchId: string, overrides: Partial<AssembleInput> = {}): AssembleInput {
    return {
      tree: { id: TREE_ID, systemPrompt: this.systemPrompt },
      branches: this.branches,
      nodes: this.nodes,
      targetBranchId,
      targetNodeId: null,
      summaries: new Map(),
      budget: BIG_BUDGET,
      ...overrides,
    };
  }

  plan(targetBranchId: string, overrides: Partial<AssembleInput> = {}): ContextPlan {
    return assembleContext(this.input(targetBranchId, overrides));
  }
}

export const BIG_BUDGET: AssembleBudget = { maxInputTokens: 1_000_000 };

/** Estimator that makes budget math obvious: one token per character. */
export const charTokens = (text: string): number => text.length;

/** Compact, order-preserving description of a plan's segments. */
export function describe(plan: ContextPlan): string[] {
  return plan.segments.map(describeSegment);
}

export function describeSegment(s: ContextSegment): string {
  switch (s.kind) {
    case 'system':
      return `sys:${s.text}`;
    case 'ancestor':
      return `anc:${s.text}`;
    case 'branch':
      return `br:${s.text}`;
    case 'anchor':
      return `quote:${s.text}`;
    case 'summary':
      return `sum:${s.purpose}:${s.status}`;
  }
}

/** Deterministic fake summary text for a request/key. */
export function fakeSummary(anchorNodeId: string): string {
  return `summary@${anchorNodeId}`;
}

/**
 * Mimics ChatService.resolvePlan: plan → answer every request → re-plan until
 * complete. Returns the final plan, the summaries map and the number of rounds.
 */
export function resolveAll(
  input: AssembleInput,
  text: (anchorNodeId: string) => string = fakeSummary,
  maxRounds = 10,
): {
  plan: ContextPlan;
  summaries: Map<string, string>;
  rounds: number;
  requests: SummaryRequest[];
} {
  const summaries = new Map(input.summaries);
  const requests: SummaryRequest[] = [];
  for (let round = 1; round <= maxRounds; round++) {
    const plan = assembleContext({ ...input, summaries });
    if (plan.complete || plan.pendingSummaries.length === 0)
      return { plan, summaries, rounds: round, requests };
    for (const req of plan.pendingSummaries) {
      requests.push(req);
      summaries.set(summaryKeyString(req.key), text(req.key.anchorNodeId));
    }
  }
  throw new Error('did not converge');
}

export function summarySegments(plan: ContextPlan): SummarySegment[] {
  return plan.segments.filter((s): s is SummarySegment => s.kind === 'summary');
}
