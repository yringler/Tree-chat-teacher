import { TestBed } from '@angular/core/testing';
import { compareUsageNote, type CandidateEvent, type CandidateRequest } from '@tangent/shared';
import {
  appProviders,
  branch,
  detail,
  node,
  openTree,
  provider,
  render,
  T,
} from '@tangent/web-shared/testing';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { learner } from '../learn.testing';
import { LessonStore } from '../state/lesson-store';
import { UiStore } from '../state/ui-store';
import { CompareDialog } from './compare-dialog';

/** A finished candidate answer from `model`. */
function answer(model: string): Response {
  const events: CandidateEvent[] = [
    { type: 'delta', text: `Answer from ${model}.` },
    {
      type: 'done',
      candidateId: `cand-${model}`,
      providerId: 'openrouter',
      funding: 'credit',
      model,
      usage: null,
      sources: null,
      expiresAt: T,
    },
  ];
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

async function compare() {
  const api = {
    streamCandidate: vi.fn(async (_b: string, req: CandidateRequest, _s: AbortSignal) =>
      answer(req.model),
    ),
  };
  const r = await render(CompareDialog, {
    providers: appProviders(api),
    setup: () => {
      learner();
      const store = TestBed.inject(LessonStore);
      store.providers.set([
        provider({
          models: [
            { id: 'normal-model', label: 'Normal', tier: 'normal' },
            { id: 'max-model', label: 'Max', tier: 'max', usageFactor: 14 },
          ],
        }),
      ]);
      openTree(store, detail([node('a1', { content: 'A wave.' })], [branch('trunk')]));
      TestBed.inject(UiStore).dialogs.open({ kind: 'compare', branchId: 'trunk', content: 'Why?' });
    },
    inputs: { branchId: 'trunk', content: 'Why is the sky blue?' },
  });
  return {
    ...r,
    api,
    store: TestBed.inject(LessonStore),
    ui: TestBed.inject(UiStore),
    user: userEvent.setup(),
  };
}

describe('Learn: Compare answers', () => {
  it('asks Normal and Max, says it uses both and keeps only the one picked', async () => {
    const c = await compare();
    const dialog = screen.getByRole('dialog', { name: 'Compare answers' });
    expect(within(dialog).getByText('Why is the sky blue?')).toBeTruthy();
    expect(within(dialog).getByText(compareUsageNote(14))).toBeTruthy();
    expect(dialog.textContent).toContain(
      'Closing discards both answers; your question stays in the box.',
    );
    expect(c.api.streamCandidate.mock.calls.map(([, req]) => req.model)).toEqual([
      'normal-model',
      'max-model',
    ]);
    await vi.waitFor(() => expect(within(dialog).getByText('Answer from max-model.')).toBeTruthy());
  });

  it('picking an answer keeps it in the lesson and closes', async () => {
    const c = await compare();
    const commit = vi.spyOn(c.store, 'commitCompare').mockResolvedValue('kept');
    const [keepNormal] = await vi.waitFor(() => {
      const buttons = screen.getAllByRole<HTMLButtonElement>('button', { name: 'Use this answer' });
      expect(buttons.every((b) => !b.disabled)).toBe(true);
      return buttons;
    });
    await c.user.click(keepNormal!);
    expect(commit).toHaveBeenCalledWith(expect.anything(), 'normal');
    expect(c.ui.dialogs.isOpen('compare')).toBe(false);
  });
});
