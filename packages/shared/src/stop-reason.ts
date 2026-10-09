import type { ChatNode } from './domain.js';

/**
 * A reply that ends at its output cap (`max_tokens`) is not an answer: the
 * text stops mid-sentence, the `<tangents>` block is lost, and on a reasoning
 * model the thinking (billed as output) can use up the whole cap before any
 * answer is written. Such a reply is stored as an `error` node that keeps its
 * partial text (it stays in the context, so the learner can ask the tutor to
 * continue), with one of the fixed messages below as its `error` and its
 * `errorKind` (`cut_off`, `thinking_only`), which is how every app tells it
 * from a failure.
 */

/** Upstream finish reasons of a reply cut off at its output cap (OpenAI/OpenRouter, Anthropic). */
const LENGTH_STOP_REASONS: ReadonlySet<string> = new Set(['length', 'max_tokens']);

/** Whether a provider's `done.stopReason` means the output cap ended the reply. */
export function isLengthStop(stopReason: string | null | undefined): boolean {
  return stopReason != null && LENGTH_STOP_REASONS.has(stopReason);
}

/** `ChatNode.error` of a reply cut off at its length limit; its partial text is kept. */
export const REPLY_CUT_OFF_ERROR =
  'The reply reached its length limit before it finished, so it was cut off.';

/**
 * `ChatNode.error` of a reply cut off before it said anything: a reasoning
 * model spent the whole length limit thinking.
 */
export const REPLY_THINKING_ONLY_ERROR =
  'The model used its whole length limit thinking and wrote no answer. Try again, or ask a narrower question.';

/** `ChatNode.error` of a reply that finished without any text. */
export const REPLY_EMPTY_ERROR = 'The model finished without writing an answer. Try again.';

/** `ChatNode.error` of a reply the learner stopped (the call was aborted). */
export const REPLY_CANCELLED_ERROR = 'Cancelled';

/** What "Continue" sends after a cut-off reply. */
export const CONTINUE_MESSAGE = 'Please continue where you left off.';

/** Whether `node` is a reply cut off at its length limit with some text kept. */
export function isCutOffReply(node: Pick<ChatNode, 'status' | 'errorKind'>): boolean {
  return node.status === 'error' && node.errorKind === 'cut_off';
}

/** Whether `node` is a reply the learner stopped. */
export function isStoppedReply(node: Pick<ChatNode, 'status' | 'errorKind'>): boolean {
  return node.status === 'error' && node.errorKind === 'cancelled';
}
