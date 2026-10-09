import { indexLinks } from '@tangent/core/links';
import { indexTree } from '@tangent/core/tree';
import type { Branch, ChatNode, Role } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import {
  browseRows,
  endpointTitle,
  firstPickable,
  followActive,
  linkExclusions,
  movePick,
  pickerRows,
  relatedLabel,
  relatedLinks,
  searchRows,
  type PickerRow,
} from './links-view';
import * as fixtures from '../testing';

const at = (s: number) => `2026-01-01T00:00:${String(s).padStart(2, '0')}.000Z`;

/** Branch `title` off message `point` of `parent`. */
const branch = (id: string, title: string, parent: Branch | null, point: string | null): Branch =>
  fixtures.branch(id, {
    title,
    titleSource: 'user',
    parentBranchId: parent?.id ?? null,
    branchPointNodeId: point,
    createdAt: at(0),
    updatedAt: at(0),
  });

/** Message `id` of `b`, a side branch's messages younger than the trunk's. */
const node = (id: string, b: Branch, seq: number, role: Role, content: string): ChatNode =>
  fixtures.node(id, {
    branchId: b.id,
    seq,
    role,
    content,
    createdAt: at(seq + (b.parentBranchId === null ? 0 : 10)),
  });

/** A link made after every message. */
const link = (
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  note: string | null = null,
) => ({
  ...fixtures.link(id, sourceNodeId, targetNodeId, note),
  createdAt: at(30),
  updatedAt: at(30),
});

/**
 * trunk "Main thread": q0 "How do owls hum?" r0 "Owls **hum** softly."
 *   r0 ─ "Branch: Why first" : s0 "Why first?" s1 "Owls are polite."
 *   r0 ─ "Empty tangent"     : (no messages)
 */
function fixture() {
  const trunk = branch('trunk', 'Main thread', null, null);
  const q0 = node('q0', trunk, 0, 'user', 'How do owls hum?');
  const r0 = node('r0', trunk, 1, 'assistant', 'Owls **hum** softly.');
  const side = branch('side', 'Branch: Why first', trunk, r0.id);
  const s0 = node('s0', side, 0, 'user', 'Why first?');
  const s1 = node('s1', side, 1, 'assistant', 'Owls are polite.');
  const empty = branch('empty', 'Empty tangent', trunk, r0.id);
  const index = indexTree([trunk, side, empty], [q0, r0, s0, s1]);
  return { index, trunk, side };
}

/** Learn's naming: no "Branch: " prefix. */
const learnTitle = (b: Branch) => b.title.replace(/^Branch: /, '');

const summary = (rows: PickerRow[]) =>
  rows.map((r) => `${r.kind}:${r.nodeId ?? '-'}:${r.depth}:${r.title}`);

describe('relatedLinks', () => {
  it('resolves each link of a message to its other end, whichever way round it was made', () => {
    const { index } = fixture();
    const byNode = indexLinks([link('l1', 'q0', 's0', 'polite owls'), link('l2', 's1', 'q0')]);
    const out = relatedLinks(index, byNode, 'q0', learnTitle);
    expect(out.map((e) => [e.link.id, e.nodeId, e.title, e.crumbs])).toEqual([
      ['l1', 's0', 'Tangent: Why first', 'Main thread'],
      ['l2', 's1', 'Owls are polite.', 'Main thread › Why first'],
    ]);
    expect(out[0]?.tooltip).toBe('Main thread\nTangent: Why first\npolite owls');
    expect(relatedLinks(index, byNode, 's0').map((e) => [e.nodeId, e.title])).toEqual([
      ['q0', 'How do owls hum?'],
    ]);
  });

  it('leaves out a link whose other end is gone, and is empty for a message without links', () => {
    const { index } = fixture();
    const byNode = indexLinks([link('l1', 'q0', 'gone')]);
    expect(relatedLinks(index, byNode, 'q0')).toEqual([]);
    expect(relatedLinks(index, byNode, 'r0')).toEqual([]);
  });

  it('labels the toggle with the count, and strips Markdown from snippets', () => {
    expect(relatedLabel(1)).toBe('1 related');
    expect(relatedLabel(3)).toBe('3 related');
    const { index } = fixture();
    const out = relatedLinks(index, indexLinks([link('l1', 'q0', 'r0')]), 'q0');
    expect(out[0] && endpointTitle(out[0].endpoint)).toBe('Owls hum softly.');
  });
});

