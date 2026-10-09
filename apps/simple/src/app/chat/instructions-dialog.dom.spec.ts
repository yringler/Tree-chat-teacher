import { TestBed } from '@angular/core/testing';
import type { Tree } from '@tangent/shared';
import { appProviders, detail, openTree, render } from '@tangent/web-shared/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LessonStore } from '../state/lesson-store';
import { UiStore } from '../state/ui-store';
import { InstructionsDialog } from './instructions-dialog';

/** The dialog over the lesson `t1`, whose learner instructions are `learnerInstructions`. */
async function dialog(learnerInstructions: string | null) {
  const api = {
    updateTree: vi.fn(async (_id: string, req: Partial<Tree>) => ({
      ...detail().tree,
      ...req,
    })),
  };
  await render(InstructionsDialog, {
    providers: appProviders(api),
    setup: () => {
      openTree(
        TestBed.inject(LessonStore),
        detail([], undefined, [], { systemPrompt: 'TUTOR', learnerInstructions }),
      );
      TestBed.inject(UiStore).dialogs.open({ kind: 'instructions' });
    },
  });
  const box = await screen.findByRole<HTMLTextAreaElement>('textbox');
  return { api, box, ui: TestBed.inject(UiStore), user: userEvent.setup() };
}

describe('Learn: the lesson’s own instructions', () => {
  it('starts empty, never showing the tutor prompt', async () => {
    const d = await dialog(null);
    expect(d.box.value).toBe('');
  });

  it.each([null, 'Answer in French.'])(
    'leaves the lesson alone when saved unchanged (%#)',
    async (stored) => {
      const d = await dialog(stored);
      await d.user.click(screen.getByRole('button', { name: 'Save' }));
      expect(d.api.updateTree).not.toHaveBeenCalled();
      expect(d.ui.dialogs.isOpen('instructions')).toBe(false);
    },
  );

  it('saves what the learner writes as the lesson’s learner instructions', async () => {
    const d = await dialog(null);
    await d.user.type(d.box, 'Answer in French.');
    await d.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(d.api.updateTree).toHaveBeenCalledWith('t1', {
      learnerInstructions: 'Answer in French.',
    });
    expect(d.ui.dialogs.isOpen('instructions')).toBe(false);
  });

  it('shows the learner’s own text, and clearing it saves none', async () => {
    const d = await dialog('Answer in French.');
    expect(d.box.value).toBe('Answer in French.');
    await d.user.clear(d.box);
    await d.user.type(d.box, '   ');
    await d.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(d.api.updateTree).toHaveBeenCalledWith('t1', { learnerInstructions: null });
  });
});
