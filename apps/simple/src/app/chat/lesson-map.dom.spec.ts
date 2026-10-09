import { TestBed } from '@angular/core/testing';
import { appProviders, openTree, render } from '@tangent/web-shared/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { branchyLesson, learner } from '../learn.testing';
import { LessonStore } from '../state/lesson-store';
import { UiStore } from '../state/ui-store';
import { LessonMap } from './lesson-map';

/** The map open over `branchyLesson()` at `branchId`. */
async function map(branchId: string | null) {
  await render(LessonMap, {
    providers: appProviders({}),
    setup: () => {
      learner();
      openTree(TestBed.inject(LessonStore), branchyLesson(), branchId);
      TestBed.inject(UiStore).dialogs.open({ kind: 'map' });
    },
  });
  const store = TestBed.inject(LessonStore);
  const go = vi.spyOn(store, 'go').mockImplementation(() => undefined);
  return { store, go, ui: TestBed.inject(UiStore), user: userEvent.setup() };
}

const row = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

describe('Learn: the lesson map', () => {
  it('lists the lesson and its side questions, nested, the open one marked', async () => {
    await map('deep');
    const rows = screen.getAllByRole('button').filter((b) => b.closest('.lesson-map'));
    expect(rows.map((b) => b.querySelector('.lesson-map-title')?.textContent?.trim())).toEqual([
      'Lesson',
      'Why waves',
      'Particles',
      'Duality',
    ]);
    expect(row('Duality').getAttribute('aria-current')).toBe('page');
    expect(row('Duality').closest('li')?.style.getPropertyValue('--depth')).toBe('2');
    expect(row('Particles').classList).toContain('in-chain');
    expect(row('Why waves').classList).not.toContain('in-chain');
    expect(row('Particles').textContent).toContain('2 messages');
    expect(row('Why waves').textContent).toContain('1 message');
  });

  it('opens a side question at its start and closes', async () => {
    const m = await map(null);
    await m.user.click(row('Particles'));
    expect(m.go).toHaveBeenLastCalledWith('side', 'u2');
    expect(m.ui.dialogs.list()).toEqual([]);
  });

  it('opens the lesson where it continues', async () => {
    const m = await map('deep');
    await m.user.click(row('Lesson'));
    expect(m.go).toHaveBeenLastCalledWith('trunk');
  });
});
