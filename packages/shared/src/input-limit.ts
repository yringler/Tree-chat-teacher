import { z } from 'zod';
import type { BranchFunding } from './domain.js';
import { replyOutputTokens } from './output-tokens.js';

/*
 * Power's input limit: how much of a branch's history one message may send.
 * Every message re-sends the path up to the limit, so on the user's own key,
 * where only the model's context window bounds it, a long conversation can
 * send hundreds of thousands of tokens per message. The limit, and what
 * happens to a conversation over it, are sent with each message
 * (`SendMessageRequest.maxInputTokens`, `.inputOverflow`) and with the
 * Context panel's preview; the server clamps the limit (ChatService
 * `budgetFor`, and on Tangent credit the Worker's input cap).
 */

/**
 * What a conversation over its input budget loses: `compact` replaces the
 * oldest part with a summary (the default; when no summary can be made, the
 * oldest messages are dropped instead), `truncate` drops the oldest messages
 * and makes no summary.
 */
export type InputOverflow = (typeof INPUT_OVERFLOWS)[number];
export const INPUT_OVERFLOWS = ['compact', 'truncate'] as const;
export const DEFAULT_INPUT_OVERFLOW: InputOverflow = 'compact';

/** Smallest and largest input limit a client may ask for (`SendMessageRequest.maxInputTokens`). */
export const MIN_REQUESTED_INPUT_TOKENS = 1000;
export const MAX_REQUESTED_INPUT_TOKENS = 2_000_000;
/** The presets power offers; anything else in range is a custom value. */
export const INPUT_TOKEN_PRESETS: readonly number[] = [16_000, 32_000, 64_000, 128_000];

/**
 * Zod field of a requested input limit (JSON body). Object schemas that use it
 * live in api.ts, after its `z.config({ jitless: true })`: an object schema
 * built before that would still probe `new Function` (a CSP violation).
 */
export const requestedInputTokens = z
  .number()
  .int()
  .min(MIN_REQUESTED_INPUT_TOKENS)
  .max(MAX_REQUESTED_INPUT_TOKENS);

/**
 * `GET /api/branches/:id/input-budget`: what bounds a message's input on the
 * branch's route and model, for power's input limit setting.
 */
export interface InputBudgetResponse {
  model: string;
  funding: BranchFunding;
  /** The model's context window, as the server budgets it (input plus the reply). */
  contextTokens: number;
  /** The model's output limit: a reply's cap never exceeds it. */
  maxOutputTokens: number;
  /** Whether the model reasons (a larger default reply cap, see output-tokens.ts). */
  reasoning: boolean;
  /**
   * The most input the server sends on this route whatever the setting
   * (Tangent credit: SIMPLE_MAX_INPUT_TOKENS); null = only the window bounds it.
   */
  serverMaxInputTokens: number | null;
  /**
   * The model's list price in USD per million input tokens, and per million
   * read from the prompt cache (null when unknown); null when the server has
   * no price for the model.
   */
  price: { inputUsdPerMTok: number; cacheReadUsdPerMTok: number | null } | null;
}

/** What a message's input budget is, and what decides it; see `inputBudgetOf`. */
export interface InputBudget {
  /** The budget without a limit of the user's: the window less the reply, within the server's cap. */
  defaultTokens: number;
  /** The budget with the user's limit (`defaultTokens` when it has none, or a larger one). */
  tokens: number;
  /** The reply's output cap, reserved out of the window. */
  replyTokens: number;
  /** What bounds `tokens`: the user's limit, the server's cap, or the context window. */
  boundBy: 'limit' | 'server' | 'window';
}

/**
 * A message's input budget on `info`'s route, as the server works it out
 * (ChatService `budgetFor`, plus the Worker's cap): the context window less
 * the reply's cap (`maxOutputTokens`, power's reply length; null = the
 * default for the model), within the server's cap and the user's limit.
 */
export function inputBudgetOf(
  info: Pick<
    InputBudgetResponse,
    'contextTokens' | 'maxOutputTokens' | 'reasoning' | 'serverMaxInputTokens'
  >,
  settings: { maxInputTokens: number | null; maxOutputTokens: number | null },
): InputBudget {
  const replyTokens = replyOutputTokens({
    reasoning: info.reasoning,
    maxOutputTokens: info.maxOutputTokens,
    requested: settings.maxOutputTokens,
  });
  const window = Math.max(1, info.contextTokens - replyTokens);
  const server = info.serverMaxInputTokens;
  const defaultTokens = server !== null ? Math.min(window, server) : window;
  const limit = settings.maxInputTokens;
  const tokens = limit !== null ? Math.min(defaultTokens, limit) : defaultTokens;
  const boundBy =
    limit !== null && limit < defaultTokens
      ? 'limit'
      : server !== null && server < window
        ? 'server'
        : 'window';
  return { defaultTokens, tokens, replyTokens, boundBy };
}
