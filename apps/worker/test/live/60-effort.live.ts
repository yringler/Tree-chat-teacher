// Reasoning effort as each endpoint takes it (`providerTraits(...).effort`): low and high
// both succeed and high thinks at least as much (soft: a model may think little either
// way). On OpenRouter, Gemini can't turn thinking off, so `none` is refused: pinned here
// so the day it starts passing, the note in openai-compatible.ts gets revisited. Gemini's
// implicit prompt cache, above and below its minimum prefix, is a soft check.
import type { ContractExpectation } from '@tangent/providers/contract';
import type { LlmProvider, ReasoningEffort } from '@tangent/shared';
import { describe } from 'vitest';
import {
  builtInProvider,
  cachePrefix,
  cacheWarnings,
  callWithRetry,
  creditProvider,
  liveKey,
  outcomeOf,
  powerProvider,
  priceOf,
  recompute,
  scenario,
  worstUsd,
  type Outcome,
} from './harness.js';

const success: ContractExpectation = { outcome: 'success' };
const PUZZLE = 'How many prime numbers are there below 60? Reply with the number only.';

async function atEffort(
  provider: LlmProvider,
  model: string,
  listedAs: string,
  effort: ReasoningEffort,
  expectation: ContractExpectation,
): Promise<Outcome> {
  const price = await priceOf(listedAs);
  const { summary } = await callWithRetry({
    provider,
    request: {
      model,
      system: 'You are a careful tutor.',
      messages: [{ role: 'user', content: PUZZLE }],
      maxOutputTokens: 4096,
      reasoning: effort,
    },
    worstUsd: worstUsd(price, 100, 4096),
  });
  return {
    ...outcomeOf(model, summary, expectation),
    recomputedUsd: recompute(price, summary.usage),
  };
}

/** Low, then high: both succeed, and high reasons at least as much (soft). */
async function lowThenHigh(
  provider: LlmProvider,
  model: string,
  listedAs: string,
  expectation: ContractExpectation,
): Promise<Outcome> {
  const low = await atEffort(provider, model, listedAs, 'low', expectation);
  const high = await atEffort(provider, model, listedAs, 'high', expectation);
  const reasoning = (o: Outcome) =>
    o.summary?.usage.reasoningTokens ?? o.summary?.usage.outputTokens ?? 0;
  const warnings = [...low.warnings, ...high.warnings];
  if (reasoning(high) < reasoning(low))
    warnings.push(`high reasoned less than low (${reasoning(high)} < ${reasoning(low)} tokens)`);
  return {
    ...high,
    failures: [...low.failures, ...high.failures],
    warnings,
    notes: [`reasoning tokens: low ${reasoning(low)}, high ${reasoning(high)}`],
  };
}

describe('reasoning effort', () => {
  scenario('openrouter: low and high', 'openrouter', () => {
    const provider = builtInProvider();
    const model = provider.defaultModel();
    return lowThenHigh(provider, model, model, { ...success, costReport: 'openrouter' });
  });

  /** Implicit caching, and a reasoning switch it accepts. */
  const GEMINI = 'google/gemini-3.1-flash-lite';
  /** The cheapest Gemini whose thinking can't be turned off (2026-10). */
  const GEMINI_ALWAYS_THINKING = 'google/gemini-3.5-flash-lite';

  scenario('openrouter: Gemini refuses effort none', 'openrouter', async () => {
    const model = GEMINI_ALWAYS_THINKING;
    const outcome = await atEffort(creditProvider(), model, model, 'none', {
      outcome: 'error',
      error: { code: 'invalid_request', upstream: 'rejected', status: 400 },
    });
    if (outcome.summary?.terminal?.type === 'done')
      outcome.failures = [
        `${model} now accepts reasoning {enabled: false}: revisit reasoningBody's note in packages/providers/src/openai-compatible.ts and this pin`,
      ];
    return outcome;
  });

  for (const [label, tokens, expectRead] of [
    ['below', 1000, false],
    ['above', 6000, true],
  ] as const) {
    scenario(
      `openrouter: Gemini's implicit cache ${label} its minimum prefix`,
      'openrouter',
      async () => {
        const provider = creditProvider();
        const price = await priceOf(GEMINI);
        const run = async () =>
          outcomeOf(
            GEMINI,
            (
              await callWithRetry({
                provider,
                request: {
                  model: GEMINI,
                  system: cachePrefix(tokens),
                  messages: [
                    { role: 'user', content: 'What is 7 times 7? Answer with the number.' },
                  ],
                  maxOutputTokens: 256,
                },
                worstUsd: worstUsd(price, tokens * 3, 256),
              })
            ).summary,
            { ...success, costReport: 'openrouter' },
          );
        const first = await run();
        const second = await run();
        const read = second.summary?.usage.cacheReadTokens ?? 0;
        const warnings = [...first.warnings, ...second.warnings];
        if (expectRead) warnings.push(...cacheWarnings(first, second, false));
        else if (read > 0) warnings.push(`read ${read} tokens from the cache below the minimum`);
        return {
          ...second,
          failures: [...first.failures, ...second.failures],
          warnings,
          recomputedUsd: recompute(price, second.summary!.usage),
        };
      },
    );
  }

  scenario(
    'anthropic: low and high',
    'anthropic',
    () =>
      lowThenHigh(powerProvider('anthropic'), 'claude-haiku-4-5', 'anthropic/claude-haiku-4.5', {
        ...success,
        costReport: 'none',
      }),
    { skip: liveKey('ANTHROPIC_API_KEY') ? null : 'no TANGENT_LIVE_ANTHROPIC_KEY' },
  );

  scenario(
    'openai: low and high',
    'openai',
    () =>
      lowThenHigh(powerProvider('openai'), 'gpt-5-mini', 'openai/gpt-5-mini', {
        ...success,
        costReport: 'none',
      }),
    { skip: liveKey('OPENAI_API_KEY') ? null : 'no TANGENT_LIVE_OPENAI_KEY' },
  );
});
