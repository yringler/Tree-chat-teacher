import { describe, expect, it } from 'vitest';
import { formatTangents, parseTangentLine, splitTangents, tangentsAsMarkdown } from './tangents.js';

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
      },
      {
        title: 'Why lakes freeze from the top down',
        why: "the same fact, seen from a fish's point of view",
      },
      { title: 'Hydrogen bonds', why: 'what they actually are' },
      { title: 'Bare title with no reason', why: null },
    ]);
  });

  it('hides an unfinished block while the reply streams', () => {
    const { body, tangents, partial } = splitTangents('Answer so far.\n\n<tangents>\n- Half a li');
    expect(body).toBe('Answer so far.');
    expect(tangents).toEqual([]);
    expect(partial).toBe(true);
  });

  it('keeps text after the block, drops duplicates and caps the list', () => {
    const lines = Array.from({ length: 9 }, (_, i) => `- T${i % 8} — r`).join('\n');
    const { body, tangents } = splitTangents(`A.\n<tangents>\n${lines}\n</tangents>\nAfter.`);
    expect(body).toBe('A.\n\nAfter.');
    expect(tangents.map((t) => t.title)).toEqual(['T0', 'T1', 'T2', 'T3', 'T4', 'T5']);
  });

  it('is case-insensitive about the tag and tolerant of spaces', () => {
    const { tangents } = splitTangents('<Tangents >\n- One — two\n</TANGENTS>');
    expect(tangents).toEqual([{ title: 'One', why: 'two' }]);
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
    });
  });

  it('splits on an unspaced em dash too', () => {
    expect(parseTangentLine('- A—b')).toEqual({ title: 'A', why: 'b' });
  });
});

describe('formatTangents', () => {
  it('round-trips through splitTangents', () => {
    const tangents = [
      { title: 'One', why: 'because' },
      { title: 'Two', why: null },
    ];
    expect(splitTangents(`Body.\n\n${formatTangents(tangents)}`)).toEqual({
      body: 'Body.',
      tangents,
      partial: false,
    });
  });
});

describe('tangentsAsMarkdown', () => {
  it('rewrites the block as a plain "Where next?" list', () => {
    const reply = 'Body.\n\n<tangents>\n- Why ice floats — density\n- Heavy water\n</tangents>';
    expect(tangentsAsMarkdown(reply)).toBe(
      'Body.\n\n**Where next?**\n\n- **Why ice floats** — density\n- **Heavy water**',
    );
  });

  it('leaves replies without a block alone and drops an unfinished or empty one', () => {
    expect(tangentsAsMarkdown('Just text.\n')).toBe('Just text.\n');
    expect(tangentsAsMarkdown('Body.\n<tangents>\n- Half')).toBe('Body.');
    expect(tangentsAsMarkdown('Body.\n<tangents>\n</tangents>')).toBe('Body.');
    expect(tangentsAsMarkdown('<tangents>\n- Only\n</tangents>')).toBe(
      '**Where next?**\n\n- **Only**',
    );
  });
});
