import '@angular/compiler'; // JIT: the dialog's module imports the router, which links on load.
import { describe, expect, it } from 'vitest';
import { creditFeeSentence } from './keys-dialog';

describe('Keys & credit dialog', () => {
  it('says what a credit call costs in one sentence', () => {
    expect(creditFeeSentence({ openRouterFeeBps: 550, markupBps: 1000 })).toBe(
      "Each call costs the model's OpenRouter price + 5.5% OpenRouter fee + 10%, taken from your credit.",
    );
  });
});
