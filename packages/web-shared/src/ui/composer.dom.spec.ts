import { TestBed } from '@angular/core/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../testing';
import { Composer, ComposerController, type ComposerAction } from './composer';

async function composer(inputs: Record<string, unknown> = {}) {
  const r = await render(Composer, { inputs });
  const out = { send: vi.fn(), stop: vi.fn(), compare: vi.fn(), act: vi.fn() };
  r.component.send.subscribe(out.send);
  r.component.stop.subscribe(out.stop);
  r.component.compare.subscribe(out.compare);
  r.component.act.subscribe(out.act);
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

  it('Send carries its hint as a tooltip and description', async () => {
    await composer({ sendTitle: 'Next: keeps it moving.' });
    expect(button('Send').title).toBe('Next: keeps it moving.');
    expect(button('Send').getAttribute('aria-description')).toBe('Next: keeps it moving.');
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

  describe('with actions in place of Send', () => {
    const actions: readonly ComposerAction[] = [
      { id: 'tangent', label: 'Tangent ↳', title: 'Explore on the side', primary: true },
      {
        id: 'next',
        label: 'Next ➜',
        icon: 'next',
        title: 'Keeps the lesson moving',
        primary: false,
      },
    ];

    it('shows one button per action, marked for the walkthrough, and no Send', async () => {
      await composer({ actions });
      expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
      const tangent = button('Tangent ↳');
      const next = button('Next ➜');
      expect(tangent.dataset['action']).toBe('tangent');
      expect(next.dataset['action']).toBe('next');
      expect(tangent.classList).toContain('is-primary');
      expect(next.classList).not.toContain('is-primary');
      expect(tangent.title).toBe('Explore on the side');
      expect(next.getAttribute('aria-description')).toBe('Keeps the lesson moving');
      expect(tangent.disabled).toBe(true);
    });

    it('Enter fires the first action, Ctrl or Cmd+Enter the second', async () => {
      const c = await composer({ actions });
      await c.user.type(c.box, ' What is a limit? {Enter}');
      expect(c.act).toHaveBeenLastCalledWith({ id: 'tangent', text: 'What is a limit?' });
      await c.user.keyboard('{Control>}{Enter}{/Control}');
      expect(c.act).toHaveBeenLastCalledWith({ id: 'next', text: 'What is a limit?' });
      await c.user.keyboard('{Meta>}{Enter}{/Meta}');
      expect(c.act).toHaveBeenLastCalledWith({ id: 'next', text: 'What is a limit?' });
      expect(c.act).toHaveBeenCalledTimes(3);
      expect(c.send).not.toHaveBeenCalled();
      // The text stays until the message is in the tree, as with Send.
      expect(c.box.value).toBe(' What is a limit? ');
    });

    it('a click fires its action', async () => {
      const c = await composer({ actions });
      await c.user.type(c.box, 'Go on');
      await c.user.click(button('Next ➜'));
      expect(c.act).toHaveBeenCalledExactlyOnceWith({ id: 'next', text: 'Go on' });
      await c.user.click(button('Tangent ↳'));
      expect(c.act).toHaveBeenLastCalledWith({ id: 'tangent', text: 'Go on' });
    });

    it('with one action, Ctrl+Enter fires it too', async () => {
      const c = await composer({ actions: actions.slice(0, 1) });
      await c.user.type(c.box, 'Why?');
      await c.user.keyboard('{Control>}{Enter}{/Control}');
      expect(c.act).toHaveBeenCalledExactlyOnceWith({ id: 'tangent', text: 'Why?' });
    });

    it('while a reply streams, Stop replaces them and Enter fires nothing', async () => {
      const c = await composer({ actions, busy: true });
      expect(screen.queryByRole('button', { name: 'Tangent ↳' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Next ➜' })).toBeNull();
      await c.user.type(c.box, 'More{Enter}');
      expect(c.act).not.toHaveBeenCalled();
      await c.user.click(button('Stop the reply'));
      expect(c.stop).toHaveBeenCalledTimes(1);
    });

    it('a blank or disabled box fires nothing', async () => {
      const c = await composer({ actions });
      await c.user.type(c.box, '   {Enter}');
      await c.set({ disabled: true });
      await c.user.click(button('Next ➜'));
      expect(c.act).not.toHaveBeenCalled();
    });

    it('offers Compare beside them when asked, and Enter still fires an action', async () => {
      const c = await composer({ actions, canCompare: true });
      expect(button('Compare Normal and Max').disabled).toBe(true);
      await c.user.type(c.box, 'Which is bigger?');
      await c.user.click(button('Compare Normal and Max'));
      expect(c.compare).toHaveBeenCalledExactlyOnceWith('Which is bigger?');
      expect(c.act).not.toHaveBeenCalled();
      await c.user.type(c.box, '{Enter}');
      expect(c.act).toHaveBeenCalledExactlyOnceWith({ id: 'tangent', text: 'Which is bigger?' });
      expect(c.compare).toHaveBeenCalledTimes(1);
    });

    it('without actions, Enter and Ctrl+Enter still send', async () => {
      const c = await composer();
      await c.user.type(c.box, 'Plain{Enter}');
      await c.user.keyboard('{Control>}{Enter}{/Control}');
      expect(c.send).toHaveBeenCalledTimes(2);
      expect(c.act).not.toHaveBeenCalled();
    });
  });
});
