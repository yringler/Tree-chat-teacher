import { describe, expect, it } from 'vitest';
import { splitTangents } from '@tangent/shared';
import { BlockRenderer, splitBlocks } from '../src/blocks.js';
import { renderMarkdown } from '../src/markdown.js';

/** Replies that exercise every rule of the splitter; each is checked at every prefix. */
const FIXTURES: Record<string, string> = {
  paragraphs:
    '# Title\n\nFirst **para** with [a link](https://example.org).\nSecond line.\n\n\n' +
    'Setext\n===\n\n---\n\nLast para  \nhard break.',
  fences:
    'Intro:\n\n```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\nBetween.\n\n' +
    '~~~\ntilde\n\n```\nstill tilde\n~~~\n\n````md\n```\ninner\n```\n\n````\n\n' +
    '``` not a fence ``` text\n\nAfter.\n\n   ```\nindented fence\n\n  ```\n\nEnd.',
  'nested lists':
    '- one\n- two\n  - nested a\n\n  - nested b\n\n    nested para\n- three\n\n' +
    'A paragraph ends the list.\n\n1. first\n\n2. second\n   ```\n   code\n\n   more\n   ```\n\n' +
    '10) tenth\n\n- after\n\n-\n\n+ plus\n* star\n\n  indented continuation\n\nDone.',
  'loose and tight':
    '- a\n- b\n\n- c\n\nPara.\n\n- tight\n- list\n\nPara two.\n\n3. starts at three\n4. four',
  tables:
    '| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |\n\nText.\n\n| x |\n|---|\n| y |\n\n| not | a table |',
  math:
    'Inline $x^2$ and \\(y\\).\n\n$$\na + b\n\n= c\n$$\n\nText.\n\n$$x = 1$$\n\n' +
    '\\[\n\\int_0^1 f\n\n\\]\n\n$$a$$ and $b$\n\nMoney: $5 and $10.\n\n$$ open\n\nstill math\n',
  quotes: '> quoted\n> more\n\n> second quote\n\nText.\n\n> - list in quote\n>\n> - item\n\nEnd.',
  'html-like text':
    '<div>\n\n<b>not bold</b>\n\n<pre>\n```\ncode\n</pre>\n\nmore\n```\n\n<!-- c -->\n\n<script>x</script>',
  'indented code': 'Para.\n\n    code line\n\n    more code\n\nText.\n\n\tTabbed\n\nEnd.',
  references:
    'See [the docs][docs] and [more].\n\nMiddle.\n\n[docs]: https://example.org/docs\n[more]: /more "T"',
  'reference in a list': 'Use [x][].\n\n- item\n\n- [x]: /url\n\nEnd.',
  'multi-line label': 'A [foo\nbar] link.\n\n[foo\nbar]: /url\n\nEnd.',
  'not references':
    'An array `a[i]: x` and\n[a link](https://x.org) at a line start.\n\n```ts\n[key: string]: number;\n```\n\nEnd.',
};

const crlf = (s: string): string => s.replace(/\n/g, '\r\n');

/** Every fixture, also with CRLF and lone-CR line ends. */
const ALL: [string, string][] = Object.entries(FIXTURES).flatMap(([name, text]) => [
  [name, text],
  [`${name} (CRLF)`, crlf(text)],
  [`${name} (CR)`, text.replace(/\n/g, '\r')],
]);

function renderBlocks(text: string): string {
  const { done, tail } = splitBlocks(text);
  return done.map((b) => renderMarkdown(b)).join('') + renderMarkdown(tail);
}

