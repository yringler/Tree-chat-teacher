import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../testing';
import { TangentAsk } from './tangent-ask';

/** The grown "Ask your own" field, as Canvas shows it. */
async function tangentAsk(inputs: Record<string, unknown> = {}) {
  const r = await render(TangentAsk, {
    inputs: { label: 'Ask on a new tangent', expandable: true, ...inputs },
  });
  const ask = vi.fn();
  const openOptions = vi.fn();
  r.component.ask.subscribe(ask);
  r.component.openOptions.subscribe(openOptions);
  const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Ask on a new tangent' });
  return { ...r, ask, openOptions, field, user: userEvent.setup() };
}

describe('TangentAsk', () => {
  it("with options, a caret joined to Ask's right opens them with the question, typed or not", async () => {
    const t = await tangentAsk({ options: 'Ask with options: context, model, variants…' });
    await t.user.click(t.field);
    const ask = screen.getByRole('button', { name: 'Ask' });
    const caret = screen.getByRole('button', { name: 'Ask with options…' });
    expect(ask.nextElementSibling).toBe(caret);
    expect(caret.title).toBe('Ask with options: context, model, variants…');
    expect(caret.getAttribute('aria-haspopup')).toBe('dialog');
    await t.user.click(caret);
    expect(t.openOptions).toHaveBeenLastCalledWith('');
    await t.user.type(t.field, '  And owls? ');
    await t.user.click(caret);
    expect(t.openOptions).toHaveBeenLastCalledWith('And owls?');
    expect(t.ask).not.toHaveBeenCalled();
  });

  it('without options, Ask stands alone', async () => {
    const t = await tangentAsk();
    await t.user.click(t.field);
    expect(screen.getByRole('button', { name: 'Ask' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /with options/ })).toBeNull();
  });

  it('Enter asks; Shift+Enter starts a new line', async () => {
    const t = await tangentAsk();
    expect(t.field.getAttribute('enterkeyhint')).toBe('send');
    await t.user.type(t.field, 'Line one{Shift>}{Enter}{/Shift}Line two{Enter}');
    expect(t.ask).toHaveBeenCalledExactlyOnceWith('Line one\nLine two');
  });

  describe('on a touch screen (no hover)', () => {
    beforeEach(() =>
      vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(hover: none)' })),
    );
    afterEach(() => vi.unstubAllGlobals());

    it('Enter starts a new line and only Ask sends; Ctrl or Cmd+Enter still does', async () => {
      const t = await tangentAsk();
      expect(t.field.getAttribute('enterkeyhint')).toBe('enter');
      await t.user.type(t.field, 'Line one{Enter}Line two');
      expect(t.field.value).toBe('Line one\nLine two');
      expect(t.ask).not.toHaveBeenCalled();
      await t.user.keyboard('{Control>}{Enter}{/Control}');
      expect(t.ask).toHaveBeenLastCalledWith('Line one\nLine two');
      await t.user.keyboard('{Meta>}{Enter}{/Meta}');
      await t.user.click(screen.getByRole('button', { name: /Ask/ }));
      expect(t.ask).toHaveBeenCalledTimes(3);
    });
  });
});
