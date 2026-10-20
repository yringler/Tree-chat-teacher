import { describe, expect, it } from 'vitest';
import { threadTitleOf, TRUNK_TITLE } from './domain.js';

const trunk = { parentBranchId: null, title: 'Waves' };
const side = { parentBranchId: 'trunk', title: 'Tangent: Why waves' };

describe('threadTitleOf', () => {
  it('names the trunk "Main thread" whatever it has stored, and a tangent by its own title', () => {
    expect([trunk, side].map(threadTitleOf())).toEqual([TRUNK_TITLE, 'Tangent: Why waves']);
  });

  it('names a tangent as the app does, never the trunk', () => {
    const titleOf = threadTitleOf<typeof side | typeof trunk>((b) => b.title.toUpperCase());
    expect([trunk, side].map(titleOf)).toEqual([TRUNK_TITLE, 'TANGENT: WHY WAVES']);
  });
});
