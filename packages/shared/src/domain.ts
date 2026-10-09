/**
 * Core domain model. Runtime-agnostic: no Workers / Node / DOM types.
 *
 * Vocabulary
 * - Tree: one conversation. Its messages hang off a single *trunk* branch.
 * - Branch: a linear chain of messages. Every non-trunk branch hangs off a
 *   *branch point* node in its parent branch. The first node of a branch has
 *   `parentId === branch.branchPointNodeId`; every following node's parent is
 *   the previous node of the same branch. Replying "normally" appends to the
 *   branch leaf; composing from any non-leaf message creates a new branch.
 * - Node (ChatNode): one message. Belongs to exactly one branch.
 *
 * All timestamps are ISO-8601 UTC strings. All ids are opaque strings.
 */

/**
 * The built-in account of the local dev bypass (DEV_ALLOW_NO_AUTH), and the
 * column default of `account_id`. Signed-in users each get their own accounts
 * (apps/worker/src/auth/account.ts).
 */
export const DEFAULT_ACCOUNT_ID = 'default';

import type { Citation, GroundingMode } from './grounding.js';

export type Role = 'user' | 'assistant' | 'system';
export type NodeStatus = 'streaming' | 'complete' | 'error';

/**
 * Why a node is `error`, for the apps to act on (the copy in `error` is for
 * people, and may change):
 * - `cut_off`: the reply reached its output cap; its partial text is kept;
 * - `thinking_only`: a reasoning model used the whole cap thinking, no text;
 * - `empty`: the model finished without any text;
 * - `cancelled`: the learner stopped it;
 * - `interrupted`: the generation was lost before it finished (a restart);
 * - `provider`: the provider failed, or its stream ended early (`error` says how);
 * - `failed`: the generation failed before or after the provider call.
 */
export type NodeErrorKind =
  'cut_off' | 'thinking_only' | 'empty' | 'cancelled' | 'interrupted' | 'provider' | 'failed';

/** Every `NodeErrorKind`. */
export const NODE_ERROR_KINDS: readonly NodeErrorKind[] = [
  'cut_off',
  'thinking_only',
  'empty',
  'cancelled',
  'interrupted',
  'provider',
  'failed',
];

/**
 * What a branch's subtree sends to the model *before* its own messages.
 * - `path`: whatever the parent branch sent at the branch point (transitively),
 *   i.e. the full root→node path unless an ancestor branch narrowed it.
 * - `summary`: a generated summary of that parent context, plus the anchor quote.
 * - `message`: only the branch-point message itself, plus the anchor quote.
 * - `independent`: nothing from ancestors; only the anchor quote / topic.
 */
export type ContextMode = 'path' | 'summary' | 'message' | 'independent';

/** Ordered from the most inherited context to the least. */
export const CONTEXT_MODES: readonly ContextMode[] = ['path', 'summary', 'message', 'independent'];

/**
 * Who pays for a branch's model calls in power mode (its provider id names
 * only the endpoint):
 * - `own-key`: the user's own key for that provider (bring-your-own-key);
 * - `credit`: Tangent credit, i.e. the built-in endpoint on the operator's
 *   key, metered and charged to the user's prepaid credit.
 * Learn decides how to pay per request (its payment header), so it ignores a
 * branch's funding and writes `own-key`, the value that never spends credit.
 */
export type BranchFunding = 'own-key' | 'credit';

export const BRANCH_FUNDINGS: readonly BranchFunding[] = ['own-key', 'credit'];

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface Tree {
  id: string;
  /** Owner. Branches, nodes and summaries inherit ownership through the tree. */
  accountId: string;
  title: string;
  /** Tree-wide system prompt; sent in every mode, including `independent`. */
  systemPrompt: string | null;
  trunkBranchId: string;
  createdAt: string;
  updatedAt: string;
}

export type TitleSource = 'default' | 'auto' | 'user';

/** A tree's title until it is auto-titled after the first reply (or the user names it). */
export const DEFAULT_TREE_TITLE = 'New conversation';
/** The trunk branch's title (the trunk is never auto-titled). */
export const TRUNK_TITLE = 'Main thread';
/**
 * Prefix of a branch's default title when it was started from a whole
 * message rather than a quote ("Branch: <first words of the message>").
 * UIs with their own word for branches strip it (see the Learn app).
 */
export const DEFAULT_BRANCH_TITLE_PREFIX = 'Branch: ';

export interface Branch {
  id: string;
  treeId: string;
  /** null for the trunk. */
  parentBranchId: string | null;
  /** Node (in the parent branch) this branch hangs off. null for the trunk. */
  branchPointNodeId: string | null;
  contextMode: ContextMode;
  /** Text highlighted in the branch-point message, if any. */
  anchorQuote: string | null;
  title: string;
  titleSource: TitleSource;
  /** Private branches (and everything below them) are excluded from shares/exports. */
  isPrivate: boolean;
  /** The endpoint (`openrouter`, `anthropic`, …), the same in both apps. */
  providerId: string;
  model: string;
  /** Web-search grounding for replies in this branch (power mode); absent = `auto`. */
  grounding?: GroundingMode;
  /** Who pays for the branch's calls in power mode; Learn pays per request. */
  funding: BranchFunding;
  createdAt: string;
  updatedAt: string;
}

export interface ChatNode {
  id: string;
  treeId: string;
  branchId: string;
  parentId: string | null;
  /** 0-based position within its branch. */
  seq: number;
  role: Role;
  content: string;
  status: NodeStatus;
  error: string | null;
  /** Why it is `error` (absent or null otherwise); detection keys on this, never on `error`. */
  errorKind?: NodeErrorKind | null;
  /** Set on assistant nodes: which provider/model produced them. */
  providerId: string | null;
  model: string | null;
  usage: TokenUsage | null;
  /**
   * Assistant nodes: sources of a web search this reply ran (empty when it
   * searched but cited nothing); absent or null when it didn't search.
   */
  sources?: Citation[] | null;
  createdAt: string;
}

/** Who made a link: the learner, or (reserved, not used yet) a model's suggestion. */
export type LinkOrigin = 'user' | 'ai';

/**
 * A cross-link between two messages of the same tree ("this relates to
 * that"), outside the branch structure. Stored directed (`source` is where it
 * was made from) but shown on both ends; a pair of messages has at most one
 * link, whichever way round. Linking a tangent links its first message.
 */
export interface NodeLink {
  id: string;
  treeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  /** Why the two relate, in the learner's words; null = no note. */
  note: string | null;
  origin: LinkOrigin;
  createdAt: string;
  updatedAt: string;
}

/** Cached generated summary. Key = (anchorNodeId, sourceHash, model). */
export interface SummaryRecord {
  anchorNodeId: string;
  sourceHash: string;
  providerId: string;
  model: string;
  content: string;
  treeId: string;
  createdAt: string;
}

export type ShareScope = 'tree' | 'subtree' | 'path';
export type ShareMode = 'snapshot' | 'live';

export interface Share {
  id: string;
  /** Unguessable URL token (>= 128 bits, base64url). */
  token: string;
  /** Owner (always the owner of `treeId`). */
  accountId: string;
  treeId: string;
  scope: ShareScope;
  /** Required for `subtree` and `path`; null for `tree`. */
  targetNodeId: string | null;
  /** `subtree` only: show the root→target ancestor path as collapsible context. */
  includeAncestors: boolean;
  mode: ShareMode;
  title: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Snapshot shares: when the snapshot was (re)published. */
  publishedAt: string | null;
  /** Incremented on every republish; part of the edge-cache key. */
  version: number;
  viewCount: number;
}
