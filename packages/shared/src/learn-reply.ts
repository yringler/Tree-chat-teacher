/**
 * Learn's reply settings: the model tier and how long a reply may run, saved
 * per account (`SettingsResponse.learn`) and applied by the server to each
 * Learn reply the learner pays for. The open pool ignores them (its model,
 * prompt and limits are fixed), and so does power, which has its own model
 * and limit settings. Every user-facing word about them lives here, mirrored
 * in the Flutter app's `learn_reply.dart` (a parity spec checks the two).
 */
import { z } from './zod.js';
import type { ModelTier } from './provider.js';
import { TIER_LABELS } from './tiers.js';

export const LEARN_REPLY_LENGTHS = ['normal', 'long', 'veryLong'] as const;
export type LearnReplyLength = (typeof LEARN_REPLY_LENGTHS)[number];
export const learnReplyLengthSchema = z.enum(LEARN_REPLY_LENGTHS);
export const learnTierSchema = z.enum(['normal', 'max'] as const satisfies readonly ModelTier[]);

export interface LearnReplySettings {
  tier: ModelTier;
  replyLength: LearnReplyLength;
}

export const DEFAULT_LEARN_REPLY: Readonly<LearnReplySettings> = {
  tier: 'normal',
  replyLength: 'normal',
};

/** What each length is called in the settings and on the composer chip. */
export const REPLY_LENGTH_LABELS: Readonly<Record<LearnReplyLength, string>> = {
  normal: 'Normal',
  long: 'Long',
  veryLong: 'Very long',
};

/** The line under each length in the settings. */
export const REPLY_LENGTH_HINTS: Readonly<Record<LearnReplyLength, string>> = {
  normal: 'Up to about a page. Short questions still get short answers.',
  long: 'A few pages.',
  veryLong: 'About a chapter. Works best with Max.',
};

/** The line under each model tier in Learn's settings. */
export const LEARN_TIER_HINTS: Readonly<Record<ModelTier, string>> = {
  normal: 'Quick and good for most lessons.',
  max: 'A stronger model for hard topics. Slower, and each reply costs about 20 times as much.',
};

/** Under the length group: what a longer reply costs beyond itself. */
export const REPLY_LENGTH_FOOTNOTE =
  'Longer replies cost more, and make later messages in the lesson cost more, since the tutor rereads them. They apply to new replies.';

/** Shown in the settings, and as the chip's note, while replies are paid from the open pool. */
export const LEARN_REPLY_POOL_NOTE = 'Not used for free replies';

/** Shown in place of the model choice on the learner's own Anthropic key, which has one model. */
export const LEARN_REPLY_FIXED_MODEL_NOTE = 'Your Anthropic key always uses the stronger model.';

/**
 * Sent after the history for a longer reply (with any grounding text, in
 * the same `replyInstructions` block), so the cached prompt prefix is the
 * same whatever the length. Normal sends nothing: the tutor prompt's own
 * "match length to the question" applies. The targets are words, about 275
 * to a page (`WORDS_PER_PAGE`); the reply's output cap doesn't change, so a
 * very long reply on a model that doesn't think may end cut off, and
 * Continue picks it up.
 */
export const REPLY_LENGTH_INSTRUCTIONS: Readonly<
  Record<Exclude<LearnReplyLength, 'normal'>, string>
> = {
  long: lengthInstructions('long replies, about 1,000 words (a few pages)'),
  veryLong: lengthInstructions('very long replies, about 3,000 words (a short chapter)'),
};

function lengthInstructions(target: string): string {
  return `## Reply length

The learner chose ${target}. Unless the message only needs a sentence or two (a greeting, a yes or no, a clarification), write to that length: open with a short overview, organize the body under \`##\` section headings, and go further into the mechanism, examples and edge cases than a short answer would. This replaces the usual advice to match length to the question and stay brief. The tangents block still comes last, after everything else.`;
}

/** The instructions a reply of `length` gets after the history; null for Normal. */
export function replyLengthInstructions(length: LearnReplyLength): string | null {
  return length === 'normal' ? null : REPLY_LENGTH_INSTRUCTIONS[length];
}

/** What the composer shows while a setting isn't the default (`learnReplyIndicator`). */
export interface LearnReplyIndicator {
  /** The non-default settings, e.g. "Max · Very long". */
  label: string;
  /** Replies don't use them now (the open pool pays): the chip is muted and says why. */
  off: boolean;
  /** Why they're off, shown after the label; null when they apply. */
  note: string | null;
  /** What a screen reader says for the chip, which opens the settings. */
  ariaLabel: string;
}

/** Where a learner's replies are paid, as far as the settings care. */
export interface LearnReplyContext {
  /** The open pool pays, so neither setting applies. */
  pool: boolean;
  /** The learner's own key has one model (Anthropic), so the tier doesn't apply. */
  fixedModel: boolean;
}

/**
 * The composer chip for `settings`: null when every setting that could
 * apply is the default, so a learner who changed one always sees it next to
 * where they type.
 */
export function learnReplyIndicator(
  settings: LearnReplySettings,
  context: LearnReplyContext,
): LearnReplyIndicator | null {
  const max = settings.tier === 'max' && !context.fixedModel;
  const long = settings.replyLength !== 'normal';
  if (!max && !long) return null;
  const label = [
    max ? TIER_LABELS.max : null,
    long ? REPLY_LENGTH_LABELS[settings.replyLength] : null,
  ]
    .filter((p): p is string => p !== null)
    .join(' · ');
  const spoken = [
    max ? 'Max model' : null,
    long ? `${REPLY_LENGTH_LABELS[settings.replyLength].toLowerCase()} replies` : null,
  ]
    .filter((p): p is string => p !== null)
    .join(', ');
  const note = context.pool ? LEARN_REPLY_POOL_NOTE : null;
  return {
    label,
    off: context.pool,
    note,
    ariaLabel: `Advanced settings: ${spoken}${note ? `, ${note.toLowerCase()}` : ''}. Change`,
  };
}

/** The sentence the pool-fallback notice adds when a credit send ran without the learner's settings. */
export const LEARN_REPLY_FALLBACK_NOTE = 'so this reply used Normal.';
