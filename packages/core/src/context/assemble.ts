import type {
  AnchorSegment,
  Branch,
  ChainLink,
  ChatMessage,
  ChatNode,
  CompactionRecord,
  ContextPlan,
  ContextSegment,
  SummaryKey,
  SummaryRequest,
  SummarySegment,
  SystemSegment,
  Tree,
  TruncationRecord,
} from '@tangent/shared';
import { ValidationError } from '../errors.js';
import { sha256Hex } from '../hash.js';
import { estimateTokens as defaultEstimateTokens, MESSAGE_OVERHEAD_TOKENS } from '../tokens.js';
import type { TokenEstimator } from '../tokens.js';

export interface AssembleBudget {
  /** Max input tokens for the plan (caller subtracts reserved output already). */
  maxInputTokens: number;
  /** Estimated size of a compaction summary when deciding what to compact. Default 1024. */
  compactionSummaryTokens?: number;
  /**
   * About the share of `maxInputTokens` a compaction brings the context down
   * to (default `DEFAULT_COMPACTION_TARGET`): it compacts the overflow in
   * steps of `maxInputTokens × (1 − compactionTarget)`, and later turns grow
   * into that headroom while reusing the same summary. 1 compacts only what
   * the current turn needs (a new summary on every turn over the budget).
   */
  compactionTarget?: number;
  /**
   * Number of most recent message segments that are never compacted or
   * truncated. Default 2. The target message itself is always kept.
   */
  minTailMessages?: number;
}

export interface AssembleInput {
  tree: Pick<Tree, 'id' | 'systemPrompt'>;
  /** At least the chain trunk → target branch. Extra branches are ignored. */
  branches: readonly Branch[];
  /**
   * At least the ancestor path root → target node (or root → branch point for
   * an empty target branch). Extra nodes are ignored. Nodes with status
   * `streaming` or `error` and empty content are skipped.
   */
  nodes: readonly ChatNode[];
  targetBranchId: string;
  /** Node to plan up to (inclusive); must belong to the target branch. null = branch leaf. */
  targetNodeId: string | null;
  /** Available summaries keyed by `summaryKeyString(key)`. */
  summaries: ReadonlyMap<string, string>;
  /** Summaries whose generation failed (keyed like `summaries`). */
  failedSummaries?: ReadonlySet<string>;
  budget: AssembleBudget;
  estimateTokens?: TokenEstimator;
}

export function summaryKeyString(key: SummaryKey): string {
  return `${key.anchorNodeId}:${key.sourceHash}`;
}

export const DEFAULT_COMPACTION_SUMMARY_TOKENS = 1024;
/** `AssembleBudget.compactionTarget`: compact down to about half the budget. */
export const DEFAULT_COMPACTION_TARGET = 0.5;
export const DEFAULT_MIN_TAIL_MESSAGES = 2;

/** Prefixes used when a summary / anchor is flattened into a transcript message. */
export const FLATTENED_SUMMARY_PREFIX = '[Summary of earlier conversation] ';
export const FLATTENED_ANCHOR_PREFIX = '[Focus excerpt] ';

/** Segment before ids are assigned (ids are given after the budget pass). */
type Draft<T extends ContextSegment = ContextSegment> = T extends ContextSegment
  ? Omit<T, 'id'>
  : never;
type DraftSummary = Draft<SummarySegment>;

interface Ctx {
  estimate: TokenEstimator;
  summaries: ReadonlyMap<string, string>;
  failed: ReadonlySet<string>;
  /** Transcript + focus of every summary segment whose transcript is computable. */
  requests: Map<DraftSummary, { transcript: ChatMessage[]; focus: string | null }>;
  /** For summaries whose transcript is unknown: the inner summaries that are not ready. */
  blockers: Map<DraftSummary, DraftSummary[]>;
}

/**
 * Pure context assembly. See docs/PLAN.md §"Context assembly" for the full
 * algorithm and nested-mode semantics.
 *
 * Throws `ValidationError` on inconsistent input (unknown target, broken chain,
 * target node not in target branch, missing path nodes).
 */
