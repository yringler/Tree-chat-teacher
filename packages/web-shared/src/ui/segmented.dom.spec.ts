import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../testing';
import { Segmented } from './segmented';

const OPTIONS = [
  { id: 'normal', label: 'Normal', hint: 'Quicker' },
  { id: 'max', label: 'Max' },
];

async function segmented(inputs: Record<string, unknown> = {}) {
  const r = await render(Segmented, {
    inputs: { options: OPTIONS, label: 'Tutor', value: 'normal', ...inputs },
  });
  const changed = vi.fn();
  r.component.changed.subscribe(changed);
  return { ...r, changed, user: userEvent.setup() };
}

describe('Segmented', () => {
  it('is a labelled radiogroup whose current option is checked, with hints as tooltips', async () => {
    await segmented();
    const group = screen.getByRole('radiogroup', { name: 'Tutor' });
    const [normal, max] = screen.getAllByRole('radio');
    expect(group.contains(normal!)).toBe(true);
    expect(normal!.getAttribute('aria-checked')).toBe('true');
    expect(max!.getAttribute('aria-checked')).toBe('false');
    expect(normal!.title).toBe('Quicker');
    expect(max!.title).toBe('Max');
    // One tab stop: the current option.
    expect([normal!.tabIndex, max!.tabIndex]).toEqual([0, -1]);
  });

  it('emits another option when clicked, and nothing for the current one', async () => {
    const s = await segmented();
    await s.user.click(screen.getByRole('radio', { name: 'Normal' }));
    expect(s.changed).not.toHaveBeenCalled();
    await s.user.click(screen.getByRole('radio', { name: 'Max' }));
    expect(s.changed).toHaveBeenCalledExactlyOnceWith('max');
  });

  it('moves with the arrow keys, picking and focusing the next option', async () => {
    const s = await segmented();
    screen.getByRole('radio', { name: 'Normal' }).focus();
    await s.user.keyboard('{ArrowRight}');
    expect(s.changed).toHaveBeenCalledWith('max');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Max' }));
  });

  it('when disabled, says why and picks nothing', async () => {
    const s = await segmented({ disabled: true, description: 'The open pool uses Lite.' });
    const group = screen.getByRole('radiogroup', { name: 'Tutor' });
    const describedBy = group.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)?.textContent).toBe('The open pool uses Lite.');
    for (const radio of screen.getAllByRole<HTMLButtonElement>('radio'))
      expect(radio.disabled).toBe(true);
    screen
      .getByRole('radio', { name: 'Normal' })
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(s.changed).not.toHaveBeenCalled();
  });

  it('as tabs, a tablist whose tabs control their panels', async () => {
    await segmented({ kind: 'tab', controls: 'answers', label: 'Answers' });
    screen.getByRole('tablist', { name: 'Answers' });
    const tab = screen.getByRole('tab', { name: 'Max' });
    expect(tab.getAttribute('aria-selected')).toBe('false');
    expect(tab.getAttribute('aria-controls')).toBe('answers-max');
    expect(tab.id).toBe('answers-tab-max');
    expect(screen.getByRole('tab', { name: 'Normal' }).getAttribute('aria-selected')).toBe('true');
  });
});
