import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../testing';
import { TangentAsk } from './tangent-ask';

/** The grown "Ask your own" field, as Canvas shows it. */
async function tangentAsk() {
  const r = await render(TangentAsk, {
    inputs: { label: 'Ask on a new tangent', expandable: true },
  });
  const ask = vi.fn();
  r.component.ask.subscribe(ask);
  const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Ask on a new tangent' });
  return { ...r, ask, field, user: userEvent.setup() };
}

describe('TangentAsk', () => {
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
