import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '../testing';
import { Compare, type CompareCandidate } from './compare';

const normal: CompareCandidate = {
  id: 'normal',
  label: 'Normal',
  state: 'done',
  html: '<p>Blue light scatters more.</p>',
};
const max: CompareCandidate = {
  id: 'max',
  label: 'Max',
  sublabel: 'deeper',
  state: 'streaming',
  html: '<p>Rayleigh…</p>',
};

/** The screen is `wide` (at least 900px: side by side) or not (tabs). */
async function compare(inputs: Record<string, unknown> = {}, wide = false) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: wide && q === '(min-width: 900px)' }));
  const r = await render(Compare, {
    inputs: { candidates: [normal, max], question: 'Why is the sky blue?', ...inputs },
  });
  const picked = vi.fn();
  r.component.picked.subscribe(picked);
  return { ...r, picked, user: userEvent.setup() };
}

describe('Compare', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the question and the note, and each answer as typeset HTML', async () => {
    await compare({ note: 'Uses both models. Only the answer you pick is kept.' });
    expect(screen.getByText('Why is the sky blue?')).toBeTruthy();
    expect(screen.getByText('Uses both models. Only the answer you pick is kept.')).toBeTruthy();
    const pane = screen.getByRole('tabpanel', { name: 'Normal' });
    expect(within(pane).getByText('Blue light scatters more.').tagName).toBe('P');
  });

  it('on a narrow screen, switches answers with tabs controlling their panels', async () => {
    const c = await compare();
    const tabs = screen.getAllByRole('tab');
    // A • marks an answer still being written.
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(['Normal', 'Max •']);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    const panel = document.getElementById(tabs[1]!.getAttribute('aria-controls')!)!;
    expect(panel.getAttribute('data-active')).toBe('false');
    await c.user.click(tabs[1]!);
    expect(panel.getAttribute('data-active')).toBe('true');
    expect(within(panel).getByText('Rayleigh…').parentElement?.getAttribute('aria-live')).toBe(
      'polite',
    );
  });

  it('side by side (at least 900px), each answer is a region of its own', async () => {
    await compare({}, true);
    expect(screen.queryAllByRole('tabpanel')).toEqual([]);
    screen.getByRole('region', { name: 'Normal' });
    screen.getByRole('region', { name: 'Max' });
  });

  it('goes back to tabs when the window narrows', async () => {
    const c = await compare({}, true);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    window.dispatchEvent(new Event('resize'));
    await c.fixture.whenStable();
    expect(screen.queryAllByRole('region')).toEqual([]);
    screen.getByRole('tabpanel', { name: 'Normal' });
  });

  it('a finished answer can be picked; one still writing, failed, or while a pick saves cannot', async () => {
    const c = await compare({
      candidates: [normal, max, { ...max, id: 'gone', label: 'Gone', state: 'error', error: '' }],
      pickLabel: 'Keep this answer',
    });
    const [keepNormal, keepMax, keepGone] = screen.getAllByRole<HTMLButtonElement>('button', {
      name: 'Keep this answer',
    });
    expect([keepNormal!.disabled, keepMax!.disabled, keepGone!.disabled]).toEqual([
      false,
      true,
      true,
    ]);
    // Says what went wrong, else how it is going.
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getAllByText('Writing…')).toHaveLength(1);
    await c.user.click(keepNormal!);
    expect(c.picked).toHaveBeenCalledWith('normal');
    await c.set({ busy: true });
    expect(keepNormal!.disabled).toBe(true);
  });

  it('heads each answer with its latest status, else what it is doing', async () => {
    await compare({
      candidates: [
        { ...max, status: 'Searching the web…' },
        { ...normal, id: 'n2', state: 'pending', html: '' },
      ],
    });
    expect(screen.getByText('Searching the web…')).toBeTruthy();
    expect(screen.getByText('Waiting…')).toBeTruthy();
    expect(screen.queryByText('Writing…')).toBeNull();
  });
});