describe('splitBlocks', () => {
  it.each(ALL)(
    '%s: at every prefix, the blocks are the text and render as the whole',
    (_, text) => {
      let previous: string[] = [];
      for (let i = 0; i <= text.length; i++) {
        const prefix = text.slice(0, i);
        const { done, tail } = splitBlocks(prefix);
        expect(done.join('') + tail).toBe(prefix);
        expect(renderBlocks(prefix), `prefix ${JSON.stringify(prefix)}`).toBe(
          renderMarkdown(prefix),
        );
        // A finished block stays finished as the text grows (unless a reference merges all).
        if (done.length > 0) expect(done.slice(0, previous.length)).toEqual(previous);
        previous = done;
      }
    },
  );

  it('splits at blank lines between finished blocks, keeping the blank lines', () => {
    expect(splitBlocks('# A\n\nPara one.\n\n\nPara two.')).toEqual({
      done: ['# A\n\n', 'Para one.\n\n\n'],
      tail: 'Para two.',
    });
    expect(splitBlocks('One.\r\n\r\nTwo.')).toEqual({ done: ['One.\r\n\r\n'], tail: 'Two.' });
  });

  it('keeps a block open until the line after the blank lines is known', () => {
    expect(splitBlocks('Para.\n\n')).toEqual({ done: [], tail: 'Para.\n\n' });
    expect(splitBlocks('Para.\n\n  ')).toEqual({ done: [], tail: 'Para.\n\n  ' });
    expect(splitBlocks('Para.\n\nN')).toEqual({ done: ['Para.\n\n'], tail: 'N' });
    expect(splitBlocks('Para.\r\n\r')).toEqual({ done: [], tail: 'Para.\r\n\r' });
    // After a list, "1" may become "1. item" (the same list) or "1990 was…".
    expect(splitBlocks('- a\n\n1').done).toEqual([]);
    expect(splitBlocks('- a\n\n-').done).toEqual([]);
    expect(splitBlocks('- a\n\n1990 was').done).toEqual(['- a\n\n']);
    expect(splitBlocks('Para.\n\n-').done).toEqual(['Para.\n\n']);
  });

  it('never splits inside fenced code, open or closed', () => {
    const open = 'Intro.\n\n```py\ndef f():\n\n    return 1\n\nprint(f())';
    expect(splitBlocks(open)).toEqual({ done: ['Intro.\n\n'], tail: open.slice(8) });
    const closed = '```\na\n\nb\n```\n\nAfter.';
    expect(splitBlocks(closed).done).toEqual(['```\na\n\nb\n```\n\n']);
    // A shorter or other-character fence does not close it.
    expect(splitBlocks('````\n```\n\nx\n~~~~\n\ny').done).toEqual([]);
    // Half-written closing fence: still open.
    expect(splitBlocks('```\ncode\n\n``').done).toEqual([]);
    expect(splitBlocks('```\ncode\n```').done).toEqual([]);
    expect(splitBlocks('```\ncode\n```\n\nx').done).toEqual(['```\ncode\n```\n\n']);
  });

  it('never splits inside display math', () => {
    expect(splitBlocks('$$\na\n\nb\n$$\n\nAfter.').done).toEqual(['$$\na\n\nb\n$$\n\n']);
    expect(splitBlocks('$$\na\n\nb').done).toEqual([]);
    expect(splitBlocks('\\[\na\n\nb').done).toEqual([]);
    expect(splitBlocks('$$a$$\n\nAfter.').done).toEqual(['$$a$$\n\n']);
    // A fence inside math is math; math inside a fence is code.
    expect(splitBlocks('$$\n```\n$$\n\nx').done).toEqual(['$$\n```\n$$\n\n']);
    expect(splitBlocks('```\n$$\n```\n\nx').done).toEqual(['```\n$$\n```\n\n']);
  });

  it('never splits a list: items, loose items and indented continuations stay together', () => {
    const list = '- a\n\n- b\n\n  more of b\n\n      code in b\n- c\n\n';
    expect(splitBlocks(`${list}After.`).done).toEqual([list]);
    expect(splitBlocks('1. a\n\n2. b').done).toEqual([]);
    // A paragraph after a list may start a list of its own.
    expect(splitBlocks('Para.\n\n- a\n- b\n\nEnd.').done).toEqual(['Para.\n\n', '- a\n- b\n\n']);
  });

  it('never splits a table or a block quote (both end at a blank line)', () => {
    expect(splitBlocks('| a |\n|---|\n| 1 |\n| 2 |').done).toEqual([]);
    expect(splitBlocks('> a\n> b\n>\n> c').done).toEqual([]);
    expect(splitBlocks('| a |\n|---|\n| 1 |\n\n> q\n\nx').done).toEqual([
      '| a |\n|---|\n| 1 |\n\n',
      '> q\n\n',
    ]);
  });

  it('does not split text that may define a link reference (it reaches every block)', () => {
    const text = 'Use [x][].\n\nMore.\n\n[x]: https://example.org';
    expect(splitBlocks(text)).toEqual({ done: [], tail: text });
    expect(renderBlocks(text)).toContain('href="https://example.org"');
    expect(splitBlocks('A.\n\n> [x]: /u\n\nB.').done).toEqual([]);
    expect(splitBlocks('A.\n\n[label on\n\nB.').done).toEqual([]);
    // Not a definition: a link at a line start, or `]:` in code.
    expect(splitBlocks('A.\n\n[a](/b) c\n\nB.').done).toEqual(['A.\n\n', '[a](/b) c\n\n']);
    expect(splitBlocks('```\n[k: string]: T\n```\n\nB.').done).toHaveLength(1);
  });

  it('a half-streamed <tangents> block never reaches the blocks', () => {
    const reply =
      'The answer.\n\nMore detail.\n\n<tangents>\n- Roots — where trees start\n- Leaves\n</tangents>';
    const renderer = new BlockRenderer(renderMarkdown);
    for (let i = 0; i <= reply.length; i++) {
      const { body } = splitTangents(reply.slice(0, i));
      const html = renderer.update(body).join('');
      expect(html).toBe(renderMarkdown(body));
      if (i >= reply.indexOf('<tangents>') + '<tangents>'.length) {
        expect(html).not.toContain('tangents');
        expect(html).not.toContain('Roots');
      }
    }
    expect(splitBlocks(splitTangents(reply).body)).toEqual({
      done: ['The answer.\n\n'],
      tail: 'More detail.',
    });
  });

  it('relies on raw HTML being text: there are no HTML blocks to split inside', () => {
    // If the renderer ever allows HTML (`html: true`), the splitter must learn HTML blocks.
    expect(renderMarkdown('<pre>\n\nx\n</pre>')).toBe(
      '<p>&lt;pre&gt;</p>\n<p>x\n&lt;/pre&gt;</p>\n',
    );
  });
});

