import type { ChatNode, NodeErrorKind } from './domain.js';

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

/** `ChatNode.error` of a reply whose generation was lost before it finished (a restart). */
export const REPLY_INTERRUPTED_ERROR = 'Interrupted before the reply finished';

/** `ChatNode.error` of a reply whose provider stream ended without finishing it. */
export const REPLY_STREAM_ENDED_ERROR = 'The provider stream ended unexpectedly';

/** The kind each fixed message stands for. */
const KIND_OF_COPY: ReadonlyMap<string, NodeErrorKind> = new Map([
  [REPLY_CUT_OFF_ERROR, 'cut_off'],
  [REPLY_THINKING_ONLY_ERROR, 'thinking_only'],
  [REPLY_EMPTY_ERROR, 'empty'],
  [REPLY_CANCELLED_ERROR, 'cancelled'],
  [REPLY_INTERRUPTED_ERROR, 'interrupted'],
  [REPLY_STREAM_ENDED_ERROR, 'provider'],
]);

/** What `errorKindOf` reads of a node. */
export type ErrorKindSource = Pick<ChatNode, 'status' | 'errorKind'> & { error?: string | null };

/**
 * Why `node` is `error`: its `errorKind`, else the kind its fixed message
 * stands for (a node stored before kinds existed, an old backup, a node a
 * client marked failed); null when it isn't `error` or nothing says why.
 */
export function errorKindOf(node: ErrorKindSource): NodeErrorKind | null {
  if (node.status !== 'error') return null;
  return node.errorKind ?? (node.error ? (KIND_OF_COPY.get(node.error) ?? null) : null);
}

/** Whether `node` is a reply cut off at its length limit with some text kept. */
export function isCutOffReply(node: ErrorKindSource): boolean {
  return errorKindOf(node) === 'cut_off';
}

/** Whether `node` is a reply the learner stopped. */
export function isStoppedReply(node: ErrorKindSource): boolean {
  return errorKindOf(node) === 'cancelled';
}
