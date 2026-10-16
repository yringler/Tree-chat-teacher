import { indexTree } from '@tangent/core/tree';
import type { Branch, ChatNode } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { deleteBranchQuestion, deleteMessageQuestion, subtreeSize } from './delete-branch';
import * as fixtures from '../testing';

/** Branch `id` off message `at` of `parentBranchId`. */
const branch = (id: string, parentBranchId: string | null, at: string | null): Branch =>
  fixtures.branch(id, { parentBranchId, branchPointNodeId: at });

/** Message `id`, its text its id: even `seq`s are the user's. */
const node = (id: string, branchId: string, parentId: string | null, seq: number): ChatNode =>
  fixtures.node(id, {
    branchId,
    parentId,
    seq,
    content: id,
    role: seq % 2 === 0 ? 'user' : 'assistant',
  });

// trunk: u1 a1; side from a1 (u2 a2); two lanes below side from a2 (u3 / u4 a4); empty off a1.
const idx = indexTree(
  [
    branch('trunk', null, null),
    branch('side', 'trunk', 'a1'),
    branch('deep1', 'side', 'a2'),
    branch('deep2', 'side', 'a2'),
    branch('empty', 'trunk', 'a1'),
  ],
  [
    node('u1', 'trunk', null, 0),
    node('a1', 'trunk', 'u1', 1),
    node('u2', 'side', 'a1', 2),
    node('a2', 'side', 'u2', 3),
    node('u3', 'deep1', 'a2', 4),
    node('u4', 'deep2', 'a2', 4),
    node('a4', 'deep2', 'u4', 5),
  ],
);

const opts = {
  noun: { one: 'side question', many: 'side questions' },
  consequences: 'Replies still being written there are stopped.',
};

describe('subtreeSize', () => {
  it('counts a branch with everything below it', () => {
    expect(subtreeSize(idx, 'side')).toEqual({ branches: 3, messages: 5 });
    expect(subtreeSize(idx, 'deep2')).toEqual({ branches: 1, messages: 2 });
    expect(subtreeSize(idx, 'empty')).toEqual({ branches: 1, messages: 0 });
    expect(subtreeSize(idx, 'nope')).toEqual({ branches: 0, messages: 0 });
  });
});

describe('deleteBranchQuestion', () => {
  it('names what goes, in the app’s words, and that it cannot be undone', () => {
    expect(deleteBranchQuestion(idx, 'side', { ...opts, title: 'Why waves?' })).toBe(
      'Delete “Why waves?” and the 2 side questions below it (5 messages)? Replies still being written there are stopped. This cannot be undone.',
    );
    expect(
      deleteBranchQuestion(idx, 'deep2', {
        title: 'Deep',
        noun: { one: 'branch', many: 'branches' },
        consequences: 'Shares stop.',
      }),
    ).toBe('Delete “Deep” (2 messages)? Shares stop. This cannot be undone.');
  });

  it('agrees in number', () => {
    const one = indexTree(
      [branch('trunk', null, null), branch('a', 'trunk', 'a1'), branch('b', 'a', 'x')],
      [node('u1', 'trunk', null, 0), node('a1', 'trunk', 'u1', 1), node('x', 'a', 'a1', 3)],
    );
    expect(
      deleteBranchQuestion(one, 'a', { ...opts, noun: { one: 'lane', many: 'lanes' }, title: 'A' }),
    ).toContain('“A” and the 1 lane below it (1 message)?');
    expect(deleteBranchQuestion(idx, 'empty', { ...opts, title: 'E' })).toContain(
      '“E” (0 messages)?',
    );
  });

  it('has nothing to ask for the trunk or an unknown branch', () => {
    expect(deleteBranchQuestion(idx, 'trunk', { ...opts, title: 'Main' })).toBeNull();
    expect(deleteBranchQuestion(idx, 'nope', { ...opts, title: 'Nope' })).toBeNull();
  });
});

describe('deleteMessageQuestion', () => {
  // trunk: u1 a1 u2 a2; early from a1 (e1); side from a2 (s1 s2 s3); deeper from s2 (d1).
  const tree = indexTree(
    [
      branch('trunk', null, null),
      branch('early', 'trunk', 'a1'),
      branch('side', 'trunk', 'a2'),
      branch('deeper', 'side', 's2'),
    ],
    [
      node('u1', 'trunk', null, 0),
      node('a1', 'trunk', 'u1', 1),
      node('u2', 'trunk', 'a1', 2),
      node('a2', 'trunk', 'u2', 3),
      node('e1', 'early', 'a1', 0),
      node('s1', 'side', 'a2', 0),
      node('s2', 'side', 's1', 1),
      node('s3', 'side', 's2', 2),
      node('d1', 'deeper', 's2', 0),
    ],
  );
  const ask = (nodeId: string) =>
    deleteMessageQuestion(tree, nodeId, {
      title: (b) => b.id,
      noun: { one: 'tangent', many: 'tangents' },
      consequences: 'Replies are stopped.',
    });

  it('names what comes after the message: later messages and the tangents started from them', () => {
    expect(ask('u2')).toBe(
      'Delete this message? Everything after it goes too: 1 later message and 2 tangents (4 messages). Replies are stopped. This cannot be undone.',
    );
    expect(ask('u1')).toBe(
      'Delete this message? Everything after it goes too: 3 later messages and 3 tangents (5 messages). Replies are stopped. This cannot be undone.',
    );
    expect(ask('s3')).toBe('Delete this message? Replies are stopped. This cannot be undone.');
  });

  it('says that the first message of a tangent takes the tangent', () => {
    expect(ask('s1')).toBe(
      'Delete this message? It starts the tangent “side”, which goes with it along with the 1 tangent below it (4 messages). Replies are stopped. This cannot be undone.',
    );
    expect(ask('d1')).toBe(
      'Delete this message? It starts the tangent “deeper”, which goes with it (1 message). Replies are stopped. This cannot be undone.',
    );
  });

  it('is null for a reply or an unknown message', () => {
    expect(ask('a1')).toBeNull();
    expect(ask('nope')).toBeNull();
  });
});
