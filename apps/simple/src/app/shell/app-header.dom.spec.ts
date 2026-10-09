import { TestBed } from '@angular/core/testing';
import { AuthService } from '@tangent/web-shared';
import { appProviders, render } from '@tangent/web-shared/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { learner } from '../learn.testing';
import { LessonStore } from '../state/lesson-store';
import { storedDraft, storeDraft, type UnsentDraft } from '../state/unsent-draft';
import { AppHeader } from './app-header';

describe('Learn header: signing out', () => {
  it('forgets the message left unsent before the session ends', async () => {
    const draft: UnsentDraft = { treeId: 't1', branchId: 'b1', text: 'Why is the sky blue?' };
    let atSignOut: { kept: UnsentDraft | null; stored: UnsentDraft | null } | null = null;
    const signOut = vi.fn(async () => {
      atSignOut = { kept: TestBed.inject(LessonStore).unsentDraft(), stored: storedDraft('1') };
    });
    await render(AppHeader, {
      providers: [...appProviders({}), { provide: AuthService, useValue: { signOut } }],
      setup: () => {
        learner();
        storeDraft(draft, '1');
        TestBed.inject(LessonStore).unsentDraft.set(draft);
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledOnce();
    expect(atSignOut).toEqual({ kept: null, stored: null });
  });
});
