import type { NodeLink } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import {
  LINK_SNIPPET_CHARS,
  branchesWithLinks,
  describeEndpoint,
  indexLinks,
  linkTarget,
  otherEnd,
  pairKey,
  searchNodes,
} from '../src/links.js';
import { indexTree } from '../src/tree.js';
import { TREE_ID, TreeBuilder } from './tree-fixture.js';

/**
 * trunk "Main thread": q0 "How do owls hum?"  r0 (long Markdown reply with tangents)
 *                      q1 "And kittens?"      r1 "Kittens **whistle**."
 *   r0 ─ "Branch: Why owls hum first" : s0 "Why first?"  s1 "Owls are polite."
 *   r0 ─ "Evening practice"           : e0 "Why evenings?" e1 "Lemons applaud."
 */
function fixture() {
  const t = new TreeBuilder('Main thread');
  const at = (s: number) => `2026-01-01T00:00:${String(s).padStart(2, '0')}.000Z`;
  const q0 = t.add(t.trunk, 'user', 'How do owls hum?', { createdAt: at(1) });
  const r0 = t.add(
    t.trunk,
    'assistant',
    `## Humming\n\nOwls **hum** by [listening](https://example.org) first. ${'Slowly, '.repeat(20)}done.\n\n<tangents>\n- Why owls hum first — the polite part\n</tangents>`,
    { createdAt: at(2) },
  );
  const q1 = t.add(t.trunk, 'user', 'And kittens?', { createdAt: at(3) });
  const r1 = t.add(t.trunk, 'assistant', 'Kittens **whistle**.', { createdAt: at(4) });
  const side = t.branch(r0, { title: 'Branch: Why owls hum first', createdAt: at(5) });
  const s0 = t.add(side, 'user', 'Why first?', { createdAt: at(6) });
  const s1 = t.add(side, 'assistant', 'Owls are polite.', { createdAt: at(7) });
  const evening = t.branch(r0, { title: 'Evening practice', createdAt: at(8) });
  const e0 = t.add(evening, 'user', 'Why evenings?', { createdAt: at(9) });
  const e1 = t.add(evening, 'assistant', 'Lemons applaud owls.', { createdAt: at(10) });
  const index = indexTree(t.branches, t.nodes);
  return { t, index, side, evening, q0, r0, q1, r1, s0, s1, e0, e1 };
}

