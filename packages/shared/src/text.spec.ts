import { describe, expect, it } from 'vitest';
import { clip, plainText } from './text.js';

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
