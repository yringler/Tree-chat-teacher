import { describe, expect, it } from 'vitest';
import { CHECK_SOURCES_INSTRUCTIONS, GROUNDING_INSTRUCTIONS } from './grounding.js';

describe('search instructions', () => {
  it('ask for citations as Markdown links, never HTML, which the renderer shows as text', () => {
    for (const instructions of [GROUNDING_INSTRUCTIONS, CHECK_SOURCES_INSTRUCTIONS]) {
      expect(instructions).toContain(
        'like [en.wikipedia.org](https://en.wikipedia.org/wiki/Example), never an HTML <a> tag.',
      );
    }
  });
});