function link(id: string, sourceNodeId: string, targetNodeId: string): NodeLink {
  return {
    id,
    treeId: TREE_ID,
    sourceNodeId,
    targetNodeId,
    note: null,
    origin: 'user',
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

describe('pairKey', () => {
  it('is the same whichever way round', () => {
    expect(pairKey('a', 'b')).toBe('a|b');
    expect(pairKey('b', 'a')).toBe('a|b');
    expect(pairKey('a', 'b')).not.toBe(pairKey('a', 'c'));
  });
});

describe('indexLinks / otherEnd', () => {
  it('files each link under both of its ends, in order', () => {
    const l1 = link('l1', 'a', 'b');
    const l2 = link('l2', 'c', 'a');
    const byNode = indexLinks([l1, l2]);
    expect(byNode.get('a')).toEqual([l1, l2]);
    expect(byNode.get('b')).toEqual([l1]);
    expect(byNode.get('c')).toEqual([l2]);
    expect(byNode.has('d')).toBe(false);
    expect(indexLinks([]).size).toBe(0);
  });

  it('gives the end that is not the given node', () => {
    const l = link('l', 'a', 'b');
    expect(otherEnd(l, 'a')).toBe('b');
    expect(otherEnd(l, 'b')).toBe('a');
  });
});

describe('describeEndpoint', () => {
  it('describes a trunk message: crumbs, plain-text snippet without the tangents block', () => {
    const { index, r0 } = fixture();
    const end = describeEndpoint(index, r0.id)!;
    expect(end.node).toBe(index.nodes.get(r0.id));
    expect(end.branch.title).toBe('Main thread');
    expect(end.crumbs).toEqual(['Main thread']);
    expect(end.isTangentHead).toBe(false);
    expect(end.snippet.startsWith('Humming Owls hum by listening first.')).toBe(true);
    expect(end.snippet).not.toMatch(/[#*[\]<]/);
    expect(end.snippet).not.toContain('tangents');
    expect(end.snippet.length).toBeLessThanOrEqual(LINK_SNIPPET_CHARS);
    expect(end.snippet.endsWith('…')).toBe(true);
  });

  it('marks the first message of a tangent and names branches with the app’s titles', () => {
    const { index, s0, s1 } = fixture();
    const strip = (b: { title: string }) => b.title.replace(/^Branch: /, '');
    const head = describeEndpoint(index, s0.id, strip)!;
    expect(head.isTangentHead).toBe(true);
    expect(head.crumbs).toEqual(['Main thread', 'Why owls hum first']);
    expect(head.snippet).toBe('Why first?');
    expect(describeEndpoint(index, s1.id)!.isTangentHead).toBe(false);
    expect(describeEndpoint(index, s1.id)!.crumbs).toEqual([
      'Main thread',
      'Branch: Why owls hum first',
    ]);
  });

  it('is null for a message that is not in the tree', () => {
    expect(describeEndpoint(fixture().index, 'gone')).toBeNull();
  });
});

describe('linkTarget', () => {
  it("opens the message's branch, focused on it", () => {
    const { index, e1, evening } = fixture();
    expect(linkTarget(index, e1.id)).toEqual({ branchId: evening.id, focusNodeId: e1.id });
    expect(linkTarget(index, 'gone')).toBeNull();
  });
});

describe('searchNodes', () => {
  it('finds nothing for an empty query', () => {
    expect(searchNodes(fixture().index, '   ')).toEqual([]);
  });

  it('matches every word, case-insensitively, in the plain text', () => {
    const { index, r1 } = fixture();
    expect(searchNodes(index, 'KITTENS whistle').map((h) => h.node.id)).toEqual([r1.id]);
    // Markdown markup doesn't get in the way, and words in any order.
    expect(searchNodes(index, 'whistle kittens').map((h) => h.node.id)).toEqual([r1.id]);
    expect(searchNodes(index, 'kittens bark')).toEqual([]);
    // The tangents block is not searched.
    expect(searchNodes(index, 'polite part')).toEqual([]);
  });

  it('ranks a tangent whose title matches first, then text matches newest first, then title+text', () => {
    const { index, side, q0, r0, s0, s1, e0, e1 } = fixture();
    const hits = searchNodes(index, 'owls');
    // The side branch's first message (its title has "owls"), then text matches, newest first.
    expect(hits.map((h) => h.node.id)).toEqual([s0.id, e1.id, s1.id, r0.id, q0.id]);
    expect(hits[0]).toMatchObject({ titleHit: true, branch: { id: side.id } });
    expect(hits.slice(1).every((h) => !h.titleHit)).toBe(true);
    // Only with the branch title: "evenings" in the text, "practice" in the title.
    expect(searchNodes(index, 'practice evenings').map((h) => h.node.id)).toEqual([e0.id]);
    expect(searchNodes(index, 'evening practice').map((h) => [h.node.id, h.titleHit])).toEqual([
      [e0.id, true],
      [e1.id, false],
    ]);
  });

  it('leaves out excluded messages and stops at the limit', () => {
    const { index, s0, s1, e1 } = fixture();
    const hits = searchNodes(index, 'owls', { exclude: new Set([s0.id]), limit: 2 });
    expect(hits.map((h) => h.node.id)).toEqual([e1.id, s1.id]);
    expect(searchNodes(index, 'owls', { limit: 0 })).toEqual([]);
  });

  it('matches titles as the app names them', () => {
    const { index, s0 } = fixture();
    const strip = (b: { title: string }) => b.title.replace(/^Branch: /, '');
    expect(searchNodes(index, 'branch', { titleOf: strip })).toEqual([]);
    expect(searchNodes(index, 'branch').map((h) => h.node.id)).toContain(s0.id);
  });
});

describe('branchesWithLinks', () => {
  it('counts the links touching each branch, a link inside one branch once', () => {
    const { index, t, r0, r1, s1, e0, evening, side } = fixture();
    const links = [link('l1', r0.id, s1.id), link('l2', r0.id, r1.id), link('l3', 'gone', e0.id)];
    const counts = branchesWithLinks(index, indexLinks(links));
    expect(counts).toEqual(
      new Map([
        [t.trunk.id, 2],
        [side.id, 1],
        [evening.id, 1],
      ]),
    );
  });
});
