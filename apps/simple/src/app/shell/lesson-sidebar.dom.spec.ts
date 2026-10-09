import { TestBed } from '@angular/core/testing';
import { DEFAULT_TREE_TITLE, type TreeSummary } from '@tangent/shared';
import { SidebarState } from '@tangent/web-shared';
import { appProviders, openTree, render, T } from '@tangent/web-shared/testing';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { branchyLesson, learner } from '../learn.testing';
import { LessonStore } from '../state/lesson-store';
import { UiStore } from '../state/ui-store';
import { LessonSidebar } from './lesson-sidebar';

function lesson(id: string, title: string, branchCount = 1): TreeSummary {
  return { id, title, branchCount, messageCount: 3, createdAt: T, updatedAt: T };
}

/** The sidebar over "Light" (t1, `branchyLesson()`, open at `branchId`) and an unnamed lesson (t2). */
async function sidebar(branchId: string | null) {
  await render(LessonSidebar, {
    providers: appProviders({}),
    setup: () => {
      learner();
      const store = TestBed.inject(LessonStore);
      store.trees.set([lesson('t1', 'Light', 4), lesson('t2', DEFAULT_TREE_TITLE)]);
      store.treesLoaded.set(true);
      openTree(store, branchyLesson(), branchId);
    },
  });
  const store = TestBed.inject(LessonStore);
  const go = vi.spyOn(store, 'go').mockImplementation(() => undefined);
  return { store, go, user: userEvent.setup() };
}

const outline = () => screen.getByRole('tree', { name: 'Side questions' });
const row = (name: string) =>
  within(outline()).getByRole('button', { name: new RegExp(`^${name}`) });

describe('Learn: the sidebar', () => {
  const confirm = vi.fn(() => true);
  beforeEach(() => vi.stubGlobal('confirm', confirm));
  afterEach(() => {
    vi.unstubAllGlobals();
    confirm.mockClear();
  });

  it('lists the lessons in the learner’s words, the open one with its side questions nested', async () => {
    await sidebar('deep');
    const nav = screen.getByRole('navigation', { name: 'Lessons' });
    expect(
      within(nav)
        .getByRole('link', { name: /^Light/ })
        .getAttribute('aria-current'),
    ).toBe('true');
    within(nav).getByRole('link', { name: /^New lesson/ });
    expect(
      within(outline())
        .getAllByRole('treeitem')
        .map((li) => li.querySelector('.outline-title')?.textContent?.trim()),
    ).toEqual(['Lesson', 'Why waves', 'Particles', 'Duality']);
    expect(row('Duality').getAttribute('aria-current')).toBe('page');
    expect(row('Particles').closest('.outline-row')?.classList).toContain('in-chain');
    expect(row('Why waves').closest('.outline-row')?.classList).not.toContain('in-chain');
    // Side questions are deleted from the sidebar, but not renamed.
    within(outline()).getByRole('button', { name: 'Delete Particles' });
    expect(within(outline()).queryByRole('button', { name: /^Rename/ })).toBeNull();
  });

  it('opens a side question at its start, and closes the drawer', async () => {
    const s = await sidebar(null);
    TestBed.inject(SidebarState).drawerOpen.set(true);
    await s.user.click(row('Particles'));
    expect(s.go).toHaveBeenLastCalledWith('side', 'u2');
    expect(TestBed.inject(SidebarState).drawerOpen()).toBe(false);
  });

  it('opens the lesson where it continues', async () => {
    const s = await sidebar('deep');
    await s.user.click(row('Lesson'));
    expect(s.go).toHaveBeenLastCalledWith('trunk');
  });

  it('asks before deleting a lesson', async () => {
    const s = await sidebar(null);
    const del = vi.spyOn(s.store, 'deleteTree').mockResolvedValue(true);
    await s.user.click(screen.getByRole('button', { name: 'Delete New lesson' }));
    expect(confirm).toHaveBeenCalledWith(
      'Delete the lesson “New lesson” with all its side questions?',
    );
    expect(del).toHaveBeenCalledWith('t2');
  });

  it('Escape closes the drawer', async () => {
    await sidebar(null);
    const drawer = TestBed.inject(SidebarState).drawerOpen;
    drawer.set(true);
    expect(TestBed.inject(UiStore).closeTop()).toBe(true);
    expect(drawer()).toBe(false);
  });
});
