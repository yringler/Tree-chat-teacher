import '@angular/compiler'; // JIT: @tangent/web-shared pulls in partially compiled Angular code.
import { describe, expect, it } from 'vitest';
import { feeSentence } from './credit';

describe('feeSentence', () => {
  it('states the fees in one sentence', () => {
    expect(feeSentence({ openRouterFeeBps: 550, markupBps: 1000 })).toBe(
      "Each call costs the model's OpenRouter price + 5.5% OpenRouter fee + 10%, taken from your credit.",
    );
  });
});
