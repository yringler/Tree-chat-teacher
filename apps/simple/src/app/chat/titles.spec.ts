import { DEFAULT_BRANCH_TITLE_PREFIX, DEFAULT_TREE_TITLE } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { branchTitle, lessonTitle, NEW_LESSON_TITLE } from './titles';

describe('lessonTitle', () => {
  it("shows the core's default tree title as a new lesson", () => {
    expect(lessonTitle(DEFAULT_TREE_TITLE)).toBe(NEW_LESSON_TITLE);
    expect(lessonTitle('Why is the sky blue')).toBe('Why is the sky blue');
  });
});

describe('branchTitle', () => {
  it('drops the "Branch:" prefix of a default title, and only that', () => {
    expect(
      branchTitle({
        title: `${DEFAULT_BRANCH_TITLE_PREFIX}Good question! Let us`,
        titleSource: 'default',
      }),
    ).toBe('Good question! Let us');
    // A quote-anchored default title has no prefix.
    expect(branchTitle({ title: 'an agreeable owl hums', titleSource: 'default' })).toBe(
      'an agreeable owl hums',
    );
    // Titles the learner or the tutor chose are shown as they are.
    expect(branchTitle({ title: 'Branch: by design', titleSource: 'user' })).toBe(
      'Branch: by design',
    );
    expect(branchTitle({ title: 'Why the owl hums first', titleSource: 'auto' })).toBe(
      'Why the owl hums first',
    );
  });
});
