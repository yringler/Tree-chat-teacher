import { describe, expect, it } from 'vitest';
import {
  formatTangents,
  groupTangents,
  parseTangentLine,
  splitTangents,
  tangentsAsMarkdown,
  type Tangent,
} from './tangents.js';

const REPLY = `Because water expands when it freezes.

Each molecule locks into a lattice held open by hydrogen bonds.

<tangents>
- Why ice is less dense than water — the lattice has more empty space than the liquid
- **Why lakes freeze from the top down**: the same fact, seen from a fish's point of view
* "Hydrogen bonds" – what they actually are
3. Bare title with no reason
</tangents>`;

describe('splitTangents', () => {
  it('leaves a reply without a block alone', () => {
    expect(splitTangents('Just an answer.\n')).toEqual({
      body: 'Just an answer.',
      tangents: [],
      partial: false,
    });
  });

  it('separates the block from the body and parses each line', () => {
    const { body, tangents, partial } = splitTangents(REPLY);
    expect(partial).toBe(false);
    expect(body).toBe(
      'Because water expands when it freezes.\n\nEach molecule locks into a lattice held open by hydrogen bonds.',
    );
    expect(tangents).toEqual([
      {
        title: 'Why ice is less dense than water',
        why: 'the lattice has more empty space than the liquid',
        kind: 'tangent',
      },
      {
        title: 'Why lakes freeze from the top down',
        why: "the same fact, seen from a fish's point of view",
        kind: 'tangent',
      },
      { title: 'Hydrogen bonds', why: 'what they actually are', kind: 'tangent' },
      { title: 'Bare title with no reason', why: null, kind: 'tangent' },
    ]);
  });

  it('hides an unfinished block while the reply streams', () => {
    const { body, tangents, partial } = splitTangents('Answer so far.\n\n<tangents>\n- Half a li');
    expect(body).toBe('Answer so far.');
    expect(tangents).toEqual([]);
    expect(partial).toBe(true);
    expect(splitTangents('A.\n<tangents>\n- [continue] Next — wh')).toEqual({
      body: 'A.',
      tangents: [],
      partial: true,
    });
  });

  it('keeps text after the block, drops duplicates and caps the list', () => {
    const lines = Array.from({ length: 9 }, (_, i) => `- T${i % 8} — r`).join('\n');
    const { body, tangents } = splitTangents(`A.\n<tangents>\n${lines}\n</tangents>\nAfter.`);
    expect(body).toBe('A.\n\nAfter.');
    expect(tangents.map((t) => t.title)).toEqual(['T0', 'T1', 'T2', 'T3', 'T4', 'T5']);
  });

  it('is case-insensitive about the tag and tolerant of spaces', () => {
    const { tangents } = splitTangents('<Tangents >\n- One — two\n</TANGENTS>');
    expect(tangents).toEqual([{ title: 'One', why: 'two', kind: 'tangent' }]);
  });

  it("reads each line's kind tag, keeping the order within each kind", () => {
    const { tangents } = splitTangents(
      [
        '<tangents>',
        '- [continue] Where the number comes from — the next step of the lesson',
        '- [tangent] What a limit is — the idea the answer leans on',
        '- Untagged side trip — a model that dropped the tag',
        '- [tangent] Compound interest — where e first showed up',
        '</tangents>',
      ].join('\n'),
    );
    expect(tangents).toEqual([
      {
        title: 'Where the number comes from',
        why: 'the next step of the lesson',
        kind: 'continue',
      },
      { title: 'What a limit is', why: 'the idea the answer leans on', kind: 'tangent' },
      { title: 'Untagged side trip', why: 'a model that dropped the tag', kind: 'tangent' },
      { title: 'Compound interest', why: 'where e first showed up', kind: 'tangent' },
    ]);
  });

  it('caps each kind on its own: 3 continue, 6 tangent', () => {
    const lines = [
      ...Array.from({ length: 5 }, (_, i) => `- [continue] C${i} — r`),
      ...Array.from({ length: 8 }, (_, i) => `- [tangent] T${i} — r`),
    ].join('\n');
    const { tangents } = splitTangents(`<tangents>\n${lines}\n</tangents>`);
    const { continue: next, tangent } = groupTangents(tangents);
    expect(next.map((t) => t.title)).toEqual(['C0', 'C1', 'C2']);
    expect(tangent.map((t) => t.title)).toEqual(['T0', 'T1', 'T2', 'T3', 'T4', 'T5']);
  });

  it('drops a title repeated under the other kind: the first one wins', () => {
    const { tangents } = splitTangents(
      '<tangents>\n- [tangent] Limits — a\n- [continue] limits — b\n- [continue] Series — c\n</tangents>',
    );
    expect(tangents).toEqual([
      { title: 'Limits', why: 'a', kind: 'tangent' },
      { title: 'Series', why: 'c', kind: 'continue' },
    ]);
  });
});

