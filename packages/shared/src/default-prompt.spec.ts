import { describe, expect, it } from 'vitest';
import { DEFAULT_SYSTEM_PROMPT } from './default-prompt.js';

describe('DEFAULT_SYSTEM_PROMPT', () => {
  it('asks the tutor to say when it is unsure of a specific fact, among the answer rules', () => {
    const guardrail =
      "- If you aren't confident about a specific fact (a name, date, number, quotation or citation), say so explicitly instead of guessing.";
    expect(DEFAULT_SYSTEM_PROMPT).toContain(
      `Never invent facts, sources or quotations.\n${guardrail}\n`,
    );
    // Stable text: nothing in the prompt varies per request (prompt caching).
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/\{\{|\$\{|\b20\d\d-\d\d-\d\d\b/);
  });

  it('offers a specific diagram after the Markdown rule, and draws one only when asked', () => {
    const markdown =
      "- Use Markdown sparingly: short lists when they help, code blocks for code. Reply in the user's language.\n";
    const diagrams = DEFAULT_SYSTEM_PROMPT.slice(
      DEFAULT_SYSTEM_PROMPT.indexOf(markdown) + markdown.length,
    );
    expect(diagrams).toMatch(/^- Don't draw diagrams unprompted\./);
    const rule = diagrams.slice(0, diagrams.indexOf('\n'));
    expect(rule).toContain('before the tangents');
    expect(rule).toContain('Never ask a bare "Want a diagram?"');
    expect(rule).toContain(
      'a single ```mermaid code block, using flowchart, sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, pie, gantt, timeline or mindmap.',
    );
    expect(rule).toContain('write a double quote inside a label as #quot;');
  });

  it('asks for suggestions tagged [deeper] or [tangent], each opening a tangent', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('Following any of them opens a tangent');
    expect(DEFAULT_SYSTEM_PROMPT).toContain(
      'Aim for roughly 1–3 deeper and 2–4 tangent suggestions.',
    );
    expect(DEFAULT_SYSTEM_PROMPT).toContain('<tangents>\n- [deeper] ');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('\n- [tangent] ');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('## Tangent context');
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/\bbranch/i);
  });

  it('keeps suggestion titles and reasons plain text, with Unicode for symbols', () => {
    const rule = DEFAULT_SYSTEM_PROMPT.slice(
      DEFAULT_SYSTEM_PROMPT.indexOf('Each suggestion is one line'),
      DEFAULT_SYSTEM_PROMPT.indexOf('Format them exactly like this'),
    );
    expect(rule).toContain('no TeX, dollar signs or Markdown');
    expect(rule).toContain('"d/dx xⁿ"');
  });
});
