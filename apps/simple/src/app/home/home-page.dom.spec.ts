import { TestBed } from '@angular/core/testing';
import { POOL_FUNDING_TEXT, type TreeSummary } from '@tangent/shared';
import { BillingClient } from '@tangent/web-shared';
import { appProviders, provider, render, T } from '@tangent/web-shared/testing';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { learner, NOT_A_MEMBER, POOL_ON } from '../learn.testing';
import { LessonStore } from '../state/lesson-store';
import { HomePage } from './home-page';

const LEARN = provider({
  label: 'Tangent',
  models: [
    { id: 'normal-model', label: 'Normal', tier: 'normal' },
    { id: 'max-model', label: 'Max', tier: 'max', usageFactor: 14 },
  ],
  defaultModel: 'normal-model',
});

function lesson(id: string, title: string, branchCount = 1): TreeSummary {
  return { id, title, branchCount, messageCount: 2, createdAt: T, updatedAt: T };
}

/** Learn's home page over the lessons "Light" (two side questions) and "Tides". */
async function home(facts: Parameters<typeof learner>[0] = {}, lessons = true) {
  const r = await render(HomePage, {
    providers: [...appProviders({}), { provide: BillingClient, useValue: {} }],
    setup: () => {
      learner(facts);
      const store = TestBed.inject(LessonStore);
      store.providers.set([LEARN]);
      store.trees.set(lessons ? [lesson('t1', 'Light', 3), lesson('t2', 'Tides')] : []);
      store.treesLoaded.set(true);
    },
  });
  return { ...r, store: TestBed.inject(LessonStore), user: userEvent.setup() };
}

const lessonList = () => screen.getByRole('region', { name: 'Your lessons' });

describe('Learn: the home page', () => {
  beforeEach(() =>
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    ),
  );
  afterEach(() => vi.unstubAllGlobals());

  it('starts a lesson on the topic typed, on the tutor picked', async () => {
    const h = await home();
    const start = vi.spyOn(h.store, 'startLesson').mockResolvedValue(true);
    await h.user.type(screen.getByRole('textbox', { name: 'Topic or first question' }), 'Tides');
    await h.user.click(screen.getByRole('radio', { name: 'Max' }));
    expect(screen.getByRole('status').textContent).toBe('Max uses about 14× as much as Normal.');
    await h.user.click(screen.getByRole('button', { name: 'Start lesson' }));
    expect(start).toHaveBeenCalledWith('max-model', 'Tides');
  });

  it('while the own key is locked, the ways out stand where Start was', async () => {
    await home({ membership: NOT_A_MEMBER, chosen: 'own-key' });
    expect(screen.queryByRole('button', { name: 'Start lesson' })).toBeNull();
    screen.getByRole('region', { name: 'Replies on your own key need a membership.' });
  });

  it('on the open pool: the tutor switch is locked to the pool’s model and says so in text', async () => {
    await home({ pool: POOL_ON, chosen: 'pool' });
    expect(screen.queryByRole('radiogroup', { name: 'Tutor' })).toBeNull();
    expect(screen.getByText(/^The open pool uses Lite/)).toBeTruthy();
  });

  it('while the pool is on: its meter, who provides it, and how it works', async () => {
    await home({ pool: POOL_ON });
    const pool = screen.getByRole('region', { name: 'Open pool' });
    within(pool).getByRole('group', { name: 'Open pool' });
    expect(pool.textContent).toContain(`${POOL_FUNDING_TEXT} Any signed-in learner can use it`);
    expect(within(pool).getByRole('link', { name: 'How it works' }).getAttribute('href')).toBe(
      '/pool',
    );
  });

  it('each lesson links to it, with Export then Delete; Import is in the heading', async () => {
    const h = await home();
    const rows = within(lessonList()).getAllByRole('listitem');
    expect(within(rows[0]!).getByRole('link').getAttribute('href')).toBe('/t/t1');
    expect(rows[0]!.textContent).toContain('2 side questions');
    const buttons = within(rows[0]!)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    expect(buttons).toEqual(['Export Light', 'Delete Light']);
    const exportLesson = vi.spyOn(h.store, 'exportLesson').mockResolvedValue(true);
    await h.user.click(within(rows[0]!).getByRole('button', { name: 'Export Light' }));
    expect(exportLesson).toHaveBeenCalledWith('t1');
    within(lessonList()).getByRole('button', { name: 'Import' });
  });

  it('one export at a time', async () => {
    const h = await home();
    h.store.exportingId.set('t1');
    await h.fixture.whenStable();
    for (const name of ['Export Light', 'Export Tides'])
      expect(screen.getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(true);
  });

  it('Delete asks, then deletes the lesson', async () => {
    const h = await home();
    const remove = vi.spyOn(h.store, 'deleteTree').mockResolvedValue(true);
    await h.user.click(screen.getByRole('button', { name: 'Delete Tides' }));
    expect(confirm).toHaveBeenCalledWith('Delete the lesson “Tides” with all its side questions?');
    expect(remove).toHaveBeenCalledWith('t2');
  });

  it('with no lessons yet, says how to get one', async () => {
    await home({}, false);
    expect(
      within(lessonList()).getByText('No lessons yet. Start one above, or import a backup.'),
    ).toBeTruthy();
  });

  it('Import takes a JSON backup and hands it to the store, one at a time', async () => {
    const h = await home();
    const importLesson = vi.spyOn(h.store, 'importLesson').mockResolvedValue(true);
    const input = screen.getByLabelText<HTMLInputElement>('Backup file to import');
    expect(input.accept).toBe('application/json,.json');
    const file = new File(['{}'], 'light.tangent.json', { type: 'application/json' });
    await h.user.upload(input, file);
    expect(importLesson).toHaveBeenCalledWith(file);
    h.store.importing.set(true);
    await h.fixture.whenStable();
    const button = within(lessonList()).getByRole<HTMLButtonElement>('button', {
      name: 'Importing…',
    });
    expect(button.disabled).toBe(true);
  });
});
