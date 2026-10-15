import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../testing';
import { JumpToEnd } from './jump-to-end';

async function jumpButton(shown: boolean) {
  const r = await render(JumpToEnd, { inputs: { shown } });
  const jump = vi.fn();
  r.component.jump.subscribe(jump);
  return { ...r, jump, button: screen.getByRole('button', { name: 'Jump to the end' }) };
}

describe('JumpToEnd', () => {
  it('says where it goes, and goes there', async () => {
    const j = await jumpButton(true);
    expect(j.button.title).toBe('Jump to the end');
    expect(j.button.hasAttribute('inert')).toBe(false);
    await userEvent.setup().click(j.button);
    expect(j.jump).toHaveBeenCalledTimes(1);
  });

  it('hidden, it is inert: no clicks, no focus, nothing read out', async () => {
    const j = await jumpButton(false);
    expect(j.button.hasAttribute('inert')).toBe(true);
    expect(j.button.classList).not.toContain('is-shown');
    await j.set({ shown: true });
    expect(j.button.hasAttribute('inert')).toBe(false);
    expect(j.button.classList).toContain('is-shown');
  });

  it('a press leaves the focus where it was, so the message box keeps it', async () => {
    const j = await jumpButton(true);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    j.button.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });
});
