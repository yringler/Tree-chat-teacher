import {
  DEFAULT_BRANCH_TITLE_PREFIX,
  DEFAULT_TREE_TITLE,
  MAIN_THREAD_LABEL,
} from '@tangent/shared';
import { branch } from '@tangent/web-shared/testing';
import { describe, expect, it } from 'vitest';
import { branchTitle, lessonTitle, NEW_LESSON_TITLE, threadTitle } from './titles';

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

describe('threadTitle', () => {
  it('names the main thread "Main thread" and tangents in Learn’s words', () => {
    const trunk = branch('trunk', { title: 'Light' });
    const side = branch('side', {
      parentBranchId: 'trunk',
      title: `${DEFAULT_BRANCH_TITLE_PREFIX}Why waves`,
    });
    expect([trunk, side].map(threadTitle)).toEqual([MAIN_THREAD_LABEL, 'Why waves']);
  });
});
