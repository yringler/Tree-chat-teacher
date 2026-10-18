// Web search on the built-in provider as a reply's "Check sources" asks it: OpenRouter's
// server tool on the deployment's engine and result count, required, one use. Billing
// reads the search count from `server_tool_use_details` and expects the fee inside the
// reported cost.
import type { ContractExpectation } from '@tangent/providers/contract';
import type { ChatMessage } from '@tangent/shared';
import { describe } from 'vitest';
import { appConfig } from '../../src/config.js';
import {
  builtInProvider,
  callWithRetry,
  env,
  outcomeOf,
  priceOf,
  recompute,
  recorded,
  scenario,
  SEARCH_ALLOWANCE_USD,
  worstUsd,
} from './harness.js';

/**
 * What a reply's search adds to its cost, USD, at the deployment's engine and result
 * count: about $0.007 for Exa at 5 results when this was pinned (2026-10), the same
 * whether OpenRouter reported one search or two.
 */
const SEARCH_FEE_BAND = { min: 0.004, max: 0.012 };

describe('openrouter web search', () => {
  const provider = builtInProvider();
  const model = provider.defaultModel();

  scenario('a required search, one use', 'openrouter', async () => {
    const expectation: ContractExpectation = {
      outcome: 'success',
      search: { maxUses: 1 },
      costReport: 'openrouter',
    };
    const price = await priceOf(model);
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content:
          'What is the latest stable release of Node.js? Answer in one sentence and cite your source.',
      },
    ];
    const { summary } = await recorded(
      { adapter: 'openrouter', name: 'search', model, expectation },
      () =>
        callWithRetry({
          provider,
          request: {
            model,
            system: 'You are a concise tutor.',
            messages,
            maxOutputTokens: 4096,
            webSearch: { mode: 'required', maxUses: 1 },
          },
          worstUsd: worstUsd(price, 20_000, 4096) + SEARCH_ALLOWANCE_USD,
        }),
    );
    const outcome = outcomeOf(model, summary, expectation);
    const tokens = recompute(price, summary.usage);
    const reported = summary.billing.costUsd;
    const { engine, maxResults } = appConfig(env).grounding;
    const searches = summary.billing.webSearches ?? 0;
    if (tokens !== null && reported !== undefined && searches > 0) {
      const fee = reported - tokens;
      outcome.notes = [
        `search fee $${fee.toFixed(6)} for ${searches} reported searches (${engine}, ${maxResults} results)`,
      ];
      if (fee < SEARCH_FEE_BAND.min || fee > SEARCH_FEE_BAND.max)
        outcome.failures.push(
          `the search added $${fee.toFixed(6)}, outside $${SEARCH_FEE_BAND.min}–$${SEARCH_FEE_BAND.max}: is the fee still in the reported cost, at the same rate?`,
        );
    }
    if (summary.searchActivity === 0)
      outcome.warnings.push('no search activity event (the stream had no web_search tool call)');
    return { ...outcome, recomputedUsd: tokens };
  });
});
