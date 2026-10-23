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

/** The line under each length in the settings: no numbers, so tuning `REPLY_LENGTH_WORDS` keeps it true. */
export const REPLY_LENGTH_HINTS: Readonly<Record<LearnReplyLength, string>> = {
  normal: 'A page or so. Short questions still get short answers.',
  long: 'A few pages, in sections.',
  veryLong: 'About a chapter, in sections. Works best with Max.',
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

/** How many words a reply of one length may run: a range with the length to aim for. */
export interface ReplyLengthWords {
  /** The least a reply that needs the room should run; 0 = no floor. */
  min: number;
  /** What to aim for. */
  target: number;
  /** About the most it should run. */
  max: number;
}

/**
 * Each length's words, the one place to tune them: the instructions are
 * built from it (`replyLengthInstructions`). A range is leeway, not a quota:
 * a simple question comes in under it and a hard one runs toward the top.
 * The reply's output cap doesn't change with the length (5,000 words is
 * about 6,700 tokens, inside a reasoning model's cap); on a model that
 * doesn't reason a very long reply may end cut off, and Continue picks it up.
 */
export const REPLY_LENGTH_WORDS: Readonly<Record<LearnReplyLength, ReplyLengthWords>> = {
  normal: { min: 0, target: 500, max: 750 },
  long: { min: 1000, target: 1500, max: 2000 },
  veryLong: { min: 2500, target: 3500, max: 5000 },
};

/**
 * How Long and Very long spend their room. Each rule answers padding or slips
 * seen in longer replies: recaps, a contents paragraph, a misconceptions
 * section re-arguing the body, a point made twice, headings on a short reply,
 * tangents repeating a section, and more wrong figures as replies grew.
 */
const LONG_RULES = `

- Spend added length only on new material: more of the mechanism, worked examples (check every number before writing it), and edge cases. Make each point once. If the question is narrow, stop when it's answered.
- Open with a short overview paragraph, with no title or heading. Past about 600 words, organize the body under \`##\` headings that follow the overview; below that, use none. Don't list the sections you're about to cover.
- End on the last new point. Add no summary, recap or "short version" section, and no misconceptions section that re-argues the body; address a misconception where the mechanism it gets wrong is explained.
- A longer reply carries more specific figures, dates, names and version details. Include only those you're sure of, say which era a version-specific detail belongs to, and attribute a contested claim to whoever holds it.
- Inside a tangent, use the terms the conversation has already explained without redefining them.
- The tangents block still comes last, with at most 6 suggestions, none of them something a section of this reply already covers. It doesn't count toward the length.`;

/** Normal's close: only the tangents block, which a short reply has no sections to repeat. */
const NORMAL_CLOSE = " The tangents block still comes last and doesn't count toward the length.";

const number = (n: number) => n.toLocaleString('en-US');

/**
 * What a Learn reply of `length` is asked after the history (with any
 * grounding text, in the same `replyInstructions` block), so the cached
 * prompt prefix is the same whatever the length. Built from
 * `REPLY_LENGTH_WORDS`, with Long and Very long sharing `LONG_RULES`.
 */
export function replyLengthInstructions(length: LearnReplyLength): string {
  const { min, target, max } = REPLY_LENGTH_WORDS[length];
  const range =
    min > 0 ? `about ${number(min)}–${number(max)} words` : `up to about ${number(max)} words`;
  const rules = length === 'normal' ? NORMAL_CLOSE : LONG_RULES;
  return `## Reply length

The learner chose ${REPLY_LENGTH_LABELS[length].toLowerCase()} replies: ${range}, around ${number(target)} for a typical question. The range is leeway, not a quota. Write what this question needs: a simple question can come in well under it, and a hard one can run toward the top. Don't pad to reach it, and don't cut a needed explanation short to stay under it.${rules}`;
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