describe('linkExclusions', () => {
  it('is the source and everything it is linked to, either way round', () => {
    const byNode = indexLinks([
      link('l1', 'q0', 's0'),
      link('l2', 's1', 'q0'),
      link('l3', 'r0', 's1'),
    ]);
    expect([...linkExclusions(byNode, 'q0')].sort()).toEqual(['q0', 's0', 's1']);
    expect([...linkExclusions(byNode, 'r0')].sort()).toEqual(['r0', 's1']);
    expect(linkExclusions(byNode, null).size).toBe(0);
  });
});

describe('the picker rows', () => {
  it('browses the outline: a heading per branch, then its messages; a tangent heading picks its first message', () => {
    const { index } = fixture();
    expect(summary(browseRows(index, { titleOf: learnTitle }))).toEqual([
      'branch:-:0:Main thread',
      'message:q0:0:How do owls hum?',
      'message:r0:0:Owls hum softly.',
      'branch:s0:1:Why first',
      'message:s1:1:Owls are polite.',
    ]);
    expect(browseRows(index).find((r) => r.nodeId === 'q0')?.role).toBe('user');
  });

  it('leaves out excluded messages; a tangent whose first message is excluded becomes a plain heading', () => {
    const { index } = fixture();
    expect(summary(browseRows(index, { exclude: new Set(['q0', 's0']) }))).toEqual([
      'branch:-:0:Main thread',
      'message:r0:0:Owls hum softly.',
      'branch:-:1:Branch: Why first',
      'message:s1:1:Owls are polite.',
    ]);
    // Nothing left to pick under a heading: no heading.
    expect(summary(browseRows(index, { exclude: new Set(['s0', 's1']) }))).toEqual([
      'branch:-:0:Main thread',
      'message:q0:0:How do owls hum?',
      'message:r0:0:Owls hum softly.',
    ]);
  });

  it('searches with a query: tangent title hits as branches, then messages, with breadcrumbs', () => {
    const { index } = fixture();
    const rows = searchRows(index, 'why', { titleOf: learnTitle });
    expect(rows.map((r) => [r.kind, r.nodeId, r.title, r.crumbs, r.role])).toEqual([
      ['branch', 's0', 'Why first', 'Main thread', null],
      // Matches only with its branch's title: last.
      ['message', 's1', 'Owls are polite.', 'Main thread › Why first', 'assistant'],
    ]);
    const owls = searchRows(index, 'owls', { titleOf: learnTitle });
    expect(owls.map((r) => [r.nodeId, r.crumbs])).toEqual([
      ['s1', 'Main thread › Why first'],
      ['r0', 'Main thread'],
      ['q0', 'Main thread'],
    ]);
    expect(
      searchRows(index, 'owls', { exclude: new Set(['s1']), limit: 1 }).map((r) => r.nodeId),
    ).toEqual(['r0']);
  });

  it('browses for an empty or blank query and searches otherwise', () => {
    const { index } = fixture();
    expect(pickerRows(index, '  ')).toEqual(browseRows(index));
    expect(pickerRows(index, 'polite')).toEqual(searchRows(index, 'polite'));
    expect(pickerRows(index, 'nothing like this')).toEqual([]);
  });
});

describe('moving through the picker rows', () => {
  const { index } = fixture();
  const rows = browseRows(index);

  it('starts at the first pickable row, skipping the trunk heading', () => {
    expect(firstPickable(rows)).toBe(1);
    expect(firstPickable([])).toBe(-1);
  });

  it('moves by pickable rows and stays put at either end', () => {
    expect(movePick(rows, 1, 1)).toBe(2);
    expect(movePick(rows, 2, 1)).toBe(3);
    expect(movePick(rows, 4, 1)).toBe(4);
    expect(movePick(rows, 1, -1)).toBe(1);
    expect(movePick(rows, -1, 1)).toBe(1);
    expect(movePick([], -1, 1)).toBe(-1);
    const headed = browseRows(index, { exclude: new Set(['s0']) });
    // r0, then the "Branch: Why first" heading (not pickable), then s1.
    expect(headed[movePick(headed, 2, 1)]?.nodeId).toBe('s1');
    expect(headed[movePick(headed, 4, -1)]?.nodeId).toBe('r0');
  });

  it('keeps the highlighted message when the list changes under it, and starts over on a new query', () => {
    const before = browseRows(index);
    const after = browseRows(index, { exclude: new Set(['q0']) });
    expect(followActive({ rows: before, query: '', active: 2 }, after, '')).toBe(
      after.findIndex((r) => r.nodeId === 'r0'),
    );
    expect(followActive({ rows: before, query: '', active: 1 }, after, '')).toBe(
      firstPickable(after),
    );
    expect(followActive({ rows: before, query: '', active: 2 }, before, 'owls')).toBe(1);
    expect(followActive(undefined, before, '')).toBe(1);
  });
});
