import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../testing';
import { SelectionAsk } from './selection-ask';

async function ask(inputs: Record<string, unknown> = {}) {
  const r = await render(SelectionAsk, { inputs });
  const out = { ask: vi.fn(), more: vi.fn() };
  r.component.ask.subscribe(out.ask);
  r.component.more.subscribe(out.more);
  return { ...r, ...out, user: userEvent.setup() };
}

describe('SelectionAsk', () => {
  it('asks about the selection; a gear only when it is labelled', async () => {
    const a = await ask();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    await a.user.click(screen.getByRole('button', { name: 'Ask about this' }));
    expect(a.ask).toHaveBeenCalledTimes(1);
    await a.set({ moreLabel: 'More: Branch from here with this quote…' });
    await a.user.click(
      screen.getByRole('button', { name: 'More: Branch from here with this quote…' }),
    );
    expect(a.more).toHaveBeenCalledTimes(1);
  });

  it('pressing either button keeps the selection it acts on', async () => {
    await ask({ moreLabel: 'More' });
    for (const button of screen.getAllByRole('button')) {
      const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      button.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(true);
    }
  });

  it('while busy, neither button works', async () => {
    await ask({ moreLabel: 'More', busy: true });
    for (const button of screen.getAllByRole<HTMLButtonElement>('button'))
      expect(button.disabled).toBe(true);
  });
});
