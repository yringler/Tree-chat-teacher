import { TestBed } from '@angular/core/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../testing';
import { Composer, ComposerController } from './composer';

async function composer(inputs: Record<string, unknown> = {}) {
  const r = await render(Composer, { inputs });
  const out = { send: vi.fn(), stop: vi.fn(), compare: vi.fn() };
  r.component.send.subscribe(out.send);
  r.component.stop.subscribe(out.stop);
  r.component.compare.subscribe(out.compare);
  const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
  return { ...r, ...out, box, user: userEvent.setup() };
}

const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });

describe('Composer', () => {
  it('sends the trimmed text on Enter, and keeps it until the message is in the tree', async () => {
    const c = await composer();
    expect(button('Send').disabled).toBe(true);
    await c.user.type(c.box, '  Why is the sky blue?  ');
    expect(button('Send').disabled).toBe(false);
    await c.user.keyboard('{Enter}');
    expect(c.send).toHaveBeenCalledExactlyOnceWith('Why is the sky blue?');
    // A refused send must not lose it: only the controller's `sent` lets it go.
    expect(c.box.value).toBe('  Why is the sky blue?  ');
    TestBed.inject(ComposerController).sent('any-branch', 'Why is the sky blue?');
    await c.fixture.whenStable();
    expect(c.box.value).toBe('');
  });

  it('Shift+Enter starts a new line; the Send button sends too', async () => {
    const c = await composer({ sendLabel: 'Send message' });
    await c.user.type(c.box, 'Line one{Shift>}{Enter}{/Shift}Line two');
    expect(c.send).not.toHaveBeenCalled();
    expect(c.box.value).toBe('Line one\nLine two');
    await c.user.click(button('Send message'));
    expect(c.send).toHaveBeenCalledWith('Line one\nLine two');
  });

  it('a blank message sends nothing', async () => {
    const c = await composer();
    await c.user.type(c.box, '   {Enter}');
    expect(c.send).not.toHaveBeenCalled();
    expect(button('Send').disabled).toBe(true);
  });

  it('while disabled, neither the box nor Send can be used', async () => {
    const c = await composer({ disabled: true, initial: 'Draft' });
    expect(c.box.disabled).toBe(true);
    expect(button('Send').disabled).toBe(true);
  });

  it('while a reply streams, Stop replaces Send and stops it', async () => {
    const c = await composer({ busy: true, stopLabel: 'Stop generating' });
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    await c.user.click(button('Stop generating'));
    expect(c.stop).toHaveBeenCalledTimes(1);
    await c.user.type(c.box, 'More{Enter}');
    expect(c.send).not.toHaveBeenCalled();
  });

  it('offers Compare beside Send only when asked, for a message typed', async () => {
    const c = await composer();
    expect(screen.queryByRole('button', { name: 'Compare Normal and Max' })).toBeNull();
    await c.set({ canCompare: true });
    expect(button('Compare Normal and Max').disabled).toBe(true);
    await c.user.type(c.box, 'Which is bigger?');
    await c.user.click(button('Compare Normal and Max'));
    expect(c.compare).toHaveBeenCalledWith('Which is bigger?');
    expect(c.send).not.toHaveBeenCalled();
  });

  it('takes back a message that could not be sent, only into an empty box', async () => {
    const c = await composer({ initial: 'Unsent question' });
    await vi.waitFor(() => expect(c.box.value).toBe('Unsent question'));
    await c.user.clear(c.box);
    await c.user.type(c.box, 'Typed since');
    await c.set({ initial: 'Another' });
    expect(c.box.value).toBe('Typed since');
  });

  it('shows no Send button where the host form has its own', async () => {
    await composer({ hideSend: true });
    expect(screen.queryByRole('button')).toBeNull();
  });
});
