import type { ChatMessage, ContextPlan, RenderedPrompt, SummaryRequest } from '@tangent/shared';

export interface RenderOptions {
  supportsSystemPrompt: boolean;
}

/**
 * Plan → provider-agnostic prompt.
 * - system: tree system prompt, system nodes, summaries and anchor quotes, in
 *   segment order, as labelled sections;
 * - messages: ancestor + branch message segments in order; consecutive
 *   same-role messages are merged; a leading assistant message gets a
 *   synthetic user message in front so the list starts with `user`;
 * - when `supportsSystemPrompt` is false the system text is prepended to the
 *   first user message.
 * Pending/failed summaries are omitted.
 */
export function renderPlan(plan: ContextPlan, options: RenderOptions): RenderedPrompt {
  void plan;
  void options;
  throw new Error('not implemented');
}

/** Prompt used to generate a branch/compaction summary for `request`. */
export function buildSummaryPrompt(request: SummaryRequest): RenderedPrompt {
  void request;
  throw new Error('not implemented');
}

/** Prompt used to auto-title a branch from its first messages. */
export function buildTitlePrompt(messages: readonly ChatMessage[]): RenderedPrompt {
  void messages;
  throw new Error('not implemented');
}

/** Cleans a model-produced title: one line, no quotes/markdown, <= 80 chars. null if empty. */
export function cleanTitle(raw: string): string | null {
  void raw;
  throw new Error('not implemented');
}