export function assembleContext(input: AssembleInput): ContextPlan {
  const estimate = input.estimateTokens ?? defaultEstimateTokens;
  const ctx: Ctx = {
    estimate,
    summaries: input.summaries,
    failed: input.failedSummaries ?? new Set<string>(),
    requests: new Map(),
    blockers: new Map(),
  };

  const chain = resolveChain(branchIndex(input.branches), input.tree.id, input.targetBranchId);
  const ownNodes = resolveOwnNodes(indexNodes(input.nodes), chain, input.targetNodeId);

  // ctx(0) … ctx(k), PLAN §4.1.
  const k = chain.length - 1;
  let effective: Draft[] = [];
  for (let i = 0; i <= k; i++) {
    const branch = chain[i]!;
    const parent = i > 0 ? chain[i - 1]! : null;
    const next: Draft[] = [];
    if (parent) {
      switch (branch.contextMode) {
        case 'path':
          next.push(...effective);
          break;
        case 'summary': {
          const summary = branchSummary(ctx, branch, parent, effective);
          if (summary) next.push(summary);
          break;
        }
        case 'message': {
          const point = branchPointSegment(ctx, branch, parent, ownNodes[i - 1]!);
          if (point) next.push(point);
          break;
        }
        case 'independent':
          break;
        default: {
          // A new mode fails to compile here until it is handled.
          const _unhandled: never = branch.contextMode;
        }
      }
      const anchor = anchorSegment(ctx, branch);
      if (anchor) next.push(anchor);
    }
    for (const node of ownNodes[i]!) next.push(nodeSegment(ctx, node, branch, i === k));
    effective = next;
  }

  const drafts: Draft[] = [];
  const systemPrompt = input.tree.systemPrompt;
  if (systemPrompt !== null && systemPrompt.trim() !== '') {
    drafts.push({
      kind: 'system',
      reason: 'tree-system-prompt',
      explanation: 'Tree system prompt (sent in every mode)',
      sourceNodeIds: [],
      viaBranchId: null,
      tokens: estimate(systemPrompt),
      text: systemPrompt,
    } satisfies Draft<SystemSegment>);
  }
  drafts.push(...effective);

  const target = chain[k]!;
  // The last included node of the target branch; its message segment is never compacted or dropped.
  const lastOwn = ownNodes[k]!.at(-1);
  const targetNodeId = lastOwn?.id ?? null;
  const protectedNodeId = lastOwn && lastOwn.role !== 'system' ? lastOwn.id : null;

  const budgeted = applyBudget(ctx, input.budget, drafts, target, protectedNodeId);

  const segments: ContextSegment[] = budgeted.segments.map(
    (s, idx) => ({ ...s, id: `seg-${idx}` }) as ContextSegment,
  );
  const pendingSummaries: SummaryRequest[] = [];
  let complete = true;
  const requested = new Set<string>();
  // A pending summary whose transcript is unknown has no request of its own;
  // the requests of the inner summaries blocking it are emitted instead, so
  // the caller's re-plan loop resolves them inner-first.
  const collect = (seg: DraftSummary): void => {
    if (seg.status !== 'pending') return;
    const req = ctx.requests.get(seg);
    if (!req) {
      for (const inner of ctx.blockers.get(seg) ?? []) collect(inner);
      return;
    }
    const keyString = summaryKeyString(seg.key);
    if (requested.has(keyString)) return;
    requested.add(keyString);
    pendingSummaries.push({
      key: seg.key,
      purpose: seg.purpose,
      sourceNodeIds: [...seg.sourceNodeIds],
      transcript: req.transcript,
      focus: req.focus,
    });
  };
  for (const seg of budgeted.segments) {
    if (seg.kind !== 'summary' || seg.status === 'ready') continue;
    complete = false;
    collect(seg);
  }

  let truncation: TruncationRecord | null = null;
  if (budgeted.truncation) {
    const dropped = budgeted.truncation.dropped;
    truncation = {
      // Dropped segments are not part of the plan; they are numbered after the kept ones.
      droppedSegmentIds: dropped.map((_, j) => `seg-${segments.length + j}`),
      droppedNodeIds: unique(dropped.flatMap((s) => s.sourceNodeIds)),
      tokensBefore: budgeted.truncation.tokensBefore,
      tokensAfter: budgeted.truncation.tokensAfter,
      compactionFailed: budgeted.truncation.compactionFailed,
    };
  }

  return {
    treeId: input.tree.id,
    targetBranchId: target.id,
    targetNodeId,
    mode: target.contextMode,
    chain: chain.map((b): ChainLink => ({
      branchId: b.id,
      title: b.title,
      mode: b.contextMode,
      branchPointNodeId: b.branchPointNodeId,
    })),
    segments,
    budget: {
      maxInputTokens: input.budget.maxInputTokens,
      usedTokens: sumTokens(budgeted.segments),
    },
    compaction: budgeted.compaction,
    truncation,
    pendingSummaries,
    complete,
  };
}

