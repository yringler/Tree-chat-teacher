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
});
