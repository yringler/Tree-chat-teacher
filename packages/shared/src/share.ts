import type { ShareScope } from './domain.js';

/**
 * Public, read-only share payload. Built server-side from an allow-list of
 * fields — never from serialized DB rows. Contains no internal ids, no token
 * usage, no provider/model info, no context modes and no system prompts.
 *
 * Keys (`b0`, `m12`, ...) are assigned at projection time and are only
 * meaningful inside one payload.
 *
 * The same payload drives the public viewer page, the static HTML export and
 * the Markdown export.
 */
export interface SharePayload {
  v: 1;
  title: string;
  /** Short plain-text description for Open Graph (<= 200 chars). */
  description: string;
  scope: ShareScope;
  /** ISO timestamp of when this payload was generated (snapshot time for snapshots). */
  generatedAt: string;
  /**
   * `subtree` with `includeAncestors`: the root→(target's parent) path, shown
   * collapsed above the shared subtree. null otherwise.
   */
  context: ShareMessage[] | null;
  /** Key of the branch the viewer opens first (the top-level shared branch). */
  rootBranchKey: string;
  /** Branches in depth-first outline order; `branches[0]` is the root branch. */
  branches: ShareBranch[];
}

export interface ShareBranch {
  key: string;
  parentKey: string | null;
  /** Message (in the parent branch) this branch forks from. null for the root branch. */
  forkMessageKey: string | null;
  title: string;
  anchorQuote: string | null;
  messages: ShareMessage[];
}

export interface ShareMessage {
  key: string;
  role: 'user' | 'assistant';
  /** Markdown source. Rendered and sanitized by @tangent/render. */
  content: string;
  /** Sources a grounded reply cited (web search); absent when it cited none. */
  sources?: ShareSource[];
}

/** A cited source as shared: URL and title only (no excerpt). */
export interface ShareSource {
  url: string;
  title: string | null;
}