// ---------------------------------------------------------------------------
// Chain and node resolution

/**
 * Branches or nodes that don't make whole conversations (a damaged tree or
 * backup). The message names them by id; `problem` says what is wrong in the
 * user's terms.
 */
export class BrokenChainError extends ValidationError {
  constructor(
    message: string,
    readonly problem: string,
  ) {
    super(message);
  }
}

/**
 * Checks that `branches` and `nodes` hold every branch's whole conversation,
 * as planning a reply anywhere in the tree needs: each branch's chain reaches
 * the trunk and branches off a message of its parent (the checks
 * `assembleContext` makes), each message belongs to a branch and follows the
 * one before it (its branch's previous message, or its branch point), and no
 * message is missing. Throws a `BrokenChainError` naming the first problem.
 */
export function checkBranches(
  tree: Pick<Tree, 'id'>,
  branches: readonly ChainBranch[],
  nodes: readonly ChatNode[],
): void {
  const byBranchId = branchIndex(branches);
  const index = indexNodes(nodes);
  for (const node of nodes) {
    if (!byBranchId.has(node.branchId)) {
      throw new BrokenChainError(
        `Node ${node.id} is in unknown branch ${node.branchId}`,
        'a message belongs to a branch that is missing',
      );
    }
  }
  for (const branch of branches) {
    const chain = resolveChain(byBranchId, tree.id, branch.id);
    resolveOwnNodes(index, chain, null);
    let previous = branch.branchPointNodeId;
    for (const node of index.byBranch.get(branch.id) ?? []) {
      if (node.parentId !== previous) {
        throw new BrokenChainError(
          `Node ${node.id} has parent ${node.parentId ?? 'null'}, not ${previous ?? 'null'}`,
          'a message does not follow the one before it',
        );
      }
      previous = node.id;
    }
  }
}

/** What resolving a chain reads of a branch. */
type ChainBranch = Pick<Branch, 'id' | 'treeId' | 'parentBranchId' | 'branchPointNodeId'>;

function branchIndex<B extends ChainBranch>(branches: readonly B[]): Map<string, B> {
  return new Map(branches.map((b) => [b.id, b]));
}

/** Nodes by id, and each branch's nodes in seq order. */
interface NodeIndex {
  byId: ReadonlyMap<string, ChatNode>;
  byBranch: ReadonlyMap<string, readonly ChatNode[]>;
}

function indexNodes(nodes: readonly ChatNode[]): NodeIndex {
  const byId = new Map<string, ChatNode>();
  const byBranch = new Map<string, ChatNode[]>();
  for (const n of nodes) {
    byId.set(n.id, n);
    let list = byBranch.get(n.branchId);
    if (!list) byBranch.set(n.branchId, (list = []));
    list.push(n);
  }
  for (const list of byBranch.values()) list.sort((a, b) => a.seq - b.seq);
  return { byId, byBranch };
}

