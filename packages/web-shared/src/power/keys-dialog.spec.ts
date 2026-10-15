import '@angular/compiler'; // JIT: the dialog's module imports the router, which links on load.
import { describe, expect, it } from 'vitest';
import { creditFeeSentence } from './keys-dialog';

describe('Keys & credit dialog', () => {
  it('says what a credit call costs in one sentence', () => {
    expect(creditFeeSentence({ serviceFee: { bps: 2000, fixedCents: 50 } })).toBe(
      "Each call costs the model's OpenRouter list price (each top-up adds a 20% + 50¢ service fee), taken from your credit.",
    );
  });
});
