import { indexTree } from '@tangent/core/tree';
import type { Branch, ChatNode } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, layoutTree, type LaneMeasure } from './layout';

const T = 'tree';

function branch(id: string, parent: string | null, point: string | null, mode = 'path'): Branch {
  return {
    id,
    treeId: T,
    parentBranchId: parent,
    branchPointNodeId: point,
    contextMode: mode as Branch['contextMode'],
    anchorQuote: null,
    title: id,
    titleSource: 'default',
    isPrivate: false,
    providerId: 'fake',
    model: 'm',
    createdAt: `2026-01-01T00:00:0${id.length}Z`,
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function node(id: string, branchId: string, seq: number, parentId: string | null): ChatNode {
  return {
    id,
    treeId: T,
    branchId,
    parentId,
    seq,
    role: seq % 2 === 0 ? 'user' : 'assistant',
    content: id,
    status: 'complete',
    error: null,
    providerId: null,
    model: null,
    usage: null,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function measure(height: number, cards: [string, number, number][]): LaneMeasure {
  return { height, cards: new Map(cards.map(([id, top, h]) => [id, { top, height: h }])) };
}

const opts = { ...DEFAULT_LAYOUT, laneWidth: 100, gapX: 20, gapY: 10, headAnchor: 10 };

describe('layoutTree', () => {
  it('puts a lone trunk at the origin with its measured height', () => {
    const idx = indexTree([branch('trunk', null, null)], [node('n0', 'trunk', 0, null)]);
    const layout = layoutTree(
      idx,
      new Map([['trunk', measure(300, [['n0', 0, 50]])]]),
      new Set(),
      opts,
    );
    expect(layout.lanes).toHaveLength(1);
    expect(layout.lanes[0]).toMatchObject({ x: 0, y: 0, width: 100, height: 300, column: 0 });
    expect(layout.width).toBe(100);
    expect(layout.height).toBe(300);
    expect(layout.connectors).toEqual([]);
  });

  it('places a child one column right, level with its fork card, and draws a connector', () => {
    const idx = indexTree(
      [branch('trunk', null, null), branch('a', 'trunk', 'n1', 'summary')],
      [node('n0', 'trunk', 0, null), node('n1', 'trunk', 1, 'n0'), node('a0', 'a', 0, 'n1')],
    );
    const measures = new Map([
      [
        'trunk',
        measure(400, [
          ['n0', 0, 100],
          ['n1', 120, 200],
        ]),
      ],
      ['a', measure(150, [['a0', 0, 80]])],
    ]);
    const layout = layoutTree(idx, measures, new Set(), opts);
    const a = layout.byId.get('a')!;
    expect(a.x).toBe(120);
    expect(a.column).toBe(1);
    // Fork card n1 spans 120..320, middle 220; the head anchor (10) sits on it.
    expect(a.y).toBe(210);
    const c = layout.connectors[0]!;
    expect(c).toMatchObject({ parentId: 'trunk', childId: 'a', mode: 'summary' });
    expect(c.from).toEqual({ x: 100, y: 220 });
    expect(c.to).toEqual({ x: 120, y: 220 });
    expect(c.d.startsWith('M 100 220 C')).toBe(true);
  });

  it('pushes a later sibling below an earlier one in the same column, never up', () => {
    const idx = indexTree(
      [branch('trunk', null, null), branch('a', 'trunk', 'n1'), branch('b', 'trunk', 'n1')],
      [node('n0', 'trunk', 0, null), node('n1', 'trunk', 1, 'n0')],
    );
    const measures = new Map([
      [
        'trunk',
        measure(300, [
          ['n0', 0, 40],
          ['n1', 50, 40],
        ]),
      ],
      ['a', measure(200, [])],
      ['b', measure(100, [])],
    ]);
    const layout = layoutTree(idx, measures, new Set(), opts);
    const a = layout.byId.get('a')!;
    const b = layout.byId.get('b')!;
    expect(a.y).toBe(60); // 50 + 20 - 10
    expect(b.column).toBe(1);
    expect(b.y).toBe(a.y + a.height + opts.gapY);
  });

  it('keeps a grandchild clear of the next sibling subtree', () => {
    // a has a child aa (column 2); b forks lower and is placed in column 1
    // under a, but its own child bb must not collide with aa.
    const idx = indexTree(
      [
        branch('trunk', null, null),
        branch('a', 'trunk', 'n0'),
        branch('aa', 'a', 'a0'),
        branch('b', 'trunk', 'n1'),
        branch('bb', 'b', 'b0'),
      ],
      [
        node('n0', 'trunk', 0, null),
        node('n1', 'trunk', 1, 'n0'),
        node('a0', 'a', 0, 'n0'),
        node('b0', 'b', 0, 'n1'),
      ],
    );
    const measures = new Map([
      [
        'trunk',
        measure(600, [
          ['n0', 0, 40],
          ['n1', 500, 40],
        ]),
      ],
      ['a', measure(100, [['a0', 0, 40]])],
      ['aa', measure(900, [])],
      ['b', measure(100, [['b0', 0, 40]])],
      ['bb', measure(100, [])],
    ]);
    const layout = layoutTree(idx, measures, new Set(), opts);
    const aa = layout.byId.get('aa')!;
    const bb = layout.byId.get('bb')!;
    expect(aa.column).toBe(2);
    expect(bb.column).toBe(2);
    expect(bb.y).toBeGreaterThanOrEqual(aa.y + aa.height + opts.gapY);
    // Lanes never overlap within a column.
    for (const p of layout.lanes)
      for (const q of layout.lanes) {
        if (p === q || p.column !== q.column) continue;
        const apart = p.y + p.height <= q.y || q.y + q.height <= p.y;
        expect(apart).toBe(true);
      }
  });

  it('folds a collapsed lane into a capsule and hides its subtree', () => {
    const idx = indexTree(
      [branch('trunk', null, null), branch('a', 'trunk', 'n0'), branch('aa', 'a', 'a0')],
      [node('n0', 'trunk', 0, null), node('a0', 'a', 0, 'n0')],
    );
    const layout = layoutTree(idx, new Map(), new Set(['a']), opts);
    expect(layout.lanes.map((l) => l.branch.id)).toEqual(['trunk', 'a']);
    const a = layout.byId.get('a')!;
    expect(a.collapsed).toBe(true);
    expect(a.hiddenBranches).toBe(1);
    expect(a.height).toBe(opts.collapsedHeight);
  });

  it('uses the default height for unmeasured lanes', () => {
    const idx = indexTree([branch('trunk', null, null)], []);
    const layout = layoutTree(idx, new Map(), new Set(), opts);
    expect(layout.lanes[0]!.height).toBe(opts.defaultLaneHeight);
  });
});
