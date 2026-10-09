import { describe, expect, it } from 'vitest';
import { clip, clipUtf16, plainText } from './text.js';

describe('clip', () => {
  it('keeps text within the limit and cuts longer text to the limit, ellipsis included', () => {
    expect(clip('short', 5)).toBe('short');
    expect(clip('a longer text', 8)).toBe('a longe…');
    expect(Array.from(clip('x'.repeat(50), 10))).toHaveLength(10);
  });

  it('never splits a surrogate pair, and counts one as one character', () => {
    expect(clip('ab😀cd', 4)).toBe('ab😀…');
    expect(clip('😀😀😀', 3)).toBe('😀😀😀');
    expect(clip('😀😀😀😀', 3)).toBe('😀😀…');
  });

  it('drops the space the cut leaves before the ellipsis', () => {
    expect(clip('word word word', 6)).toBe('word…');
  });
});

describe('clipUtf16', () => {
  it('cuts to at most `max` UTF-16 units, ellipsis included, as JavaScript lengths count', () => {
    expect(clipUtf16('short', 5)).toBe('short');
    expect(clipUtf16('a longer text', 8)).toBe('a longe…');
    expect(clipUtf16('😀'.repeat(10), 7).length).toBeLessThanOrEqual(7);
  });

  it('never splits a surrogate pair at the cut', () => {
    // Units 0–3 are two emoji; a cut after unit 3 would split the second one.
    expect(clipUtf16('😀😀😀', 4)).toBe('😀…');
    expect(clipUtf16('😀😀😀', 5)).toBe('😀😀…');
  });
});

describe('plainText', () => {
  it('drops Markdown markup, keeps a code block’s text and collapses whitespace', () => {
    expect(
      plainText(
        "Good question! Let's start with **a confident kitten**.\n\n## Habits\n\n- **Listening**: an `owl` hums\n1. _second_ item\n> quoted [link](https://x.test) ![alt](i.png) <https://a.test/b>\n> ## Quoted heading\n\n```js\ncode();\n```\n~~gone~~ about ~5 end",
      ),
    ).toBe(
      "Good question! Let's start with a confident kitten. Habits Listening: an owl hums second item quoted link alt https://a.test/b Quoted heading code(); gone about ~5 end",
    );
  });

  it('keeps underscores inside identifiers', () => {
    expect(plainText('use snake_case names, _not_ emphasis')).toBe(
      'use snake_case names, not emphasis',
    );
  });

  it('clips to `max` with an ellipsis', () => {
    expect(plainText('**word** '.repeat(50), { max: 11 })).toBe('word word…');
    expect(plainText('short', { max: 12 })).toBe('short');
  });
});