describe('parseTangentLine', () => {
  it('returns null for blank or marker-only lines', () => {
    expect(parseTangentLine('')).toBeNull();
    expect(parseTangentLine('- ')).toBeNull();
    expect(parseTangentLine('   ')).toBeNull();
  });

  it('does not split a hyphenated word', () => {
    expect(parseTangentLine('- Self-organizing maps')).toEqual({
      title: 'Self-organizing maps',
      why: null,
      kind: 'tangent',
    });
  });

  it('splits on an unspaced em dash too', () => {
    expect(parseTangentLine('- A—b')).toEqual({ title: 'A', why: 'b', kind: 'tangent' });
  });

  it('reads the [continue] and [tangent] tags', () => {
    expect(parseTangentLine('- [continue] Next — why')).toEqual({
      title: 'Next',
      why: 'why',
      kind: 'continue',
    });
    expect(parseTangentLine('- [tangent] Side — why')).toEqual({
      title: 'Side',
      why: 'why',
      kind: 'tangent',
    });
  });

  it('takes [next] and [reply] as continue, in any case', () => {
    expect(parseTangentLine('- [next] A')?.kind).toBe('continue');
    expect(parseTangentLine('- [Reply] A')?.kind).toBe('continue');
    expect(parseTangentLine('- [CONTINUE] A')?.kind).toBe('continue');
    expect(parseTangentLine('- [Tangent] A')).toEqual({ title: 'A', why: null, kind: 'tangent' });
  });

  it('finds a tag inside or outside bold', () => {
    const expected = { title: 'Where e comes from', why: 'next', kind: 'continue' };
    expect(parseTangentLine('- **[continue] Where e comes from** — next')).toEqual(expected);
    expect(parseTangentLine('- [continue] **Where e comes from** — next')).toEqual(expected);
  });

  it('treats an untagged line as a tangent', () => {
    expect(parseTangentLine('- Plain title — why')?.kind).toBe('tangent');
  });

  it('returns null for a tag with no title', () => {
    expect(parseTangentLine('- [continue]')).toBeNull();
    expect(parseTangentLine('- [tangent]   ')).toBeNull();
  });
});

describe('formatTangents', () => {
  it('round-trips through splitTangents', () => {
    const tangents: Tangent[] = [
      { title: 'One', why: 'because', kind: 'continue' },
      { title: 'Two', why: null, kind: 'tangent' },
    ];
    const block = formatTangents(tangents);
    expect(block).toBe('<tangents>\n- [continue] One — because\n- [tangent] Two\n</tangents>');
    expect(splitTangents(`Body.\n\n${block}`)).toEqual({
      body: 'Body.',
      tangents,
      partial: false,
    });
  });
});

describe('groupTangents', () => {
  it('splits the list by kind, keeping the order', () => {
    const a: Tangent = { title: 'A', why: null, kind: 'tangent' };
    const b: Tangent = { title: 'B', why: null, kind: 'continue' };
    const c: Tangent = { title: 'C', why: null, kind: 'tangent' };
    expect(groupTangents([a, b, c])).toEqual({ continue: [b], tangent: [a, c] });
    expect(groupTangents([])).toEqual({ continue: [], tangent: [] });
  });
});

describe('tangentsAsMarkdown', () => {
  it('rewrites the block as plain "Keep going" and "Tangents" lists', () => {
    const reply =
      'Body.\n\n<tangents>\n- [tangent] Why ice floats — density\n- [continue] Heavy water\n- Snow\n</tangents>';
    expect(tangentsAsMarkdown(reply)).toBe(
      'Body.\n\n**Keep going**\n\n- **Heavy water**\n\n**Tangents**\n\n- **Why ice floats** — density\n- **Snow**',
    );
  });

  it('writes only the Tangents list when nothing continues', () => {
    const reply = 'Body.\n\n<tangents>\n- Why ice floats — density\n- Heavy water\n</tangents>';
    expect(tangentsAsMarkdown(reply)).toBe(
      'Body.\n\n**Tangents**\n\n- **Why ice floats** — density\n- **Heavy water**',
    );
  });

  it('writes only the Keep going list when everything continues', () => {
    expect(tangentsAsMarkdown('<tangents>\n- [continue] Next\n</tangents>')).toBe(
      '**Keep going**\n\n- **Next**',
    );
  });

  it('leaves replies without a block alone and drops an unfinished or empty one', () => {
    expect(tangentsAsMarkdown('Just text.\n')).toBe('Just text.\n');
    expect(tangentsAsMarkdown('Body.\n<tangents>\n- Half')).toBe('Body.');
    expect(tangentsAsMarkdown('Body.\n<tangents>\n</tangents>')).toBe('Body.');
    expect(tangentsAsMarkdown('<tangents>\n- Only\n</tangents>')).toBe(
      '**Tangents**\n\n- **Only**',
    );
  });
});
