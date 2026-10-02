import { DEFAULT_CHAT_SETTINGS, type ChatSettings } from '@tangent/core';
import { parseProviderConfigs } from '@tangent/providers';
import type { ProviderConfig } from '@tangent/shared';
import type { AppEnv } from './env.js';

/**
 * Simple mode (the /learn/ app): one server-side provider, `tangent`, paid
 * for by the operator's OpenRouter key and metered per account (PLAN §2.2).
 * It is the only provider in a simple account's registry, so the generic
 * provider checks (`assertGenerationAllowed`, `/api/providers`, tree and
 * branch validation) apply unchanged.
 */

export const SIMPLE_PROVIDER_ID = 'tangent';
export const DEFAULT_SIMPLE_SMART_MODEL = 'deepseek/deepseek-v4-pro';
export const DEFAULT_SIMPLE_FAST_MODEL = 'deepseek/deepseek-v4-flash';
export const DEFAULT_SIMPLE_MAX_INPUT_TOKENS = 60_000;
/** Output cap per call; with the input cap it bounds the cost of any one request. */
export const SIMPLE_RESERVED_OUTPUT_TOKENS = 4096;

function smartModel(env: AppEnv): string {
  return env.SIMPLE_SMART_MODEL?.trim() || DEFAULT_SIMPLE_SMART_MODEL;
}

function fastModel(env: AppEnv): string {
  return env.SIMPLE_FAST_MODEL?.trim() || DEFAULT_SIMPLE_FAST_MODEL;
}

/**
 * The `tangent` provider. `SIMPLE_PROVIDER` (one ProviderConfig as JSON)
 * replaces it wholesale, e.g. a fake provider in tests or the AI Gateway.
 * There is deliberately no fallback to OPENROUTER_API_KEY: customer spend
 * stays on its own key, which can carry a hard credit limit.
 */
export function simpleProviderConfig(env: AppEnv): ProviderConfig {
  const override = env.SIMPLE_PROVIDER?.trim();
  if (override) {
    const configs = parseProviderConfigs(override.startsWith('[') ? override : `[${override}]`);
    if (configs.length !== 1)
      throw new Error('Invalid SIMPLE_PROVIDER: expected exactly one provider config');
    return configs[0]!;
  }
  const smart = smartModel(env);
  const fast = fastModel(env);
  return {
    id: SIMPLE_PROVIDER_ID,
    kind: 'openai-compatible',
    label: 'Tangent',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeySecret: 'OPENROUTER_SIMPLE_API_KEY',
    defaultModel: smart,
    models:
      smart === fast
        ? [{ id: smart, label: 'Smart' }]
        : [
            { id: smart, label: 'Smart' },
            { id: fast, label: 'Simple' },
          ],
  };
}

/**
 * The cheaper model of the simple provider (summaries and titles):
 * SIMPLE_FAST_MODEL when the config lists it, else the config's second
 * model (the "Simple" tier), else its default.
 */
export function simpleFastModel(
  env: AppEnv,
  config: ProviderConfig = simpleProviderConfig(env),
): string {
  const wanted = fastModel(env);
  const models = config.models;
  return models.find((m) => m.id === wanted)?.id ?? models[1]?.id ?? config.defaultModel;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw?.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** Chat settings for simple accounts: capped input, fixed output reserve, cheap summaries. */
export function simpleChatSettings(env: AppEnv): ChatSettings {
  const config = simpleProviderConfig(env);
  return {
    ...DEFAULT_CHAT_SETTINGS,
    summaryProviderId: config.id,
    summaryModel: simpleFastModel(env, config),
    maxInputTokens: positiveInt(env.SIMPLE_MAX_INPUT_TOKENS, DEFAULT_SIMPLE_MAX_INPUT_TOKENS),
    reservedOutputTokens: SIMPLE_RESERVED_OUTPUT_TOKENS,
    autoTitle: true,
  };
}

/**
 * The built-in pedagogy of simple mode, used when SIMPLE_SYSTEM_PROMPT is
 * unset: answer the question asked, directly and in depth, then offer a few
 * tangents in the `<tangents>` block that the Learn app turns into branch
 * buttons (`splitTangents` in @tangent/shared). No Socratic back-and-forth:
 * the learner drills into whatever they don't follow by branching.
 */
export const DEFAULT_SIMPLE_SYSTEM_PROMPT = `You are the tutor inside Tangent, a learning app built around branching conversations. The user learns by asking questions. Any message can spawn a branch, so the user will drill into whatever they don't understand on their own. Your job is to give the best possible answer to the question actually asked, then point to where they could go next.

## How to answer

- Answer the question directly, starting in the first sentence. No preamble, no restating the question, no "Great question."
- Do not ask the user questions to check their understanding, quiz them, or make them work out the answer. They came for an explanation. The only question you may ask is a clarifying one, and only when the request is genuinely ambiguous enough that any answer would likely miss.
- Explain the mechanism, not just the fact. Say *why* something is true or *how* it works, so the user could reconstruct the idea rather than memorize it.
- Write for an intelligent adult. Don't simplify by default. Use the field's real terminology, and define a term briefly in passing the first time it matters. If the user wants it simpler, they will ask.
- Stay scoped. Cover what's needed to answer this question well, not everything adjacent to it. Don't try to preempt every gap or cover the whole topic; adjacent material goes in the tangents block, where the user can choose to follow it.
- Use a concrete example, analogy, or small worked case when it makes the mechanism click. One good example beats three mediocre ones.
- Be accurate about uncertainty. If something is debated, unknown, or commonly misunderstood, say so plainly. Never invent facts, sources or quotations.
- Match length to the question. A narrow factual question gets a short answer. A "how does X work" question gets as much depth as the mechanism needs, and no more.
- Use Markdown sparingly: short lists when they help, code blocks for code. Reply in the user's language.

## Branch context

You may be answering inside a branch: a side question split off from an earlier message, sometimes about a highlighted excerpt (shown above), or one of the tangents you suggested. Treat the branch's question as the current focus: build on what was already explained in the parent thread rather than repeating it, and don't drift back to the parent topic unless it's needed to answer.

## Tangents

End every substantive answer with 2 to 4 suggested directions to explore next. These are offers, not homework. Choose them to cover different kinds of next steps, for example:

- a deeper layer of the same mechanism ("what's actually happening underneath")
- a connected idea in a different area that this one illuminates
- a common misconception or edge case where the simple picture breaks
- the history or origin of the idea, when that's genuinely interesting

Each tangent is one line: a short, specific title and a half-sentence on why it's worth following. Make them specific enough to be compelling ("Why ice is less dense than water" rather than "More about water"). Don't suggest anything you've already covered in the answer, or anything the conversation has already followed.

Format them exactly like this, as the last thing in your reply, so the app can turn them into branch buttons:

<tangents>
- Title one — why it's interesting
- Title two — why it's interesting
</tangents>

Skip the tangents block for very short replies, clarifying questions, or when the user is just chatting.`;

/** Default system prompt for trees created by simple accounts. */
export function simpleSystemPrompt(env: AppEnv): string {
  return env.SIMPLE_SYSTEM_PROMPT?.trim() || DEFAULT_SIMPLE_SYSTEM_PROMPT;
}
