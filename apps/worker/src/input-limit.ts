// Power's input limit and reply length (@tangent/shared input-limit.ts,
// output-tokens.ts), as a send or a Context preview runs with them: the
// user's settings, sent with each request, clamped here and in ChatService
// `budgetFor` (never above the model's window less the reply). On Tangent
// credit the input is also capped at Learn's SIMPLE_MAX_INPUT_TOKENS, with
// or without a setting, so one credit call costs at most what Learn's does.
// Learn ignores the settings: its own caps apply (simple-mode.ts).
import type { ChatService, GenerationLimits } from '@tangent/core';
import type { BranchFunding, ContextLimitsQuery, InputBudgetResponse } from '@tangent/shared';
import type { AccountContext, AppEnv } from './env.js';
import { modelPrice } from './pool/model-prices.js';
import { simpleMaxInputTokens } from './simple-mode.js';

/** USD per million tokens, from the price table's micro-USD per million. */
const MICROS_PER_USD = 1_000_000;

/**
 * The most input the server sends on a route whatever the user's setting:
 * Tangent credit's cap in power; null on the user's own key, where only the
 * model's window bounds it, and in Learn, whose settings carry its own.
 */
export function serverInputCap(
  env: AppEnv,
  account: AccountContext,
  funding: BranchFunding,
): number | null {
  return account.mode === 'power' && funding === 'credit' ? simpleMaxInputTokens(env) : null;
}

/**
 * The limits a power send or preview on a `funding` route runs with: the
 * requested ones (only those given; a `compact` overflow is the default),
 * with the input limit within `serverInputCap`. Learn: none.
 */
export function generationLimits(
  env: AppEnv,
  account: AccountContext,
  funding: BranchFunding,
  requested: ContextLimitsQuery,
): GenerationLimits {
  if (account.mode !== 'power') return {};
  const cap = serverInputCap(env, account, funding);
  const input = Math.min(requested.maxInputTokens ?? Infinity, cap ?? Infinity);
  return {
    ...(requested.maxOutputTokens !== undefined
      ? { maxOutputTokens: requested.maxOutputTokens }
      : {}),
    ...(Number.isFinite(input) ? { maxInputTokens: input } : {}),
    ...(requested.inputOverflow === 'truncate' ? { inputOverflow: 'truncate' as const } : {}),
  };
}

/** Only the limits of `value` (a request body that carries them). */
export function pickLimits(value: GenerationLimits): GenerationLimits {
  const { maxOutputTokens, maxInputTokens, inputOverflow } = value;
  return {
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
    ...(inputOverflow !== undefined ? { inputOverflow } : {}),
  };
}

/**
 * `GET /api/branches/:id/input-budget`: what bounds a message's input on the
 * branch (ChatService `inputBudget`), the server's cap, and the model's list
 * price when the price table has one (OpenRouter's, `modelPrice`; a failed
 * read is no price).
 */
export async function inputBudgetResponse(
  env: AppEnv,
  account: AccountContext,
  chat: ChatService,
  branchId: string,
): Promise<InputBudgetResponse> {
  const budget = await chat.inputBudget(branchId);
  const caps = [budget.maxInputTokens, serverInputCap(env, account, budget.funding)].filter(
    (n): n is number => n !== null,
  );
  const price = await modelPrice(env, budget.model).catch((err: unknown) => {
    console.error(`Price of ${budget.model} could not be read`, err);
    return null;
  });
  return {
    model: budget.model,
    funding: budget.funding,
    contextTokens: budget.contextTokens,
    maxOutputTokens: budget.maxOutputTokens,
    reasoning: budget.reasoning,
    serverMaxInputTokens: caps.length > 0 ? Math.min(...caps) : null,
    price: price && {
      inputUsdPerMTok: price.inMicrosPerMTok / MICROS_PER_USD,
      cacheReadUsdPerMTok:
        price.cacheReadMicrosPerMTok !== undefined
          ? price.cacheReadMicrosPerMTok / MICROS_PER_USD
          : null,
    },
  };
}
