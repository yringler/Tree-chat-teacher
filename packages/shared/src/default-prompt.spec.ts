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

  it('asks for suggestions tagged [continue] or [tangent], with the classification rule', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain(
      "A suggestion is 'continue' if it advances the thread's main topic to its next step. It is 'tangent' if it clarifies something mentioned in the response or explores a related side topic. Anchor on the thread's original topic, not just the last response. Aim for roughly 1–2 continue and 2–4 tangent suggestions.",
    );
    expect(DEFAULT_SYSTEM_PROMPT).toContain('<tangents>\n- [continue] ');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('\n- [tangent] ');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('## Tangent context');
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/\bbranch/i);
  });
});
