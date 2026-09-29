import { describe, expect, it } from 'vitest';
import {
  branchChain,
  branchLeaf,
  branchPath,
  buildOutline,
  descendantBranches,
  flattenOutline,
  indexTree,
  isEffectivelyPrivate,
  navigate,
  pathToNode,
} from '../src/tree.js';
import { ValidationError } from '../src/errors.js';
import { TreeBuilder } from './tree-fixture.js';

/**
 * trunk: t0 t1 t2 t3
 *   t1 ─ A (created later) : a0 a1
 *         a0 ─ A1 : (empty)
 *   t1 ─ B (created earlier): b0
 *   t0 ─ C (created latest, but earliest branch point) : c0
 *   t3 ─ D (private) : d0
 *         d0 ─ D1 : x0
 */
function fixture() {
  const t = new TreeBuilder();
  const trunk = t.trunk;
  const [t0, t1] = t.exchange(trunk, 'q0', 'a0');
  const [t2, t3] = t.exchange(trunk, 'q1', 'a1');
  const A = t.branch(t1, { title: 'A', createdAt: '2026-01-02T00:00:00.000Z' });
  const B = t.branch(t1, { title: 'B', createdAt: '2026-01-01T12:00:00.000Z' });
  const C = t.branch(t0, { title: 'C', createdAt: '2026-01-09T00:00:00.000Z' });
  const D = t.branch(t3, { title: 'D', isPrivate: true });
  const a0 = t.add(A, 'user', 'a q');
  const a1 = t.add(A, 'assistant', 'a a');
  const A1 = t.branch(a0, { title: 'A1' });
  const b0 = t.add(B, 'user', 'b q');
  const c0 = t.add(C, 'user', 'c q');
  const d0 = t.add(D, 'user', 'd q');
  const D1 = t.branch(d0, { title: 'D1' });
  const x0 = t.add(D1, 'user', 'x q');
  // Shuffle input order to prove sorting does not rely on it.
  const index = indexTree([...t.branches].reverse(), [...t.nodes].reverse());
  return { t, index, trunk, t0, t1, t2, t3, A, B, C, D, A1, D1, a0, a1, b0, c0, d0, x0 };
}

describe('indexTree', () => {
  it('orders nodes by seq and child branches in outline order', () => {
    const f = fixture();
    expect(f.index.trunk.id).toBe(f.trunk.id);
    expect(f.index.nodesByBranch.get(f.trunk.id)?.map((n) => n.id)).toEqual([
      f.t0.id,
      f.t1.id,
      f.t2.id,
      f.t3.id,
    ]);
    expect(f.index.childBranches.get(f.trunk.id)?.map((b) => b.title)).toEqual([
      'C',
      'B',
      'A',
      'D',
    ]);
    expect(f.index.childBranches.get(f.A.id)?.map((b) => b.title)).toEqual(['A1']);
    expect(f.index.branchesAtNode.get(f.t1.id)?.map((b) => b.title)).toEqual(['B', 'A']);
    expect(f.index.branchesAtNode.get(f.t0.id)?.map((b) => b.title)).toEqual(['C']);
    expect(f.index.branchesAtNode.has(f.t2.id)).toBe(false);
  });

  it('gives every branch an entry, even when empty', () => {
    const f = fixture();
    expect(f.index.nodesByBranch.get(f.A1.id)).toEqual([]);
    expect(f.index.childBranches.get(f.A1.id)).toEqual([]);
  });

  it('breaks createdAt ties by id', () => {
    const t = new TreeBuilder();
    const n = t.add(t.trunk, 'user', 'q');
    t.branch(n, { id: 'zz', title: 'Z' });
    t.branch(n, { id: 'aa', title: 'A' });
    const index = indexTree(t.branches, t.nodes);
    expect(index.childBranches.get(t.trunk.id)?.map((b) => b.id)).toEqual(['aa', 'zz']);
  });

  it('throws ValidationError without exactly one trunk', () => {
    const f = fixture();
    expect(() => indexTree([], [])).toThrow(ValidationError);
    const second = { ...f.trunk, id: 'other' };
    expect(() => indexTree([...f.t.branches, second], f.t.nodes)).toThrow(ValidationError);
  });
});

describe('outline', () => {
  it('builds a depth-first outline with counts and fork nodes', () => {
    const f = fixture();
    const root = buildOutline(f.index);
    expect(root.branch.id).toBe(f.trunk.id);
    expect(root.depth).toBe(0);
    expect(root.messageCount).toBe(4);
    expect(root.forkNode).toBeNull();
    const flat = flattenOutline(root);
    expect(flat.map((i) => i.branch.title)).toEqual(['Trunk', 'C', 'B', 'A', 'A1', 'D', 'D1']);
    expect(flat.map((i) => i.depth)).toEqual([0, 1, 1, 1, 2, 1, 2]);
    const a = flat.find((i) => i.branch.id === f.A.id);
    expect(a?.messageCount).toBe(2);
    expect(a?.forkNode?.id).toBe(f.t1.id);
    expect(flat.find((i) => i.branch.id === f.A1.id)?.messageCount).toBe(0);
  });
});

