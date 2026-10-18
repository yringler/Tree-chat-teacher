// What OpenRouter charges against what Tangent computes: each model's reported cost
// next to the same tokens at the price credit holds it at (`creditPrice`), and the
// generation lookup the meter falls back on against the streamed cost. A hold assumes
// the reported cost never exceeds the price table's; the per-model ratio band says
// where each model's route sits against its list price.
import type { ContractExpectation } from '@tangent/providers/contract';
import { fetchOpenRouterGeneration } from '@tangent/providers';
import type { LlmProvider } from '@tangent/shared';
import { describe } from 'vitest';
import { RECONCILE_RETRY_DELAYS_MS } from '../../src/billing/reconcile.js';
import {
  builtInProvider,
  callWithRetry,
  creditProvider,
  liveKey,
  outcomeOf,
  priceOf,
  recompute,
  scenario,
  worstUsd,
} from './harness.js';

/** Reported over recomputed may exceed 1 by this much (rounding of tiny costs). */
const OVER_LIST_TOLERANCE = 1.02;
const ABSOLUTE_SLACK_USD = 2e-6;

interface ReconcileCase {
  model: string;
  provider: () => LlmProvider;
  /** Where reported/recomputed is expected to fall, and why. */
  ratio: { min: number; max: number; why: string };
}

const CASES: readonly ReconcileCase[] = [
  {
    model: 'deepseek/deepseek-v4.1-flash',
    provider: () => builtInProvider(),
    ratio: {
      min: 0.95,
      max: 1.02,
      why: 'pinned to StreamLake, whose price is the MODEL_PRICES entry',
    },
  },
  {
    model: 'google/gemini-3.1-flash-lite',
    provider: () => creditProvider(),
    ratio: {
      min: 0.85,
      max: 1.02,
      why: 'the model-level list price is the dearest route (Vertex, US) and others cost less',
    },
  },
  {
    model: 'anthropic/claude-haiku-5.5',
    provider: () => creditProvider(),
    ratio: { min: 0.95, max: 1.02, why: 'one price on every route' },
  },
];

const expectation: ContractExpectation = { outcome: 'success', costReport: 'openrouter' };

describe('cost reconciliation', () => {
  for (const c of CASES) {
    scenario(`reported against recomputed: ${c.model}`, 'openrouter', async () => {
      const price = await priceOf(c.model);
      const { summary } = await callWithRetry({
        provider: c.provider(),
        request: {
          model: c.model,
          system: 'You are a concise tutor.',
          messages: [{ role: 'user', content: 'Name three prime numbers, comma-separated.' }],
          maxOutputTokens: 1024,
        },
        worstUsd: worstUsd(price, 200, 1024),
      });
      const outcome = outcomeOf(c.model, summary, expectation);
      const recomputed = recompute(price, summary.usage);
      const reported = summary.billing.costUsd;
      if (recomputed === null || reported === undefined) return outcome;
      if (reported > recomputed * OVER_LIST_TOLERANCE + ABSOLUTE_SLACK_USD)
        outcome.failures.push(
          `reported $${reported} is over the price table's $${recomputed}: a hold priced from it can fall short`,
        );
      const ratio = recomputed > 0 ? reported / recomputed : 1;
      if (ratio < c.ratio.min || ratio > c.ratio.max)
        outcome.warnings.push(
          `ratio ${ratio.toFixed(3)} outside ${c.ratio.min}–${c.ratio.max} (${c.ratio.why})`,
        );

      // The meter's fallback when a stream ends without its cost: production's delays.
      const id = summary.billing.generationId;
      if (id) {
        let found = null;
        for (const delay of RECONCILE_RETRY_DELAYS_MS) {
          await new Promise((r) => setTimeout(r, delay));
          found = await fetchOpenRouterGeneration(id, liveKey('BUILT_IN_API_KEY')!);
          if (found) break;
        }
        if (!found) outcome.failures.push('the generation lookup found nothing in time');
        else if (Math.abs(found.costUsd - reported) > 1e-9)
          outcome.failures.push(
            `the generation lookup says $${found.costUsd}, the stream $${reported}`,
          );
      }
      return { ...outcome, recomputedUsd: recomputed };
    });
  }
});
