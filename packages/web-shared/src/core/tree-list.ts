import type { TreeSummary } from '@tangent/shared';

/**
 * The conversation list with one tree's entry patched locally, as a re-read
 * of `GET /api/trees` would have it: `updatedAt` only moves forward, and an
 * entry it moves goes before the entries updated less recently (the list is
 * most recently updated first). The same list when the tree isn't in it.
 */
export function patchTreeSummary(
  list: TreeSummary[],
  treeId: string,
  patch: Partial<Omit<TreeSummary, 'id' | 'createdAt'>>,
): TreeSummary[] {
  const i = list.findIndex((t) => t.id === treeId);
  const cur = list[i];
  if (!cur) return list;
  const updatedAt =
    patch.updatedAt && patch.updatedAt > cur.updatedAt ? patch.updatedAt : cur.updatedAt;
  const next: TreeSummary = { ...cur, ...patch, updatedAt };
  const rest = list.filter((_, j) => j !== i);
  const at = updatedAt === cur.updatedAt ? i : rest.findIndex((t) => t.updatedAt <= updatedAt);
  rest.splice(at === -1 ? rest.length : at, 0, next);
  return rest;
}
