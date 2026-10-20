import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../testing';
import { SelectionAsk } from './selection-ask';

async function ask(inputs: Record<string, unknown> = {}) {
  const r = await render(SelectionAsk, { inputs });
  const out = { ask: vi.fn(), openOptions: vi.fn() };
  r.component.ask.subscribe(out.ask);
  r.component.openOptions.subscribe(out.openOptions);
  return { ...r, ...out, user: userEvent.setup() };
}

describe('SelectionAsk', () => {
  it('asks about the selection; a caret joined to it only with options', async () => {
    const a = await ask();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    await a.user.click(screen.getByRole('button', { name: 'Ask about this' }));
    expect(a.ask).toHaveBeenCalledTimes(1);
    await a.set({ options: 'Ask about this with options: context, model, variants…' });
    const caret = screen.getByRole('button', { name: 'Ask about this with options…' });
    expect(screen.getByRole('button', { name: 'Ask about this' }).nextElementSibling).toBe(caret);
    expect(caret.title).toBe('Ask about this with options: context, model, variants…');
    expect(caret.getAttribute('aria-haspopup')).toBe('dialog');
    await a.user.click(caret);
    expect(a.openOptions).toHaveBeenCalledTimes(1);
    expect(a.ask).toHaveBeenCalledTimes(1);
  });

  it('pressing either button keeps the selection it acts on', async () => {
    await ask({ options: 'Options' });
    for (const button of screen.getAllByRole('button')) {
      const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      button.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(true);
    }
  });

  it('while busy, neither button works', async () => {
    await ask({ options: 'Options', busy: true });
    for (const button of screen.getAllByRole<HTMLButtonElement>('button'))
      expect(button.disabled).toBe(true);
  });
});
