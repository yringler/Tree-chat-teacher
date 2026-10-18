// OpenRouter through the built-in provider exactly as Learn on credit asks it (Normal's
// model, effort and pinned providers, the operator's key): the stream contract on a
// plain reply, a reply cut off at its cap, refusals, an abort, and the prompt cache.
import type { ContractExpectation } from '@tangent/providers/contract';
import { fetchOpenRouterGeneration } from '@tangent/providers';
import type { ChatMessage } from '@tangent/shared';
import { describe } from 'vitest';
import { RECONCILE_RETRY_DELAYS_MS } from '../../src/billing/reconcile.js';
import {
  BAD_KEYS,
  builtInProvider,
  callWithRetry,
  creditProvider,
  env,
  liveKey,
  liveSecrets,
  outcomeOf,
  priceOf,
  recompute,
  recorded,
  scenario,
  worstUsd,
  type Outcome,
} from './harness.js';

const ask = (content: string): ChatMessage[] => [{ role: 'user', content }];
const SYSTEM = 'You are a concise tutor.';

/**
 * A prompt prefix of about `tokens` tokens, the same on every call, so a second call
 * can read what the first wrote to the prompt cache.
 */
export function cachePrefix(tokens: number): string {
  const facts: string[] = [];
  for (let i = 1; facts.length * 12 < tokens; i++)
    facts.push(`Fact ${i}: ${i} times ${i} is ${i * i}, and ${i} plus ${i} is ${i + i}.`);
  return `You are a concise tutor. Reference table:\n${facts.join('\n')}`;
}

/** A soft check: the second of two identical calls read from the prompt cache. */
export function cacheWarnings(first: Outcome, second: Outcome, explicit: boolean): string[] {
  const warnings: string[] = [];
  if (explicit && (first.summary?.usage.cacheWriteTokens ?? 0) === 0)
    warnings.push('the first call reported no cache write');
  if ((second.summary?.usage.cacheReadTokens ?? 0) === 0)
    warnings.push('the second call read nothing from the prompt cache');
  return warnings;
}

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
          messages: ask('Write a long essay about the history of zero.'),
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
      // As the meter's reconcile does: production's delays, until OpenRouter has the generation.
      let found = null;
      for (const delay of RECONCILE_RETRY_DELAYS_MS) {
        await new Promise((r) => setTimeout(r, delay));
        found = await fetchOpenRouterGeneration(id, liveKey('BUILT_IN_API_KEY')!);
        if (found) break;
      }
      if (!found) outcome.failures.push('the generation was not found within the reconcile delays');
      else
        outcome.notes = [
          `lookup: $${found.costUsd.toFixed(6)}, ${found.inputTokens}/${found.outputTokens} tokens, cancelled ${found.cancelled}`,
        ];
      return { ...outcome, recomputedUsd: null };
    },
  );

  scenario('the prompt cache: a second identical call reads it', 'openrouter', async () => {
    const price = await priceOf(model);
    const system = cachePrefix(3000);
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
        worstUsd: worstUsd(price, 3500, 1024),
      });
    const expectation: ContractExpectation = { outcome: 'success', costReport: 'openrouter' };
    const first = outcomeOf(model, (await run()).summary, expectation);
    const second = outcomeOf(model, (await run()).summary, expectation);
    return {
      ...second,
      failures: [...first.failures, ...second.failures],
      warnings: [...first.warnings, ...second.warnings, ...cacheWarnings(first, second, false)],
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
