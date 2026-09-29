import type { Branch, ChatNode, ContextPlan, SummaryKey, Tree } from '@tangent/shared';
import type { TokenEstimator } from '../tokens.js';

export interface AssembleBudget {
  /** Max input tokens for the plan (caller subtracts reserved output already). */
  maxInputTokens: number;
  /** Estimated size of a compaction summary when deciding what to compact. Default 1024. */
  compactionSummaryTokens?: number;
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

/**
 * Pure context assembly. See docs/PLAN.md §"Context assembly" for the full
 * algorithm and nested-mode semantics.
 *
 * Throws `ValidationError` on inconsistent input (unknown target, broken chain,
 * target node not in target branch, missing path nodes).
 */
export function assembleContext(input: AssembleInput): ContextPlan {
  void input;
  throw new Error('not implemented');
}
