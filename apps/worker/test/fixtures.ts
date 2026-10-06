import { DEFAULT_ACCOUNT_ID, type Branch, type ChatNode, type Share, type Tree } from '@tangent/shared';

let counter = 0;
/** Unique id per call so tests within a file never collide. */
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeTree(overrides: Partial<Tree> = {}): Tree {
  const id = overrides.id ?? uid('tree');
  return {
    id,
    accountId: DEFAULT_ACCOUNT_ID,
    title: 'Tree',
    systemPrompt: null,
    trunkBranchId: overrides.trunkBranchId ?? `${id}_trunk`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeBranch(tree: Tree, overrides: Partial<Branch> = {}): Branch {
  return {
    id: uid('br'),
    treeId: tree.id,
    parentBranchId: null,
    branchPointNodeId: null,
    contextMode: 'path',
    anchorQuote: null,
    title: 'Branch',
    titleSource: 'default',
    isPrivate: false,
    providerId: 'fake',
    model: 'fake-model',
    grounding: 'auto',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeTrunk(tree: Tree, overrides: Partial<Branch> = {}): Branch {
  return makeBranch(tree, { id: tree.trunkBranchId, title: 'Trunk', ...overrides });
}

export function makeNode(
  branch: Branch,
  seq: number,
  parentId: string | null,
  overrides: Partial<ChatNode> = {},
): ChatNode {
  return {
    id: uid('n'),
    treeId: branch.treeId,
    branchId: branch.id,
    parentId,
    seq,
    role: seq % 2 === 0 ? 'user' : 'assistant',
    content: `content ${seq}`,
    status: 'complete',
    error: null,
    providerId: null,
    model: null,
    usage: null,
    sources: null,
    createdAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

/** Builds `count` chained nodes on `branch`, the first hanging off `firstParent`. */
export function makeChain(
  branch: Branch,
  count: number,
  firstParent: string | null,
  startSeq = 0,
): ChatNode[] {
  const out: ChatNode[] = [];
  let parent = firstParent;
  for (let i = 0; i < count; i++) {
    const n = makeNode(branch, startSeq + i, parent);
    out.push(n);
    parent = n.id;
  }
  return out;
}

export function makeShare(tree: Tree, overrides: Partial<Share> = {}): Share {
  return {
    id: uid('sh'),
    token: uid('tok'),
    accountId: tree.accountId,
    treeId: tree.id,
    scope: 'tree',
    targetNodeId: null,
    includeAncestors: false,
    mode: 'snapshot',
    title: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    publishedAt: '2026-01-02T00:00:00.000Z',
    version: 1,
    viewCount: 0,
    ...overrides,
  };
}
