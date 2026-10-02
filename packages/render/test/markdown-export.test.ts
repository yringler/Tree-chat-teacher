import { describe, expect, it } from 'vitest';
import { payloadToMarkdown } from '../src/markdown-export.js';
import { samplePayload } from './fixture.js';

describe('payloadToMarkdown', () => {
  const md = payloadToMarkdown(samplePayload());

  it('starts with the title', () => {
    expect(md.startsWith('# Trees & "Branches" <script>alert(1)</script>\n\n')).toBe(true);
  });

  it('puts ancestor context in a details block before the branches', () => {
    expect(md).toContain(
      '<details>\n<summary>Earlier context</summary>\n\n**User:**\n\nCONTEXTQ earlier question\n\n**Assistant:**\n\nCONTEXTA earlier answer\n\n</details>',
    );
    expect(md.indexOf('</details>')).toBeLessThan(md.indexOf('## Trunk'));
    expect(payloadToMarkdown(samplePayload({ context: null }))).not.toContain('<details>');
  });

  it('emits branches depth-first with breadcrumb headings', () => {
    const headings = md.split('\n').filter((l) => l.startsWith('## '));
    expect(headings).toEqual([
      '## Trunk',
      '## Trunk › Side <b>topic</b>',
      '## Trunk › Side <b>topic</b> › Deep',
      '## Trunk › Other',
      '## Trunk › Late',
    ]);
  });

  it('adds a forked-from excerpt and the anchor quote', () => {
    const side = md.slice(
      md.indexOf('## Trunk › Side'),
      md.indexOf('## Trunk › Side <b>topic</b> › Deep'),
    );
    expect(side).toContain('Forked from: “CONTENTA1 Like this: const x: number = 1;”');
    expect(side).toContain('> ANCHORQ the "quote" <i>');
    expect(side.indexOf('Forked from')).toBeLessThan(side.indexOf('> ANCHORQ'));
    expect(side.indexOf('> ANCHORQ')).toBeLessThan(side.indexOf('**User:**'));
    expect(md).not.toMatch(/## Trunk\n\nForked from/);
  });

  it('emits message content verbatim', () => {
    expect(md).toContain('**User:**\n\n# CONTENTQ1 How do *trees* work?');
    expect(md).toContain(
      '**Assistant:**\n\nCONTENTA1 Like this:\n\n```ts\nconst x: number = 1;\n```',
    );
    expect(md).toContain('CONTENTQ2 <script>alert("x")</script>');
  });

  it('marks empty branches and ends with a newline', () => {
    expect(md).toContain(
      '## Trunk › Other\n\nForked from: “CONTENTA1 Like this: const x: number = 1;”\n\n_(no messages)_',
    );
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });

  it('truncates long fork excerpts', () => {
    const p = samplePayload();
    const trunk = p.branches[0];
    const m3 = trunk?.messages[1];
    if (m3) m3.content = 'word '.repeat(50);
    const out = payloadToMarkdown(p);
    const line = out.split('\n').find((l) => l.startsWith('Forked from:')) ?? '';
    expect(line.endsWith('…”')).toBe(true);
    expect(Array.from(line).length).toBeLessThanOrEqual('Forked from: “”'.length + 80);
  });

  it('prefixes every line of a multi-line anchor quote', () => {
    const p = samplePayload();
    const side = p.branches[1];
    if (side) side.anchorQuote = 'line one\n\nline two';
    expect(payloadToMarkdown(p)).toContain('> line one\n>\n> line two');
  });
});

describe('tangents in shared replies', () => {
  const reply =
    'The answer.\n\n<tangents>\n- Why ice floats — density again\n- Heavy water\n</tangents>';
  const payload = samplePayload({
    context: null,
    branches: [
      {
        key: 'b0',
        parentKey: null,
        forkMessageKey: null,
        title: 'Trunk',
        anchorQuote: null,
        messages: [
          { key: 'm0', role: 'user', content: 'Q <tangents>\n- kept\n</tangents>' },
          { key: 'm1', role: 'assistant', content: reply },
        ],
      },
      {
        key: 'b1',
        parentKey: 'b0',
        forkMessageKey: 'm1',
        title: 'Why ice floats',
        anchorQuote: null,
        messages: [{ key: 'm2', role: 'user', content: 'Why ice floats' }],
      },
    ],
  });

  it('turns the block into a "Where next?" list and keeps it out of fork excerpts', () => {
    const md = payloadToMarkdown(payload);
    expect(md).toContain(
      '**Assistant:**\n\nThe answer.\n\n**Where next?**\n\n- **Why ice floats** — density again\n- **Heavy water**',
    );
    expect(md).not.toContain('<tangents>\n- Why');
    expect(md).toContain('Forked from: “The answer.”');
    // Only assistant replies carry tangents; user text stays verbatim.
    expect(md).toContain('Q <tangents>\n- kept\n</tangents>');
  });
});