describe('BlockRenderer', () => {
  /** A renderer that counts what it renders. */
  function counting(): { renderer: BlockRenderer; calls: string[] } {
    const calls: string[] = [];
    const renderer = new BlockRenderer((md) => {
      calls.push(md);
      return renderMarkdown(md);
    });
    return { renderer, calls };
  }

  it.each(ALL)('%s: streamed in deltas of any size, matches the whole render', (_, text) => {
    for (const step of [1, 3, 7, 16]) {
      const { renderer } = counting();
      for (let i = 0; i < text.length + step; i += step) {
        const prefix = text.slice(0, i);
        expect(renderer.update(prefix).join('')).toBe(renderMarkdown(prefix));
      }
    }
  });

  it('renders each finished block once; only the last block again', () => {
    const blocks = [
      '# Title\n\n',
      'Para one.\n\n',
      '```js\nlet a;\n\nlet b;\n```\n\n',
      '- x\n- y\n\n',
    ];
    const text = `${blocks.join('')}The end.`;
    const { renderer, calls } = counting();
    for (let i = 4; i < text.length + 4; i += 4) {
      const prefix = text.slice(0, i);
      expect(renderer.update(prefix).join('')).toBe(renderMarkdown(prefix));
    }
    for (const b of blocks) {
      // Rendered at most once in its finished form (often never: the last tail is reused).
      expect(calls.filter((c) => c === b).length).toBeLessThanOrEqual(1);
      // And as the growing tail once per update at most, while it was the last block.
      const asTail = calls.filter((c) => c !== b && b.startsWith(c) && c.length > 0);
      expect(asTail.length).toBeLessThanOrEqual(Math.ceil(b.length / 4) + 1);
    }
    // No render ever covers two blocks.
    for (const c of calls) expect(blocks.some((b) => c.includes(b) && c !== b)).toBe(false);
  });

  it('renders nothing again when the text has not changed', () => {
    const { renderer, calls } = counting();
    renderer.update('A.\n\nB');
    const n = calls.length;
    expect(renderer.update('A.\n\nB')).toEqual(['<p>A.</p>\n', '<p>B</p>\n']);
    expect(calls.length).toBe(n);
  });

  it('starts over when the text changes other than by growing', () => {
    const { renderer } = counting();
    renderer.update('Old one.\n\nOld two.\n\nTail');
    expect(renderer.update('New one.\n\nNew').join('')).toBe(renderMarkdown('New one.\n\nNew'));
    renderer.reset();
    expect(renderer.update('')).toEqual([]);
  });

  it('a link reference definition arriving late re-renders everything as one block', () => {
    const { renderer } = counting();
    renderer.update('See [x].\n\nMore.\n\n');
    const html = renderer.update('See [x].\n\nMore.\n\n[x]: /u');
    expect(html).toEqual([renderMarkdown('See [x].\n\nMore.\n\n[x]: /u')]);
    expect(html[0]).toContain('href="/u"');
  });
});
