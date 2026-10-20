import { TestBed } from '@angular/core/testing';
import { powerProviders, render, signIn } from '@tangent/web-shared/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasStore } from '../state/canvas-store';
import { HomePage } from './home-page';

/** The home page, signed in, with `startConversation` a spy. */
async function home() {
  await render(HomePage, {
    providers: powerProviders(CanvasStore, {}),
    setup: () => signIn(TestBed.inject(CanvasStore).account),
  });
  const start = vi.spyOn(TestBed.inject(CanvasStore), 'startConversation').mockResolvedValue();
  const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'First message' });
  return { start, box, user: userEvent.setup() };
}

describe('Canvas home: the first message', () => {
  it('Enter opens the conversation; Shift+Enter starts a new line', async () => {
    const h = await home();
    expect(h.box.getAttribute('enterkeyhint')).toBe('send');
    await h.user.type(h.box, 'Line one{Shift>}{Enter}{/Shift}Line two{Enter}');
    expect(h.start).toHaveBeenCalledOnce();
    expect(h.start.mock.calls[0]?.[0]).toBe('Line one\nLine two');
  });

  describe('on a touch screen (no hover)', () => {
    beforeEach(() =>
      vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(hover: none)' })),
    );
    afterEach(() => vi.unstubAllGlobals());

    it('Enter starts a new line and only the button opens it; Ctrl or Cmd+Enter still does', async () => {
      const h = await home();
      expect(h.box.getAttribute('enterkeyhint')).toBe('enter');
      await h.user.type(h.box, 'Line one{Enter}Line two');
      expect(h.box.value).toBe('Line one\nLine two');
      expect(h.start).not.toHaveBeenCalled();
      await h.user.keyboard('{Control>}{Enter}{/Control}');
      expect(h.start.mock.calls[0]?.[0]).toBe('Line one\nLine two');
      await h.user.click(screen.getByRole('button', { name: 'Open on the canvas' }));
      expect(h.start).toHaveBeenCalledTimes(2);
    });
  });
});