describe('chains and paths', () => {
  it('branchChain returns trunk → branch', () => {
    const f = fixture();
    expect(branchChain(f.index, f.A1.id).map((b) => b.title)).toEqual(['Trunk', 'A', 'A1']);
    expect(branchChain(f.index, f.trunk.id).map((b) => b.title)).toEqual(['Trunk']);
    expect(branchChain(f.index, 'nope')).toEqual([]);
  });

  it('pathToNode follows parentId across branches', () => {
    const f = fixture();
    expect(pathToNode(f.index, f.a1.id).map((n) => n.id)).toEqual([
      f.t0.id,
      f.t1.id,
      f.a0.id,
      f.a1.id,
    ]);
    expect(pathToNode(f.index, f.t0.id).map((n) => n.id)).toEqual([f.t0.id]);
    expect(pathToNode(f.index, 'nope')).toEqual([]);
  });

  it('branchPath is ancestors up to the branch point then own nodes', () => {
    const f = fixture();
    expect(branchPath(f.index, f.B.id).map((n) => n.id)).toEqual([f.t0.id, f.t1.id, f.b0.id]);
    expect(branchPath(f.index, f.A1.id).map((n) => n.id)).toEqual([f.t0.id, f.t1.id, f.a0.id]);
    expect(branchPath(f.index, f.trunk.id)).toHaveLength(4);
    expect(branchPath(f.index, 'nope')).toEqual([]);
  });

  it('branchLeaf is the last node or null', () => {
    const f = fixture();
    expect(branchLeaf(f.index, f.A.id)?.id).toBe(f.a1.id);
    expect(branchLeaf(f.index, f.A1.id)).toBeNull();
    expect(branchLeaf(f.index, 'nope')).toBeNull();
  });
});

describe('privacy and descendants', () => {
  it('isEffectivelyPrivate inherits from ancestors', () => {
    const f = fixture();
    expect(isEffectivelyPrivate(f.index, f.D.id)).toBe(true);
    expect(isEffectivelyPrivate(f.index, f.D1.id)).toBe(true);
    expect(isEffectivelyPrivate(f.index, f.A1.id)).toBe(false);
    expect(isEffectivelyPrivate(f.index, f.trunk.id)).toBe(false);
  });

  it('descendantBranches is depth-first and excludes the branch itself', () => {
    const f = fixture();
    expect(descendantBranches(f.index, f.trunk.id).map((b) => b.title)).toEqual([
      'C',
      'B',
      'A',
      'A1',
      'D',
      'D1',
    ]);
    expect(descendantBranches(f.index, f.A.id).map((b) => b.title)).toEqual(['A1']);
    expect(descendantBranches(f.index, f.A1.id)).toEqual([]);
  });
});

describe('navigate', () => {
  it('parent focuses the branch point', () => {
    const f = fixture();
    expect(navigate(f.index, f.A1.id, 'parent')).toEqual({
      branchId: f.A.id,
      focusNodeId: f.a0.id,
    });
    expect(navigate(f.index, f.A.id, 'parent')).toEqual({
      branchId: f.trunk.id,
      focusNodeId: f.t1.id,
    });
    expect(navigate(f.index, f.trunk.id, 'parent')).toBeNull();
  });

  it('siblings share the parent branch in outline order without wrap-around', () => {
    const f = fixture();
    // Trunk children: C, B, A, D — C and D hang off different nodes but are siblings.
    expect(navigate(f.index, f.C.id, 'nextSibling')).toEqual({
      branchId: f.B.id,
      focusNodeId: f.b0.id,
    });
    expect(navigate(f.index, f.B.id, 'nextSibling')).toEqual({
      branchId: f.A.id,
      focusNodeId: f.a0.id,
    });
    expect(navigate(f.index, f.A.id, 'nextSibling')).toEqual({
      branchId: f.D.id,
      focusNodeId: f.d0.id,
    });
    expect(navigate(f.index, f.D.id, 'nextSibling')).toBeNull();
    expect(navigate(f.index, f.B.id, 'prevSibling')).toEqual({
      branchId: f.C.id,
      focusNodeId: f.c0.id,
    });
    expect(navigate(f.index, f.C.id, 'prevSibling')).toBeNull();
    expect(navigate(f.index, f.A1.id, 'nextSibling')).toBeNull();
  });

  it('the trunk has no siblings', () => {
    const f = fixture();
    expect(navigate(f.index, f.trunk.id, 'nextSibling')).toBeNull();
    expect(navigate(f.index, f.trunk.id, 'prevSibling')).toBeNull();
  });

  it('firstChild focuses the first node, or null for an empty child', () => {
    const f = fixture();
    expect(navigate(f.index, f.trunk.id, 'firstChild')).toEqual({
      branchId: f.C.id,
      focusNodeId: f.c0.id,
    });
    expect(navigate(f.index, f.A.id, 'firstChild')).toEqual({
      branchId: f.A1.id,
      focusNodeId: null,
    });
    expect(navigate(f.index, f.A1.id, 'firstChild')).toBeNull();
  });

  it('returns null for unknown branches', () => {
    const f = fixture();
    expect(navigate(f.index, 'nope', 'parent')).toBeNull();
    expect(navigate(f.index, 'nope', 'firstChild')).toBeNull();
  });
});
