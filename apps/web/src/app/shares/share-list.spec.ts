import { indexTree } from '@tangent/core/tree';
import { branch, node, share } from '@tangent/web-shared/testing';
import { describe, expect, it } from 'vitest';
import { shareBranchTitle, sharesOfTree } from './share-list';

describe('share list helpers', () => {
  it('keeps one conversation’s shares, in order', () => {
    const list = [share('a'), share('b', { treeId: 't2' }), share('c')];
    expect(sharesOfTree(list, 't1').map((s) => s.id)).toEqual(['a', 'c']);
    expect(sharesOfTree(list, 't3')).toEqual([]);
  });

  it('names the branch a subtree or path share starts from or ends in', () => {
    // The trunk (n1, n2) and a side branch "Twin primes" (n3) off n2.
    const index = indexTree(
      [
        branch('trunk', { title: 'Main thread' }),
        branch('side', { parentBranchId: 'trunk', branchPointNodeId: 'n2', title: 'Twin primes' }),
      ],
      [
        node('n1', { role: 'user' }),
        node('n2', { parentId: 'n1', seq: 1 }),
        node('n3', { branchId: 'side', parentId: 'n2', role: 'user' }),
      ],
    );
    expect(shareBranchTitle(share('a'), index)).toBeNull();
    expect(shareBranchTitle(share('b', { scope: 'path', targetNodeId: 'n3' }), index)).toBe(
      'Twin primes',
    );
    expect(shareBranchTitle(share('c', { scope: 'subtree', targetNodeId: 'n1' }), index)).toBe(
      'Main thread',
    );
    // A message no longer in the tree, or no tree loaded.
    expect(shareBranchTitle(share('d', { scope: 'path', targetNodeId: 'gone' }), index)).toBeNull();
    expect(shareBranchTitle(share('e', { scope: 'path', targetNodeId: 'n3' }), null)).toBeNull();
  });
});
