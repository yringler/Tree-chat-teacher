import type { TreeSummary } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { patchTreeSummary } from './tree-list';

function listed(id: string, updatedAt: string): TreeSummary {
  return { id, title: id, createdAt: updatedAt, updatedAt, branchCount: 1, messageCount: 0 };
}

const list = [
  listed('t3', '2026-01-03T00:00:00.000Z'),
  listed('t2', '2026-01-02T00:00:00.000Z'),
  listed('t1', '2026-01-01T00:00:00.000Z'),
];

describe('patchTreeSummary', () => {
  it('patches the entry in place when it was not updated later', () => {
    const next = patchTreeSummary(list, 't2', { title: 'Light', messageCount: 2 });
    expect(next.map((t) => [t.id, t.title, t.messageCount])).toEqual([
      ['t3', 't3', 0],
      ['t2', 'Light', 2],
      ['t1', 't1', 0],
    ]);
    // `updatedAt` never moves back.
    expect(patchTreeSummary(list, 't2', { updatedAt: '2025-01-01T00:00:00.000Z' })[1]).toEqual(
      list[1],
    );
  });

  it('moves an entry updated later before the entries updated less recently', () => {
    expect(
      patchTreeSummary(list, 't1', { updatedAt: '2026-01-04T00:00:00.000Z' }).map((t) => t.id),
    ).toEqual(['t1', 't3', 't2']);
    expect(
      patchTreeSummary(list, 't1', { updatedAt: '2026-01-02T12:00:00.000Z' }).map((t) => t.id),
    ).toEqual(['t3', 't1', 't2']);
  });

  it('leaves the list alone when the tree is not in it', () => {
    expect(patchTreeSummary(list, 'nope', { title: 'x' })).toBe(list);
  });
});
