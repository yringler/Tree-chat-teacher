import { TestBed } from '@angular/core/testing';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../testing';
import { Composer, ComposerController, type ComposerAction } from './composer';

async function composer(inputs: Record<string, unknown> = {}) {
  const r = await render(Composer, { inputs });
  const out = {
    send: vi.fn(),
    stop: vi.fn(),
    compare: vi.fn(),
    act: vi.fn(),
    openOptions: vi.fn(),
  };
  r.component.send.subscribe(out.send);
  r.component.stop.subscribe(out.stop);
  r.component.compare.subscribe(out.compare);
  r.component.act.subscribe(out.act);
  r.component.openOptions.subscribe(out.openOptions);
  const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
  return { ...r, ...out, box, user: userEvent.setup() };
}

const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });

const actions: readonly ComposerAction[] = [
  { id: 'tangent', label: 'Tangent ↳', title: 'Explore on the side', primary: true },
  { id: 'next', label: 'Next ➜', icon: 'next', title: 'Keeps the lesson moving', primary: false },
];

/** The actions with Tangent's options offered, as power's composer does. */
const withOptions: readonly ComposerAction[] = actions.map((a) =>
  a.id === 'tangent' ? { ...a, options: 'Tangent with options: context, model, quote…' } : a,
);

describe('Composer', () => {
  it('sends the trimmed text on Enter, and keeps it until the message is in the tree', async () => {
    const c = await composer();
    expect(c.box.getAttribute('enterkeyhint')).toBe('send');
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

  describe('with actions in place of Send', () => {
    it('shows one button per action, marked for the walkthrough, and no Send', async () => {
      await composer({ actions });
      expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
      const tangent = button('Tangent');
      const next = button('Next');
      expect(tangent.dataset['action']).toBe('tangent');
      expect(next.dataset['action']).toBe('next');
      expect(tangent.classList).toContain('is-primary');
      expect(next.classList).not.toContain('is-primary');
      // Each names the key that fires it.
      expect(tangent.title).toBe('Explore on the side (Enter)');
      expect(next.getAttribute('aria-description')).toBe('Keeps the lesson moving (Ctrl+Enter)');
      expect(tangent.disabled).toBe(true);
    });

    it('Enter fires the filled action, Ctrl or Cmd+Enter the other', async () => {
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

    it('the filled action keeps its keys wherever it stands: the buttons stay in order', async () => {
      const c = await composer({
        actions: actions.map((a) => ({ ...a, primary: a.id === 'next' })),
      });
      expect(screen.getAllByRole('button').map((b) => b.dataset['action'])).toEqual([
        'tangent',
        'next',
      ]);
      expect(button('Next').classList).toContain('is-primary');
      expect(button('Tangent').classList).not.toContain('is-primary');
      expect(button('Next').title).toBe('Keeps the lesson moving (Enter)');
      expect(button('Tangent').title).toBe('Explore on the side (Ctrl+Enter)');
      await c.user.type(c.box, 'Go on{Enter}');
      expect(c.act).toHaveBeenLastCalledWith({ id: 'next', text: 'Go on' });
      await c.user.keyboard('{Control>}{Enter}{/Control}');
      expect(c.act).toHaveBeenLastCalledWith({ id: 'tangent', text: 'Go on' });
      await c.user.keyboard('{Meta>}{Enter}{/Meta}');
      expect(c.act).toHaveBeenLastCalledWith({ id: 'tangent', text: 'Go on' });
      expect(c.act).toHaveBeenCalledTimes(3);
    });

    it('a click fires its action', async () => {
      const c = await composer({ actions });
      await c.user.type(c.box, 'Go on');
      await c.user.click(button('Next'));
      expect(c.act).toHaveBeenCalledExactlyOnceWith({ id: 'next', text: 'Go on' });
      await c.user.click(button('Tangent'));
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
      expect(screen.queryByRole('button', { name: 'Tangent' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
      await c.user.type(c.box, 'More{Enter}');
      expect(c.act).not.toHaveBeenCalled();
      await c.user.click(button('Stop the reply'));
      expect(c.stop).toHaveBeenCalledTimes(1);
    });

    it('a blank or disabled box fires nothing', async () => {
      const c = await composer({ actions });
      await c.user.type(c.box, '   {Enter}');
      await c.set({ disabled: true });
      await c.user.click(button('Next'));
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

    it('each is named without its arrow, which shows but is not read out', async () => {
      await composer({ actions });
      const tangent = button('Tangent');
      expect(tangent.textContent?.trim()).toBe('Tangent ↳');
      expect(within(tangent).getByText('↳').getAttribute('aria-hidden')).toBe('true');
      expect(button('Next').textContent?.trim()).toBe('Next ➜');
      // Offered no options, an action has no caret.
      expect(screen.queryByRole('button', { name: /with options/ })).toBeNull();
    });

    it('an action with options has a caret joined to it that opens them, typed or not', async () => {
      const c = await composer({ actions: withOptions });
      const caret = button('Tangent with options…');
      expect(caret.getAttribute('aria-haspopup')).toBe('dialog');
      expect(caret.title).toBe('Tangent with options: context, model, quote… (Ctrl+Shift+Enter)');
      expect(caret.getAttribute('aria-description')).toBe(caret.title);
      // Just after its action, before the next one.
      expect(screen.getAllByRole('button')).toEqual([button('Tangent'), caret, button('Next')]);
      // The options take the message themselves, so nothing need be typed first.
      expect(caret.disabled).toBe(false);
      await c.user.click(caret);
      expect(c.openOptions).toHaveBeenCalledExactlyOnceWith({ id: 'tangent', text: '' });
      await c.user.type(c.box, ' Why so? ');
      await c.user.click(caret);
      expect(c.openOptions).toHaveBeenLastCalledWith({ id: 'tangent', text: 'Why so?' });
      expect(c.act).not.toHaveBeenCalled();
      expect(c.send).not.toHaveBeenCalled();
    });

    it('Ctrl or Cmd+Shift+Enter opens the options, and leaves the text as it is', async () => {
      const c = await composer({ actions: withOptions });
      await c.user.type(c.box, 'Why so?');
      await c.user.keyboard('{Control>}{Shift>}{Enter}{/Shift}{/Control}');
      expect(c.openOptions).toHaveBeenLastCalledWith({ id: 'tangent', text: 'Why so?' });
      await c.user.keyboard('{Meta>}{Shift>}{Enter}{/Shift}{/Meta}');
      expect(c.openOptions).toHaveBeenCalledTimes(2);
      expect(c.act).not.toHaveBeenCalled();
      expect(c.box.value).toBe('Why so?');
      // The other keys still fire the actions.
      await c.user.keyboard('{Enter}');
      expect(c.act).toHaveBeenCalledExactlyOnceWith({ id: 'tangent', text: 'Why so?' });
    });

    it('without options, Ctrl+Shift+Enter opens nothing', async () => {
      const c = await composer({ actions });
      await c.user.type(c.box, 'Why so?');
      await c.user.keyboard('{Control>}{Shift>}{Enter}{/Shift}{/Control}');
      expect(c.openOptions).not.toHaveBeenCalled();
      expect(c.act).not.toHaveBeenCalled();
    });

    it('the options wait while the box is disabled, and go with the actions while a reply streams', async () => {
      const c = await composer({ actions: withOptions, disabled: true, initial: 'Why so?' });
      expect(button('Tangent with options…').disabled).toBe(true);
      await c.set({ disabled: false, busy: true });
      expect(screen.queryByRole('button', { name: 'Tangent with options…' })).toBeNull();
      await c.user.type(c.box, '{Control>}{Shift>}{Enter}{/Shift}{/Control}');
      expect(c.openOptions).not.toHaveBeenCalled();
    });

    it('without actions, Enter and Ctrl+Enter still send', async () => {
      const c = await composer();
      await c.user.type(c.box, 'Plain{Enter}');
      await c.user.keyboard('{Control>}{Enter}{/Control}');
      expect(c.send).toHaveBeenCalledTimes(2);
      expect(c.act).not.toHaveBeenCalled();
    });
  });

  describe('on a touch screen (no hover)', () => {
    beforeEach(() =>
      vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(hover: none)' })),
    );
    afterEach(() => vi.unstubAllGlobals());

    it('Enter starts a new line and only the buttons send; Ctrl or Cmd+Enter still sends', async () => {
      const c = await composer({ actions });
      expect(c.box.getAttribute('enterkeyhint')).toBe('enter');
      // So the tooltips name no key.
      expect(button('Tangent').title).toBe('Explore on the side');
      expect(button('Next').getAttribute('aria-description')).toBe('Keeps the lesson moving');
      await c.user.type(c.box, 'Line one{Enter}Line two');
      expect(c.box.value).toBe('Line one\nLine two');
      expect(c.act).not.toHaveBeenCalled();
      await c.user.keyboard('{Control>}{Enter}{/Control}');
      expect(c.act).toHaveBeenLastCalledWith({ id: 'next', text: 'Line one\nLine two' });
      await c.user.click(button('Tangent'));
      expect(c.act).toHaveBeenLastCalledWith({ id: 'tangent', text: 'Line one\nLine two' });
      expect(c.act).toHaveBeenCalledTimes(2);
    });

    it('the caret names no key either, and Ctrl or Cmd+Shift+Enter still opens the options', async () => {
      const c = await composer({ actions: withOptions });
      expect(button('Tangent with options…').title).toBe(
        'Tangent with options: context, model, quote…',
      );
      await c.user.type(c.box, 'Why so?{Meta>}{Shift>}{Enter}{/Shift}{/Meta}');
      expect(c.openOptions).toHaveBeenCalledExactlyOnceWith({ id: 'tangent', text: 'Why so?' });
    });

    it('with the plain Send too', async () => {
      const c = await composer();
      await c.user.type(c.box, 'Line one{Enter}Line two');
      expect(c.send).not.toHaveBeenCalled();
      await c.user.click(button('Send'));
      expect(c.send).toHaveBeenCalledExactlyOnceWith('Line one\nLine two');
    });
  });

  it('names the target in the open box if asked as it opens, and keeps that while it stays open', async () => {
    const c = await composer({ target: 'A wave.', nameTarget: true });
    const shown = vi.fn();
    c.component.showTarget.subscribe(shown);
    const named = () => screen.queryByRole('button', { name: 'from “A wave.”' });
    // Closed, it names nothing.
    c.box.blur();
    await c.fixture.whenStable();
    expect(named()).toBeNull();
    await c.user.click(c.box);
    expect(named()?.title).toBe('Show the reply Tangent ↳ starts from');
    // Asked otherwise while open (the reader scrolled): the box keeps its height.
    await c.set({ nameTarget: false });
    await c.user.type(c.box, 'Why?');
    expect(named()).not.toBeNull();
    // Shown, with the focus left in the box.
    await c.user.click(named()!);
    expect(shown).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(c.box);
    // Opened again, it asks again.
    c.box.blur();
    await c.fixture.whenStable();
    expect(named()).toBeNull();
    await c.user.click(c.box);
    expect(named()).toBeNull();
    // Nothing to name: no row, however it is asked.
    await c.set({ target: null, nameTarget: true });
    c.box.blur();
    await c.user.click(c.box);
    expect(screen.queryByRole('button', { name: /^from/ })).toBeNull();
  });

  it('losing its target while open (to a lead), the box names nothing until it opens again', async () => {
    const c = await composer({ target: 'A wave.', nameTarget: true });
    const named = () => screen.queryByRole('button', { name: /^from/ });
    c.box.blur();
    await c.fixture.whenStable();
    await c.user.click(c.box);
    expect(named()).not.toBeNull();
    await c.set({ target: null });
    expect(named()).toBeNull();
    // The lead taken off again: its place stays empty while the box is open.
    await c.set({ target: 'A wave.' });
    expect(named()).toBeNull();
    c.box.blur();
    await c.fixture.whenStable();
    await c.user.click(c.box);
    expect(named()).not.toBeNull();
  });

  it('is open while focused, and stays open through a press elsewhere until it ends', async () => {
    const c = await composer();
    const form = c.box.closest('form')!;
    const outside = document.body.appendChild(document.createElement('button'));
    outside.textContent = 'Elsewhere';
    const clicked = vi.fn();
    outside.addEventListener('click', clicked);
    try {
      await c.user.click(c.box);
      expect(form.classList).toContain('is-open');

      // The press takes the focus at once, but a box that shrank now would move
      // what is under the pointer before the click lands.
      await c.user.pointer({ keys: '[MouseLeft>]', target: outside });
      expect(document.activeElement).toBe(outside);
      expect(form.classList).toContain('is-open');
      await c.user.pointer({ keys: '[/MouseLeft]', target: outside });
      expect(clicked).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(form.classList).not.toContain('is-open'));

      // Leaving by keyboard closes it at once.
      await c.user.click(c.box);
      expect(form.classList).toContain('is-open');
      await c.user.tab();
      expect(form.classList).not.toContain('is-open');
    } finally {
      outside.remove();
    }
  });
});
