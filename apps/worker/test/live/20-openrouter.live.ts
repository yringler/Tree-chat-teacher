// OpenRouter through the built-in provider exactly as Learn on credit asks it (Normal's
// model, effort and pinned providers, the operator's key): the stream contract on a
// plain reply, a reply cut off at its cap, refusals, an abort, and the prompt cache.
import { usesExplicitCacheControl } from '@tangent/providers';
import type { ContractExpectation } from '@tangent/providers/contract';
import type { ChatMessage } from '@tangent/shared';
import { describe } from 'vitest';
import {
  BAD_KEYS,
  cachePrefix,
  cacheWarnings,
  builtInProvider,
  callWithRetry,
  creditProvider,
  env,
  lookUpGeneration,
  liveSecrets,
  outcomeOf,
  priceOf,
  recompute,
  recorded,
  scenario,
  worstUsd,
} from './harness.js';

const ask = (content: string): ChatMessage[] => [{ role: 'user', content }];
const SYSTEM = 'You are a concise tutor.';

describe('openrouter (built-in provider)', () => {
  const provider = builtInProvider();
  const model = provider.defaultModel();

  scenario('basic reply', 'openrouter', async () => {
    const expectation: ContractExpectation = { outcome: 'success', costReport: 'openrouter' };
    const price = await priceOf(model);
    const { summary } = await recorded(
      { adapter: 'openrouter', name: 'basic', model, expectation },
      () =>
        callWithRetry({
          provider,
          request: {
            model,
            system: SYSTEM,
            messages: ask('Say hello in one short sentence.'),
            maxOutputTokens: 4096,
          },
          worstUsd: worstUsd(price, 100, 4096),
        }),
    );
    const outcome = outcomeOf(model, summary, expectation);
    if (summary.terminal?.type === 'done' && summary.terminal.stopReason === 'length')
      outcome.warnings.push('the reply was cut off at 4,096 tokens');
    return { ...outcome, recomputedUsd: recompute(price, summary.usage) };
  });

  scenario('cut off at the output cap', 'openrouter', async () => {
    const expectation: ContractExpectation = {
      outcome: 'success',
      stop: 'length',
      costReport: 'openrouter',
    };
    const price = await priceOf(model);
    const { summary } = await recorded(
      { adapter: 'openrouter', name: 'length', model, expectation },
      () =>
        callWithRetry({
          provider,
          request: {
            model,
            system: SYSTEM,
            messages: ask('Count from 1 to 200, one number per line.'),
            maxOutputTokens: 16,
          },
          worstUsd: worstUsd(price, 100, 16),
        }),
    );
    return {
      ...outcomeOf(model, summary, expectation),
      recomputedUsd: recompute(price, summary.usage),
    };
  });

  scenario('a wrong key is refused', 'openrouter', async () => {
    const expectation: ContractExpectation = {
      outcome: 'error',
      error: { code: 'auth', upstream: 'rejected', status: 401 },
    };
    const bad = builtInProvider({ ...env, BUILT_IN_API_KEY: BAD_KEYS.openrouter });
    const { summary } = await recorded(
      { adapter: 'openrouter', name: 'bad-key', model, expectation },
      () =>
        callWithRetry({
          provider: bad,
          request: { model, system: SYSTEM, messages: ask('Hello'), maxOutputTokens: 16 },
          worstUsd: 0,
        }),
    );
    return outcomeOf(model, summary, expectation, [BAD_KEYS.openrouter, ...liveSecrets()]);
  });

  scenario('an unknown model is refused', 'openrouter', async () => {
    const unknown = 'tangent-live/no-such-model';
    const expectation: ContractExpectation = {
      outcome: 'error',
      error: { code: 'invalid_request', upstream: 'rejected', status: 400 },
    };
    const { summary } = await recorded(
      { adapter: 'openrouter', name: 'bad-model', model: unknown, expectation },
      () =>
        callWithRetry({
          provider,
          request: { model: unknown, system: SYSTEM, messages: ask('Hello'), maxOutputTokens: 16 },
          worstUsd: 0,
        }),
    );
    return outcomeOf(unknown, summary, expectation);
  });

  scenario(
    'an aborted call ends promptly and is billed by its generation',
    'openrouter',
    async () => {
      const expectation: ContractExpectation = { outcome: 'error', error: { code: 'aborted' } };
      const price = await priceOf(model);
      const { summary } = await callWithRetry({
        provider,
        request: {
          model,
          system: SYSTEM,
          messages: ask('Name three prime numbers.'),
          maxOutputTokens: 2048,
        },
        worstUsd: worstUsd(price, 100, 2048),
        abortEarly: true,
      });
      const outcome = outcomeOf(model, summary, expectation);
      const id = summary.billing.generationId;
      if (!id) {
        outcome.failures.push(
          'no generation id before the abort: the call could not be reconciled',
        );
        return outcome;
      }
      const lookup = await lookUpGeneration(id);
      if (!lookup.cost)
        outcome.failures.push(
          `OpenRouter never returned the aborted generation: its cost can't be known`,
        );
      else {
        if (!lookup.inTime)
          outcome.warnings.push(
            `found after ${Math.round(lookup.afterMs / 1000)} s, past the meter's own lookups`,
          );
        outcome.notes = [
          `lookup after ${Math.round(lookup.afterMs / 1000)} s: $${lookup.cost.costUsd.toFixed(6)}, ${lookup.cost.inputTokens}/${lookup.cost.outputTokens} tokens, cancelled ${lookup.cost.cancelled}`,
        ];
      }
      return { ...outcome, recomputedUsd: null };
    },
  );

  scenario('the prompt cache: a second identical call reads it', 'openrouter', async () => {
    const price = await priceOf(model);
    // Above every default model's minimum cacheable prefix (Haiku's included).
    const system = cachePrefix(5000);
    const run = () =>
      callWithRetry({
        provider,
        request: {
          model,
          system,
          messages: ask('What is 7 times 7? Answer with the number.'),
          maxOutputTokens: 1024,
          reasoning: 'low',
        },
        worstUsd: worstUsd(price, 6000, 1024),
      });
    const expectation: ContractExpectation = { outcome: 'success', costReport: 'openrouter' };
    const first = outcomeOf(model, (await run()).summary, expectation);
    const second = outcomeOf(model, (await run()).summary, expectation);
    return {
      ...second,
      failures: [...first.failures, ...second.failures],
      warnings: [
        ...first.warnings,
        ...second.warnings,
        ...cacheWarnings(first, second, usesExplicitCacheControl(model)),
      ],
      recomputedUsd: recompute(price, second.summary!.usage),
    };
  });
});

describe('openrouter (explicit cache markers)', () => {
  // A model that caches only with `cache_control` breakpoints, through power's credit.
  const model = 'anthropic/claude-haiku-5.5';
  const provider = creditProvider();

  scenario('cache_control: a write, then a read', 'openrouter', async () => {
    const price = await priceOf(model);
    const system = cachePrefix(5000);
    const run = () =>
      callWithRetry({
        provider,
        request: {
          model,
          system,
          messages: ask('What is 7 times 7? Answer with the number.'),
          maxOutputTokens: 64,
        },
        worstUsd: worstUsd(price, 6000, 64),
      });
    const expectation: ContractExpectation = { outcome: 'success', costReport: 'openrouter' };
    const first = outcomeOf(model, (await run()).summary, expectation);
    const second = outcomeOf(model, (await run()).summary, expectation);
    return {
      ...second,
      failures: [...first.failures, ...second.failures],
      warnings: [...first.warnings, ...second.warnings, ...cacheWarnings(first, second, true)],
      notes: [`first call: ${first.summary?.usage.cacheWriteTokens ?? 0} tokens written`],
      recomputedUsd: recompute(price, second.summary!.usage),
    };
  });
});
