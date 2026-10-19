// Anthropic's and OpenAI's own APIs through power's own-key providers (the default
// configs on the server's keys, as the dev bypass reaches them). Without a key for
// one, its scenarios are SKIPPED, except a wrong key's refusal, which needs none.
// Neither reports a cost: own keys are never metered.
import type { ContractExpectation } from '@tangent/providers/contract';
import type { ChatMessage, GenerateRequest } from '@tangent/shared';
import { describe } from 'vitest';
import {
  BAD_KEYS,
  cachePrefix,
  cacheWarnings,
  callWithRetry,
  env,
  liveKey,
  liveSecrets,
  outcomeOf,
  powerProvider,
  priceOf,
  recompute,
  recorded,
  scenario,
  SEARCH_ALLOWANCE_USD,
  worstUsd,
  type Outcome,
} from './harness.js';

interface Direct {
  adapter: 'anthropic' | 'openai';
  secret: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY';
  model: string;
  /** The same model on OpenRouter, whose list price bounds the budget and the recompute. */
  listedAs: string;
  /** How the API answers a model it doesn't have. */
  unknownModelStatus: number;
}

const DIRECTS: readonly Direct[] = [
  {
    adapter: 'anthropic',
    secret: 'ANTHROPIC_API_KEY',
    model: 'claude-haiku-5-5',
    listedAs: 'anthropic/claude-haiku-5.5',
    unknownModelStatus: 404,
  },
  {
    adapter: 'openai',
    secret: 'OPENAI_API_KEY',
    model: 'gpt-5-mini',
    listedAs: 'openai/gpt-5-mini',
    unknownModelStatus: 404,
  },
];

const ask = (content: string): ChatMessage[] => [{ role: 'user', content }];
const SYSTEM = 'You are a concise tutor.';

for (const d of DIRECTS) {
  describe(`${d.adapter} (direct)`, () => {
    const skip = liveKey(d.secret) ? null : `no TANGENT_LIVE_${d.adapter.toUpperCase()}_KEY`;
    const success = (extra: Partial<ContractExpectation> = {}): ContractExpectation => ({
      outcome: 'success',
      costReport: 'none',
      ...extra,
    });

    async function run(
      request: Omit<GenerateRequest, 'signal'>,
      expectation: ContractExpectation,
      opts: {
        inputTokens?: number;
        extraUsd?: number;
        fixture?: string;
        abortEarly?: boolean;
      } = {},
    ): Promise<Outcome> {
      const price = await priceOf(d.listedAs);
      const call = () =>
        callWithRetry({
          provider: powerProvider(d.adapter),
          request,
          worstUsd:
            worstUsd(price, opts.inputTokens ?? 200, request.maxOutputTokens ?? 1024) +
            (opts.extraUsd ?? 0),
          ...(opts.abortEarly ? { abortEarly: true } : {}),
        });
      const { summary } = opts.fixture
        ? await recorded(
            { adapter: d.adapter, name: opts.fixture, model: request.model, expectation },
            call,
          )
        : await call();
      return {
        ...outcomeOf(request.model, summary, expectation),
        recomputedUsd: recompute(price, summary.usage),
      };
    }

    scenario(
      'basic reply',
      d.adapter,
      () =>
        run(
          {
            model: d.model,
            system: SYSTEM,
            messages: ask('Say hello in one short sentence.'),
            maxOutputTokens: 1024,
          },
          success(),
          { fixture: 'basic' },
        ),
      { skip },
    );

    scenario(
      'cut off at the output cap',
      d.adapter,
      () =>
        run(
          {
            model: d.model,
            system: SYSTEM,
            messages: ask('Count from 1 to 200, one number per line.'),
            maxOutputTokens: 16,
          },
          success({ stop: 'length' }),
          { fixture: 'length' },
        ),
      { skip },
    );

    scenario('a wrong key is refused', d.adapter, async () => {
      const expectation: ContractExpectation = {
        outcome: 'error',
        error: { code: 'auth', upstream: 'rejected', status: 401 },
      };
      const { summary } = await recorded(
        { adapter: d.adapter, name: 'bad-key', model: d.model, expectation },
        () =>
          callWithRetry({
            provider: powerProvider(d.adapter, { ...env, [d.secret]: BAD_KEYS[d.adapter] }),
            request: {
              model: d.model,
              system: SYSTEM,
              messages: ask('Hello'),
              maxOutputTokens: 16,
            },
            worstUsd: 0,
          }),
      );
      return outcomeOf(d.model, summary, expectation, [BAD_KEYS[d.adapter], ...liveSecrets()]);
    });

    scenario(
      'an unknown model is refused',
      d.adapter,
      () =>
        run(
          {
            model: 'tangent-live-no-such-model',
            system: SYSTEM,
            messages: ask('Hello'),
            maxOutputTokens: 16,
          },
          {
            outcome: 'error',
            error: { code: 'invalid_request', upstream: 'rejected', status: d.unknownModelStatus },
          },
          { fixture: 'bad-model' },
        ),
      { skip },
    );

    scenario(
      'an aborted call ends promptly',
      d.adapter,
      () =>
        run(
          {
            model: d.model,
            system: SYSTEM,
            messages: ask('Name three prime numbers.'),
            maxOutputTokens: 1024,
          },
          { outcome: 'error', error: { code: 'aborted' } },
          { abortEarly: true },
        ),
      { skip },
    );

    if (d.adapter === 'anthropic') {
      scenario(
        'cache_control: a write, then a read',
        d.adapter,
        async () => {
          const request = {
            model: d.model,
            system: cachePrefix(5000),
            messages: ask('What is 7 times 7? Answer with the number.'),
            maxOutputTokens: 64,
          };
          const first = await run(request, success(), { inputTokens: 14_000 });
          const second = await run(request, success(), { inputTokens: 14_000 });
          return {
            ...second,
            failures: [...first.failures, ...second.failures],
            warnings: [
              ...first.warnings,
              ...second.warnings,
              ...cacheWarnings(first, second, true),
            ],
          };
        },
        { skip },
      );

      // Anthropic's models reject a forced tool choice, so a search is offered and asked for.
      scenario(
        'native web search, one use',
        d.adapter,
        () =>
          run(
            {
              model: d.model,
              system: SYSTEM,
              messages: ask(
                'Search the web: what is the latest stable release of Node.js? Cite your source.',
              ),
              maxOutputTokens: 1024,
              webSearch: { mode: 'auto', maxUses: 1 },
            },
            success({ search: { maxUses: 1 } }),
            { inputTokens: 20_000, extraUsd: SEARCH_ALLOWANCE_USD, fixture: 'search' },
          ),
        { skip },
      );
    }
  });
}
