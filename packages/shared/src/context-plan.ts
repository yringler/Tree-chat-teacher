import type { ContextMode } from './domain.js';

/** Provider-agnostic chat message. System content is carried separately. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Why a segment is in the plan. Shown verbatim-ish in the Context Inspector. */
export type InclusionReason =
  /** Tree-level system prompt (always included). */
  | 'tree-system-prompt'
  /** A `system`-role node on the inherited path. */
  | 'system-node'
  /** A message from an ancestor branch, inherited through `path` mode. */
  | 'path-ancestor'
  /** A message of the target's own branch, at or before the target. */
  | 'branch-message'
  /** Summary of the parent context, because the branch uses `summary` mode. */
  | 'branch-summary'
  /** Summary replacing the oldest messages because the plan exceeded its budget. */
  | 'budget-compaction'
  /** The anchor quote highlighted when the branch was created. */
  | 'anchor-quote';

export type SegmentKind = 'system' | 'ancestor' | 'summary' | 'anchor' | 'branch';

interface SegmentBase {
  /** Stable within one plan (`seg-0`, `seg-1`, ...). */
  id: string;
  kind: SegmentKind;
  reason: InclusionReason;
  /** Human-readable explanation, e.g. "Inherited from branch 'Trunk' via path mode". */
  explanation: string;
  /** Node ids whose content this segment carries or summarizes. */
  sourceNodeIds: string[];
  /**
   * Branch this segment comes from: the owning branch for message segments,
   * the summary-mode branch for branch summaries, the target branch for
   * compaction summaries, the branch carrying the quote for anchors, null for
   * the tree system prompt.
   */
  viaBranchId: string | null;
  /** Estimated tokens for this segment's text. */
  tokens: number;
}

export interface SystemSegment extends SegmentBase {
  kind: 'system';
  text: string;
}

export interface AncestorMessageSegment extends SegmentBase {
  kind: 'ancestor';
  role: 'user' | 'assistant';
  nodeId: string;
  text: string;
}

export interface BranchMessageSegment extends SegmentBase {
  kind: 'branch';
  role: 'user' | 'assistant';
  nodeId: string;
  text: string;
}

export interface SummaryKey {
  /** Branch-point node (branch summaries) or last compacted node (compaction). */
  anchorNodeId: string;
  /** SHA-256 hex of the canonical transcript being summarized. */
  sourceHash: string;
}

export type SummaryStatus = 'ready' | 'pending' | 'failed';

export interface SummarySegment extends SegmentBase {
  kind: 'summary';
  purpose: 'branch' | 'compaction';
  key: SummaryKey;
  status: SummaryStatus;
  /** null while pending/failed. */
  text: string | null;
}

export interface AnchorSegment extends SegmentBase {
  kind: 'anchor';
  text: string;
}

export type ContextSegment =
  | SystemSegment
  | AncestorMessageSegment
  | BranchMessageSegment
  | SummarySegment
  | AnchorSegment;

/** A summary the assembler needs but was not given. The caller generates it and re-plans. */
export interface SummaryRequest {
  key: SummaryKey;
  purpose: 'branch' | 'compaction';
  sourceNodeIds: string[];
  /** What to summarize, already flattened (system prompt excluded). */
  transcript: ChatMessage[];
  /** Anchor quote to focus the summary on, if any. */
  focus: string | null;
}

export interface CompactionRecord {
  /** Oldest message nodes replaced by a compaction summary. */
  compactedNodeIds: string[];
  tokensBefore: number;
  tokensAfter: number;
  key: SummaryKey;
}

export interface TruncationRecord {
  /** Segments dropped because even compaction could not fit the budget. */
  droppedSegmentIds: string[];
  droppedNodeIds: string[];
  tokensBefore: number;
  tokensAfter: number;
}

export interface ChainLink {
  branchId: string;
  title: string;
  mode: ContextMode;
  /** For non-trunk branches: the node this branch hangs off. */
  branchPointNodeId: string | null;
}

export interface ContextBudget {
  /** Max input tokens allowed for the plan (already net of reserved output). */
  maxInputTokens: number;
  /** Estimated total tokens of the final segments. */
  usedTokens: number;
}

export interface ContextPlan {
  treeId: string;
  targetBranchId: string;
  /** Last node included (the message being replied to). null for an empty branch. */
  targetNodeId: string | null;
  /** Mode of the target branch. */
  mode: ContextMode;
  /** Trunk → target branch, in order. */
  chain: ChainLink[];
  segments: ContextSegment[];
  budget: ContextBudget;
  compaction: CompactionRecord | null;
  truncation: TruncationRecord | null;
  pendingSummaries: SummaryRequest[];
  /** True when there are no pending/failed summaries. */
  complete: boolean;
}

/** Output of rendering a plan for a provider. */
export interface RenderedPrompt {
  system: string | null;
  messages: ChatMessage[];
}
