import { TestBed } from '@angular/core/testing';
import { DEFAULT_SYSTEM_PROMPT, type SettingsResponse, type Tree } from '@tangent/shared';
import { appProviders, detail, openTree, render } from '@tangent/web-shared/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LessonStore } from '../state/lesson-store';
import { UiStore } from '../state/ui-store';
import { InstructionsDialog } from './instructions-dialog';

const SETTINGS: SettingsResponse = { systemPrompt: null, defaultSystemPrompt: 'TUTOR' };

/** The dialog over the lesson `t1`, whose stored prompt is `systemPrompt`. */
async function dialog(systemPrompt: string | null) {
  const api = {
    settings: vi.fn(async () => SETTINGS),
    updateTree: vi.fn(async (_id: string, req: Partial<Tree>) => ({
      ...detail().tree,
      ...req,
    })),
  };
  await render(InstructionsDialog, {
    providers: appProviders(api),
    setup: () => {
      openTree(TestBed.inject(LessonStore), detail([], undefined, [], { systemPrompt }));
      TestBed.inject(UiStore).dialogs.open({ kind: 'instructions' });
    },
  });
  const box = await screen.findByRole<HTMLTextAreaElement>('textbox');
  await vi.waitFor(() => expect(box.disabled).toBe(false));
  return { api, box, ui: TestBed.inject(UiStore), user: userEvent.setup() };
}

describe('Learn: the lesson’s own instructions', () => {
  it.each([null, 'TUTOR', DEFAULT_SYSTEM_PROMPT])(
    'starts empty over a built-in prompt (%#)',
    async (stored) => {
      const d = await dialog(stored);
      expect(d.box.value).toBe('');
    },
  );

  it('saves what the learner writes as the lesson’s prompt', async () => {
    const d = await dialog('TUTOR');
    await d.user.type(d.box, 'Answer in French.');
    await d.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(d.api.updateTree).toHaveBeenCalledWith('t1', { systemPrompt: 'Answer in French.' });
    expect(d.ui.dialogs.isOpen('instructions')).toBe(false);
  });

  it('shows the learner’s own text, and clearing it puts the tutor prompt back', async () => {
    const d = await dialog('Answer in French.');
    expect(d.box.value).toBe('Answer in French.');
    await d.user.clear(d.box);
    await d.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(d.api.updateTree).toHaveBeenCalledWith('t1', { systemPrompt: 'TUTOR' });
  });
});