function resolveChain<B extends ChainBranch>(
  byId: ReadonlyMap<string, B>,
  treeId: string,
  targetBranchId: string,
): B[] {
  const target = byId.get(targetBranchId);
  if (!target)
    throw new BrokenChainError(`Unknown target branch ${targetBranchId}`, 'a branch is missing');

  const chain: B[] = [];
  const seen = new Set<string>();
  let current: B | undefined = target;
  while (current) {
    if (seen.has(current.id)) {
      throw new BrokenChainError(
        `Branch chain has a cycle at ${current.id}`,
        'its branches branch off each other in a loop',
      );
    }
    if (current.treeId !== treeId) {
      throw new BrokenChainError(
        `Branch ${current.id} does not belong to tree ${treeId}`,
        'a branch belongs to another conversation',
      );
    }
    seen.add(current.id);
    chain.push(current);
    const parentId: string | null = current.parentBranchId;
    if (parentId === null) break;
    if (current.branchPointNodeId === null) {
      throw new BrokenChainError(
        `Branch ${current.id} has a parent branch but no branch point`,
        'a branch has no message it branches off',
      );
    }
    const parent = byId.get(parentId);
    if (!parent) {
      throw new BrokenChainError(
        `Parent branch ${parentId} of branch ${current.id} is missing`,
        'a branch branches off a branch that is missing',
      );
    }
    current = parent;
  }
  return chain.reverse();
}

function includeNode(node: ChatNode): boolean {
  if (node.status === 'streaming') return false;
  if (node.status === 'error') return node.content !== '';
  return true;
}

/**
 * Nodes of each chain branch that lie on the ancestor path to `targetNodeId`
 * (null: the target branch's leaf), skipped nodes removed.
 */
