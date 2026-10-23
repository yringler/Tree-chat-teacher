import { TestBed } from '@angular/core/testing';
import { HELP_RULE } from '@tangent/shared';
import { AuthService, Walkthrough } from '@tangent/web-shared';
import { appProviders, render } from '@tangent/web-shared/testing';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { learner } from '../learn.testing';
import { LessonStore } from '../state/lesson-store';
import { storedDraft, storeDraft, type UnsentDraft } from '../state/unsent-draft';
import { UiStore } from '../state/ui-store';
import { AppHeader } from './app-header';
import { HelpDialog } from './help-dialog';

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

describe('Learn header: How tangents work', () => {
  it('the ? button opens the help', async () => {
    await render(AppHeader, {
      providers: [...appProviders({}), { provide: AuthService, useValue: {} }],
      setup: () => void learner(),
    });
    const help = screen.getByRole('button', { name: 'How tangents work' });
    expect(help.title).toBe('How tangents work');
    await userEvent.setup().click(help);
    expect(TestBed.inject(UiStore).dialogs.list()).toEqual([{ kind: 'help' }]);
  });

  it('the help replays the walkthrough, or gives way to the keyboard shortcuts', async () => {
    const replay = vi.fn();
    await render(HelpDialog, {
      providers: [...appProviders({}), { provide: Walkthrough, useValue: { replay } }],
      setup: () => TestBed.inject(UiStore).dialogs.open({ kind: 'help' }),
    });
    const ui = TestBed.inject(UiStore);
    const user = userEvent.setup();
    const dialog = screen.getByRole('dialog', { name: 'How tangents work' });
    expect(dialog.textContent).toContain(HELP_RULE);
    await user.click(within(dialog).getByRole('button', { name: 'Replay the walkthrough' }));
    expect(replay).toHaveBeenCalledOnce();
    expect(ui.dialogs.list()).toEqual([]);

    ui.dialogs.open({ kind: 'help' });
    await user.click(within(dialog).getByRole('button', { name: 'Keyboard shortcuts' }));
    expect(ui.dialogs.list()).toEqual([{ kind: 'shortcuts' }]);
  });
});

describe('Learn header: Advanced settings', () => {
  it('the account menu opens them', async () => {
    await render(AppHeader, {
      providers: [...appProviders({}), { provide: AuthService, useValue: {} }],
      setup: () => void learner(),
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('menuitem', { name: 'Advanced settings' }));
    expect(TestBed.inject(UiStore).dialogs.list()).toEqual([{ kind: 'advanced-settings' }]);
    expect(TestBed.inject(UiStore).menuOpen()).toBe(false);
  });
});
