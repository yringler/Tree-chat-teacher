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

/** Option `name`'s button. */
const option = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });

describe('Segmented', () => {
  it('is a labelled toolbar of toggle buttons, the current one pressed, with hints as tooltips', async () => {
    await segmented();
    const group = screen.getByRole('toolbar', { name: 'Tutor' });
    const normal = screen.getByRole('button', { name: 'Normal', pressed: true });
    const max = screen.getByRole('button', { name: 'Max', pressed: false });
    expect(group.contains(normal)).toBe(true);
    expect(normal.title).toBe('Quicker');
    expect(max.title).toBe('Max');
    // One tab stop: the current option.
    expect([normal.tabIndex, max.tabIndex]).toEqual([0, -1]);
  });

  it('emits another option when clicked, and nothing for the current one', async () => {
    const s = await segmented();
    await s.user.click(option('Normal'));
    expect(s.changed).not.toHaveBeenCalled();
    await s.user.click(option('Max'));
    expect(s.changed).toHaveBeenCalledExactlyOnceWith('max');
  });

  it('the arrow keys, Home and End only move the focus; Enter, Space or a click picks', async () => {
    const s = await segmented();
    const normal = option('Normal');
    const max = option('Max');
    normal.focus();
    await s.user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(max);
    expect(s.changed).not.toHaveBeenCalled();
    await s.user.keyboard('{Enter}');
    expect(s.changed).toHaveBeenCalledExactlyOnceWith('max');
    await s.user.keyboard('{Home}');
    expect(document.activeElement).toBe(normal);
    await s.user.keyboard('{End}');
    expect(document.activeElement).toBe(max);
    await s.user.keyboard(' ');
    expect(s.changed).toHaveBeenCalledTimes(2);
    expect(s.changed).toHaveBeenLastCalledWith('max');
  });

  it('the tab stop follows the focus, and goes back to the current option when the focus leaves', async () => {
    const s = await segmented();
    const normal = option('Normal');
    const max = option('Max');
    normal.focus();
    await s.user.keyboard('{ArrowRight}');
    await s.fixture.whenStable();
    expect([normal.tabIndex, max.tabIndex]).toEqual([-1, 0]);
    max.blur();
    await s.fixture.whenStable();
    expect([normal.tabIndex, max.tabIndex]).toEqual([0, -1]);
  });

  it('when disabled, says why and picks nothing', async () => {
    const s = await segmented({ disabled: true, description: 'The open pool uses Normal.' });
    const group = screen.getByRole('toolbar', { name: 'Tutor' });
    const describedBy = group.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)?.textContent).toBe('The open pool uses Normal.');
    for (const button of screen.getAllByRole<HTMLButtonElement>('button'))
      expect(button.disabled).toBe(true);
    option('Normal').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
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
    expect(tab.hasAttribute('aria-pressed')).toBe(false);
  });

  it('as tabs, the arrow keys pick as they move, focusing the tab picked', async () => {
    const s = await segmented({ kind: 'tab', controls: 'answers', label: 'Answers' });
    screen.getByRole('tab', { name: 'Normal' }).focus();
    await s.user.keyboard('{ArrowRight}');
    expect(s.changed).toHaveBeenCalledWith('max');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Max' }));
  });
});