function resolveOwnNodes(
  index: NodeIndex,
  chain: readonly ChainBranch[],
  targetNodeId: string | null,
): ChatNode[][] {
  const missing = 'a branch is missing some of its messages';
  const k = chain.length - 1;
  const result: ChatNode[][] = [];
  for (let i = 0; i <= k; i++) {
    const branch = chain[i]!;
    const nodes = index.byBranch.get(branch.id) ?? [];
    let lastSeq: number;
    if (i < k) {
      const child = chain[i + 1]!;
      const pointId = child.branchPointNodeId!;
      const point = index.byId.get(pointId);
      if (!point) {
        throw new BrokenChainError(
          `Branch point ${pointId} of branch ${child.id} is missing`,
          'a branch branches off a message that is missing',
        );
      }
      if (point.branchId !== branch.id) {
        throw new BrokenChainError(
          `Branch point ${pointId} of branch ${child.id} is not in parent branch ${branch.id}`,
          'a branch branches off a message outside its parent branch',
        );
      }
      lastSeq = point.seq;
    } else if (targetNodeId !== null) {
      const targetNode = index.byId.get(targetNodeId);
      if (!targetNode || targetNode.branchId !== branch.id) {
        throw new BrokenChainError(
          `Target node ${targetNodeId} is not in target branch ${branch.id}`,
          'a message is not in its branch',
        );
      }
      lastSeq = targetNode.seq;
    } else {
      lastSeq = nodes.at(-1)?.seq ?? -1;
    }
    const own = nodes.filter((n) => n.seq <= lastSeq);
    own.forEach((n, idx) => {
      if (n.seq !== idx)
        throw new BrokenChainError(
          `Branch ${branch.id} is missing path node at seq ${idx}`,
          missing,
        );
    });
    if (own.length !== lastSeq + 1) {
      throw new BrokenChainError(
        `Branch ${branch.id} is missing path nodes up to seq ${lastSeq}`,
        missing,
      );
    }
    result.push(own.filter(includeNode));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Segment builders

function quoted(title: string): string {
  return `‘${title}’`;
}

function nodeSegment(ctx: Ctx, node: ChatNode, branch: Branch, isTarget: boolean): Draft {
  if (node.role === 'system') {
    return {
      kind: 'system',
      reason: 'system-node',
      explanation: `System message in ${quoted(branch.title)}`,
      sourceNodeIds: [node.id],
      viaBranchId: branch.id,
      tokens: ctx.estimate(node.content),
      text: node.content,
    };
  }
  const tokens = ctx.estimate(node.content) + MESSAGE_OVERHEAD_TOKENS;
  if (isTarget) {
    return {
      kind: 'branch',
      reason: 'branch-message',
      explanation: `Message in this branch ${quoted(branch.title)}`,
      sourceNodeIds: [node.id],
      viaBranchId: branch.id,
      tokens,
      role: node.role,
      nodeId: node.id,
      text: node.content,
    };
  }
  return {
    kind: 'ancestor',
    reason: 'path-ancestor',
    explanation: `Inherited from ${quoted(branch.title)} via path mode`,
    sourceNodeIds: [node.id],
    viaBranchId: branch.id,
    tokens,
    role: node.role,
    nodeId: node.id,
    text: node.content,
  };
}

/**
 * The branch-point message of a `message`-mode branch, or null when it is not
 * sent (an in-flight or failed reply). `parentOwn` is the parent's own path
 * nodes, which end at the branch point unless it was skipped.
 */
function branchPointSegment(
  ctx: Ctx,
  branch: Branch,
  parent: Branch,
  parentOwn: readonly ChatNode[],
): Draft | null {
  const node = parentOwn.at(-1);
  if (!node || node.id !== branch.branchPointNodeId) return null;
  const segment = nodeSegment(ctx, node, parent, false);
  if (segment.kind !== 'ancestor') return segment;
  return {
    ...segment,
    reason: 'branch-point-message',
    explanation:
      `The message in ${quoted(parent.title)} that ${quoted(branch.title)} branched from, ` +
      'because it uses parent-message mode',
  };
}

function anchorText(branch: Branch): string | null {
  const quote = branch.anchorQuote;
  return quote !== null && quote.trim() !== '' ? quote : null;
}

function anchorSegment(ctx: Ctx, branch: Branch): Draft<AnchorSegment> | null {
  const text = anchorText(branch);
  if (text === null) return null;
  return {
    kind: 'anchor',
    reason: 'anchor-quote',
    explanation: `Excerpt highlighted when ${quoted(branch.title)} was created`,
    sourceNodeIds: branch.branchPointNodeId === null ? [] : [branch.branchPointNodeId],
    viaBranchId: branch.id,
    tokens: ctx.estimate(text),
    text,
  };
}

/**
 * `flatten(segments)` (PLAN §4.3). Returns null when the transcript is unknown
 * because it contains a summary that is not ready yet.
 */
function flatten(segments: readonly Draft[]): ChatMessage[] | null {
  const out: ChatMessage[] = [];
  for (const s of segments) {
    switch (s.kind) {
      case 'system':
        break;
      case 'ancestor':
      case 'branch':
        out.push({ role: s.role, content: s.text });
        break;
      case 'anchor':
        out.push({ role: 'user', content: FLATTENED_ANCHOR_PREFIX + s.text });
        break;
      case 'summary':
        if (s.status !== 'ready' || s.text === null) return null;
        out.push({ role: 'user', content: FLATTENED_SUMMARY_PREFIX + s.text });
        break;
    }
  }
  return out;
}

/**
 * Placeholder hash for a summary whose transcript is unknown (an inner summary
 * is pending/failed). It can never equal a real `{transcript, focus}` hash, so
 * such a segment is always `pending` and never looked up.
 */
function unresolvedHash(blockers: readonly DraftSummary[], focus: string | null): string {
  const inner = blockers.map((s) => summaryKeyString(s.key));
  return sha256Hex(JSON.stringify({ unresolved: inner, focus }));
}

function summarySourceIds(segments: readonly Draft[]): string[] {
  return unique(segments.filter((s) => s.kind !== 'system').flatMap((s) => s.sourceNodeIds));
}

interface SummarySpec {
  purpose: 'branch' | 'compaction';
  anchorNodeId: string;
  focus: string | null;
  viaBranchId: string;
  explanation: string;
  reason: 'branch-summary' | 'budget-compaction';
}

function buildSummary(ctx: Ctx, spec: SummarySpec, source: readonly Draft[]): DraftSummary {
  const transcript = flatten(source);
  const sourceNodeIds = summarySourceIds(source);
  const base = {
    kind: 'summary' as const,
    reason: spec.reason,
    explanation: spec.explanation,
    sourceNodeIds,
    viaBranchId: spec.viaBranchId,
    purpose: spec.purpose,
  };
  if (transcript === null) {
    const blockers = source.filter(
      (s): s is DraftSummary => s.kind === 'summary' && s.status !== 'ready',
    );
    const key = {
      anchorNodeId: spec.anchorNodeId,
      sourceHash: unresolvedHash(blockers, spec.focus),
    };
    const seg: DraftSummary = { ...base, key, status: 'pending', text: null, tokens: 0 };
    ctx.blockers.set(seg, blockers);
    return seg;
  }
  const key: SummaryKey = {
    anchorNodeId: spec.anchorNodeId,
    sourceHash: sha256Hex(JSON.stringify({ transcript, focus: spec.focus })),
  };
  const keyString = summaryKeyString(key);
  const text = ctx.summaries.get(keyString);
  let seg: DraftSummary;
  if (text !== undefined) {
    seg = { ...base, key, status: 'ready', text, tokens: ctx.estimate(text) };
  } else if (ctx.failed.has(keyString)) {
    seg = { ...base, key, status: 'failed', text: null, tokens: 0 };
  } else {
    seg = { ...base, key, status: 'pending', text: null, tokens: 0 };
  }
  ctx.requests.set(seg, { transcript, focus: spec.focus });
  return seg;
}

function branchSummary(
  ctx: Ctx,
  branch: Branch,
  parent: Branch,
  parentCtx: readonly Draft[],
): DraftSummary | null {
  // Nothing to summarize (e.g. the parent context is only system segments).
  if (!parentCtx.some((s) => s.kind !== 'system')) return null;
  const focus = anchorText(branch);
  return buildSummary(
    ctx,
    {
      purpose: 'branch',
      reason: 'branch-summary',
      anchorNodeId: branch.branchPointNodeId!,
      focus,
      viaBranchId: branch.id,
      explanation:
        `Summary of what ${quoted(parent.title)} sent at the branch point, because ` +
        `${quoted(branch.title)} uses summary mode` +
        (focus === null ? '' : ' (focused on the anchor quote)'),
    },
    parentCtx,
  );
}

// ---------------------------------------------------------------------------
// Budget pass (PLAN §4.4)

interface BudgetResult {
  segments: Draft[];
  compaction: CompactionRecord | null;
  truncation: {
    dropped: Draft[];
    tokensBefore: number;
    tokensAfter: number;
    compactionFailed: boolean;
  } | null;
}

function sumTokens(segments: readonly Draft[]): number {
  let total = 0;
  for (const s of segments) total += s.tokens;
  return total;
}

function isMessage(s: Draft): boolean {
  return s.kind === 'ancestor' || s.kind === 'branch';
}

function isProtectedTarget(s: Draft, targetNodeId: string | null): boolean {
  return targetNodeId !== null && s.kind === 'branch' && s.nodeId === targetNodeId;
}

/** `budget.compactionTarget`, clamped to [0, 1]; the default when absent or not a number. */
function compactionTarget(budget: AssembleBudget): number {
  const t = budget.compactionTarget;
  if (t === undefined || !Number.isFinite(t)) return DEFAULT_COMPACTION_TARGET;
  return Math.min(1, Math.max(0, t));
}

function applyBudget(
  ctx: Ctx,
  budget: AssembleBudget,
  input: Draft[],
  target: Branch,
  targetNodeId: string | null,
): BudgetResult {
  const max = budget.maxInputTokens;
  const estimatedSummary = budget.compactionSummaryTokens ?? DEFAULT_COMPACTION_SUMMARY_TOKENS;
  const minTail = Math.max(0, budget.minTailMessages ?? DEFAULT_MIN_TAIL_MESSAGES);
  const totalBefore = sumTokens(input);
  if (totalBefore <= max) return { segments: input, compaction: null, truncation: null };

  let segments = input;
  let compaction: CompactionRecord | null = null;
  let compactionFailed = false;

  // Candidates: non-system segments before the protected tail (the last
  // `minTail` message segments and the target).
  const messageIdx = input.flatMap((s, idx) => (isMessage(s) ? [idx] : []));
  let tailStart =
    minTail > 0 && messageIdx.length > 0
      ? messageIdx[Math.max(0, messageIdx.length - minTail)]!
      : input.length;
  const targetIdx = input.findIndex((s) => isProtectedTarget(s, targetNodeId));
  if (targetIdx !== -1) tailStart = Math.min(tailStart, targetIdx);
  const candidates = input.slice(0, tailStart).filter((s) => s.kind !== 'system');

  // Hysteresis: the compacted prefix must hold at least `needed` tokens to
  // fit; it holds the overflow rounded up to a whole number of steps (the
  // budget's share above the target) plus the summary's estimate, counted
  // from the start of the context, which brings the context down to about the
  // target. The boundary, and so the summary's key and the prefix sent after
  // it, then stays put until the context outgrows the budget by another step:
  // later turns reuse the cached summary and the cached prompt prefix instead
  // of compacting one more segment (a new summary call and a new prefix)
  // every turn.
  const overflow = totalBefore - max;
  const needed = overflow + estimatedSummary;
  const step = Math.floor(max * (1 - compactionTarget(budget)));
  const goal = step >= 1 ? Math.ceil(overflow / step) * step + estimatedSummary : needed;
  let saved = 0;
  let prefixLength = 0;
  for (let j = 0; j < candidates.length; j++) {
    saved += candidates[j]!.tokens;
    if (saved >= goal) {
      prefixLength = j + 1;
      break;
    }
  }
  // The goal is out of reach (the protected tail is large): compact all the
  // candidates when that fits at all. A later turn, with more candidates,
  // moves to the goal's boundary once and stays there.
  if (prefixLength === 0 && candidates.length > 0 && saved >= needed) {
    prefixLength = candidates.length;
  }

  if (prefixLength > 0) {
    const prefix = candidates.slice(0, prefixLength);
    const compactedNodeIds = summarySourceIds(prefix);
    const summary = buildSummary(
      ctx,
      {
        purpose: 'compaction',
        reason: 'budget-compaction',
        anchorNodeId: compactedNodeIds.at(-1) ?? '',
        focus: null,
        viaBranchId: target.id,
        explanation:
          `Summary of the ${prefixLength} oldest context segments, replacing them because the ` +
          `context exceeded the budget of ${max} tokens` +
          (step >= 1
            ? `; compacted about ${step} tokens at a time, so the next turns reuse this summary`
            : ''),
      },
      prefix,
    );
    // A summary that failed, or never can be made, leaves the prefix in
    // place: dropping all of it would lose more than the truncation below,
    // which drops only what must go.
    compactionFailed = unresolvable(ctx, summary);
    if (!compactionFailed) {
      const inPrefix = new Set<Draft>(prefix);
      const next: Draft[] = [];
      let placed = false;
      for (const s of segments) {
        if (!inPrefix.has(s)) next.push(s);
        else if (!placed) {
          next.push(summary);
          placed = true;
        }
      }
      segments = next;
      compaction = {
        compactedNodeIds,
        tokensBefore: totalBefore,
        tokensAfter: sumTokens(segments),
        key: summary.key,
      };
    }
  }

  const beforeTruncation = sumTokens(segments);
  if (beforeTruncation <= max) return { segments, compaction, truncation: null };

  // Last resort: drop the oldest non-system segments, never the target.
  const dropped = new Set<Draft>();
  let total = beforeTruncation;
  for (const s of segments) {
    if (total <= max) break;
    if (s.kind === 'system' || isProtectedTarget(s, targetNodeId)) continue;
    dropped.add(s);
    total -= s.tokens;
  }
  if (dropped.size === 0) return { segments, compaction, truncation: null };
  return {
    segments: segments.filter((s) => !dropped.has(s)),
    compaction,
    truncation: {
      dropped: [...dropped],
      tokensBefore: beforeTruncation,
      tokensAfter: total,
      compactionFailed,
    },
  };
}

/**
 * Whether `summary` can't be made in this plan: it failed, or its transcript
 * holds a summary that can't (a failed one, however deeply nested).
 */
function unresolvable(ctx: Ctx, summary: DraftSummary): boolean {
  if (summary.status === 'failed') return true;
  return (ctx.blockers.get(summary) ?? []).some((inner) => unresolvable(ctx, inner));
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}
