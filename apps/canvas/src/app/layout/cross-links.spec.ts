import { indexTree } from '@tangent/core/tree';
import type { Branch, ChatNode, NodeLink } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { crossLinkGeometry, type CardBox } from './cross-links';
import { DEFAULT_LAYOUT, layoutTree, type LaneMeasure } from './layout';
import * as fixtures from '@tangent/web-shared/testing';
import { link } from '@tangent/web-shared/testing';

/** Lane `id` off message `point` of lane `parent`; the longer its id, the younger it is. */
const branch = (id: string, parent: string | null, point: string | null): Branch =>
  fixtures.branch(id, {
    parentBranchId: parent,
    branchPointNodeId: point,
    createdAt: `2026-01-01T00:00:0${id.length}Z`,
  });

/** Message `id` of a lane, its text its id: even `seq`s are the user's. */
const node = (id: string, branchId: string, seq: number, parentId: string | null): ChatNode =>
  fixtures.node(id, {
    branchId,
    seq,
    parentId,
    role: seq % 2 === 0 ? 'user' : 'assistant',
    content: id,
  });

function measure(height: number, cards: [string, number, number][]): LaneMeasure {
  return { height, cards: new Map(cards.map(([id, top, h]) => [id, { top, height: h }])) };
}

const opts = { ...DEFAULT_LAYOUT, laneWidth: 100, gapX: 20, gapY: 10, headAnchor: 10 };

/** trunk (n0, n1) → a off n1 (a0, a1) → aa off a1 (aa0). */
const idx = indexTree(
  [branch('trunk', null, null), branch('a', 'trunk', 'n1'), branch('aa', 'a', 'a1')],
  [
    node('n0', 'trunk', 0, null),
    node('n1', 'trunk', 1, 'n0'),
    node('a0', 'a', 0, 'n1'),
    node('a1', 'a', 1, 'a0'),
    node('aa0', 'aa', 0, 'a1'),
  ],
);

const measures = new Map([
  [
    'trunk',
    measure(400, [
      ['n0', 0, 100],
      ['n1', 120, 200],
    ]),
  ],
  [
    'a',
    measure(300, [
      ['a0', 0, 80],
      ['a1', 100, 60],
    ]),
  ],
  ['aa', measure(100, [['aa0', 0, 40]])],
]);

const cardOf: CardBox = (branchId, nodeId) => measures.get(branchId)?.cards.get(nodeId) ?? null;

function geometry(links: NodeLink[], collapsed: ReadonlySet<string> = new Set(), cards = cardOf) {
  const layout = layoutTree(idx, measures, collapsed, opts);
  return { layout, xs: crossLinkGeometry(idx, layout, links, cards, opts.headAnchor) };
}

describe('crossLinkGeometry', () => {
  it('joins cards in two columns on their facing edges, level with each card, bowed upwards', () => {
    const { layout, xs } = geometry([link('l1', 'n0', 'a1')]);
    const a = layout.byId.get('a')!;
    expect(xs).toHaveLength(1);
    const x = xs[0]!;
    expect(x.id).toBe('l1');
    // n0 spans 0..100 on the trunk (x 0..100); a1 spans 100..160 on lane a (x 120..220).
    expect(x.ends[0]).toMatchObject({ nodeId: 'n0', laneId: 'trunk', folded: false });
    expect(x.ends[0].point).toEqual({ x: 100, y: 50 });
    expect(x.ends[1]).toMatchObject({ nodeId: 'a1', branchId: 'a', laneId: 'a', folded: false });
    expect(x.ends[1].point).toEqual({ x: a.x, y: a.y + 130 });
    expect(x.d).toMatch(/^M 100 50 Q /);
    // Halfway along, above the straight line between the ends.
    expect(x.mid.x).toBeGreaterThan(100);
    expect(x.mid.x).toBeLessThan(a.x);
    const lineY = (50 + a.y + 130) / 2;
    expect(x.mid.y).toBeLessThan(lineY);
  });

  it('leaves from the left edge when the source is right of the target', () => {
    const { layout, xs } = geometry([link('l1', 'a0', 'n1')]);
    const a = layout.byId.get('a')!;
    const x = xs[0]!;
    expect(x.ends[0].point).toEqual({ x: a.x, y: a.y + 40 });
    expect(x.ends[1].point).toEqual({ x: 100, y: 220 });
  });

  it('within one lane, both ends leave on the right and the curve bulges out of it', () => {
    const { xs } = geometry([link('l1', 'n0', 'n1')]);
    const x = xs[0]!;
    expect(x.ends[0].point).toEqual({ x: 100, y: 50 });
    expect(x.ends[1].point).toEqual({ x: 100, y: 220 });
    expect(x.d).toMatch(/^M 100 50 C /);
    expect(x.mid.y).toBe(135);
    expect(x.mid.x).toBeGreaterThan(100 + 20);
  });

  it('moves an end folded away to the nearest placed lane’s head, and marks it', () => {
    // Lane a folded: aa is hidden, a itself is a capsule.
    const { layout, xs } = geometry([link('l1', 'n0', 'aa0')], new Set(['a']));
    const a = layout.byId.get('a')!;
    expect(layout.byId.has('aa')).toBe(false);
    const x = xs[0]!;
    expect(x.ends[1]).toMatchObject({ nodeId: 'aa0', branchId: 'aa', laneId: 'a', folded: true });
    expect(x.ends[1].point).toEqual({ x: a.x, y: a.y + opts.headAnchor });
    expect(x.ends[0].folded).toBe(false);
  });

  it('anchors an unmeasured card at its lane’s head, not folded', () => {
    const none: CardBox = (b, n) => (n === 'a1' ? null : cardOf(b, n));
    const { layout, xs } = geometry([link('l1', 'n0', 'a1')], new Set(), none);
    const a = layout.byId.get('a')!;
    expect(xs[0]!.ends[1]).toMatchObject({ folded: false, point: { x: a.x, y: a.y + 10 } });
  });

  it('leaves out links to unknown messages and links whose ends land on one point', () => {
    // Both ends inside the folded capsule of a: the same point.
    const { xs } = geometry(
      [link('gone', 'n0', 'nope'), link('same', 'a0', 'aa0'), link('ok', 'n0', 'n1')],
      new Set(['a']),
    );
    expect(xs.map((x) => x.id)).toEqual(['ok']);
  });
});
