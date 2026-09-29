import type { Branch, ChatNode, SharePayload, ShareScope, Tree } from '@tangent/shared';

export interface ProjectShareInput {
  tree: Pick<Tree, 'title'>;
  branches: readonly Branch[];
  nodes: readonly ChatNode[];
  scope: ShareScope;
  /** Required for subtree/path. */
  targetNodeId: string | null;
  /** subtree only. */
  includeAncestors: boolean;
  title: string | null;
  /** ISO timestamp stored as `generatedAt`. */
  now: string;
  /** Owner exports may opt in; shares never do. Default false. */
  includePrivate?: boolean;
}

export type ProjectShareResult =
  | { ok: true; payload: SharePayload }
  | { ok: false; reason: 'target_not_found' | 'target_private' | 'empty' };

/**
 * Builds the public payload from an allow-list of fields. Rules:
 * - only `user`/`assistant` nodes with status `complete` are included;
 * - private branches and all their descendants are omitted entirely; a target
 *   inside a private branch yields `target_private`;
 * - `tree`: every branch, rooted at the trunk;
 * - `subtree`: the target node's branch from the target onward is the root
 *   branch, plus every branch hanging off any included node, recursively;
 *   `includeAncestors` puts root → target's parent in `context`;
 * - `path`: one branch holding root → target, no other branches;
 * - keys are `b<n>`/`m<n>` in depth-first order; no internal ids leak;
 * - description: first user message as plain text, <= 200 chars.
 */
export function projectShare(input: ProjectShareInput): ProjectShareResult {
  void input;
  throw new Error('not implemented');
}
