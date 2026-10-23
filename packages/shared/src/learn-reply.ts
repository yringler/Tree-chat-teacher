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

/**
 * The lengths that run only on Max, whatever tier the learner saved: a review
 * of very long replies on Normal's model found them unreliable on reasoning
 * and arithmetic, so a reply that long is held to Max's standard, and the
 * settings say what it costs. The saved tier stays the learner's pick, so a
 * shorter length runs on it again.
 */
export const LENGTH_REQUIRES_MAX: Readonly<Record<LearnReplyLength, boolean>> = {
  normal: false,
  long: false,
  veryLong: true,
};

/** The tier a Learn reply runs, is gated and is held on under `settings` (the pool keeps its own). */
export function effectiveLearnTier(settings: LearnReplySettings): ModelTier {
  return LENGTH_REQUIRES_MAX[settings.replyLength] ? 'max' : settings.tier;
}

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
  veryLong:
    'About a chapter, in sections. Uses the Max model for accuracy (about 20× the cost of Normal) and sets aside more credit before each reply.',
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

/** Under the model choice while a length that requires Max (`LENGTH_REQUIRES_MAX`) locks it on Max. */
export const LEARN_REPLY_MAX_REQUIRED_NOTE =
  'Very long replies need Max. Pick a shorter length to choose Normal.';

/** Marks a warning in the settings and on the chip; left out of what a screen reader says. */
export const LEARN_REPLY_WARNING_MARK = '⚠️';

/** Under the length group, after the mark, while `warnsLongOnNormal`. */
export const LEARN_REPLY_LONG_WARNING =
  'On the Normal model, long replies are more likely to have accuracy issues. Consider switching to Max.';

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
 * Normal and Long share a reasoning model's reply cap; Very long gets a
 * larger one (`LEARN_VERY_LONG_OUTPUT_TOKENS`), since Max at high effort can
 * think for over 11k tokens before 5,000 words (about 6,700 tokens). On a
 * model that doesn't reason a very long reply may end cut off, and Continue
 * picks it up.
 */
export const REPLY_LENGTH_WORDS: Readonly<Record<LearnReplyLength, ReplyLengthWords>> = {
  normal: { min: 0, target: 500, max: 750 },
  long: { min: 1000, target: 1500, max: 2000 },
  veryLong: { min: 2000, target: 3500, max: 5000 },
};

/**
 * How Long and Very long spend their room. Each rule answers padding or slips
 * seen in longer replies: recaps, an overview that previews the sections, a
 * misconceptions section re-arguing the body, a section regrouping what was
 * already explained, a point made twice, headings on a short reply, tangents
 * repeating the reply, more wrong figures as replies grew, narrated
 * confidence in place of leaving a doubtful detail out, a doubt hardened into
 * 'never', a safety claim made loosely, a tangent restating its parent, a closing offer of a diagram after the content, and a dropped
 * tangents block.
 */
const SPEND_RULE =
  '- Spend added length only on new material: more of the mechanism, worked examples (check every number before writing it), and edge cases. Make each point once.';
const LONG_RULES = [
  '- Open with a short overview paragraph, with no title or heading. The overview answers the question; it never previews the order of what follows. Count before adding headings: a reply under about 600 words has none. Past that, organize the body under `##` headings that follow the overview.',
  '- End on the last new point. Add no summary, recap or "short version" section, and no misconceptions section that re-argues the body; address a misconception where the mechanism it gets wrong is explained.',
  "- No section that regroups what's already been explained (a timeline, 'why it was fragile', competing frameworks).",
  "- A longer reply carries more specific figures, dates, names and version details. Include only those you're sure of, say which era a version-specific detail belongs to, and attribute a contested claim to whoever holds it.",
  "- Don't narrate your confidence ('I'm confident…', 'as I recall', 'I'd check…'); leave out a detail you're unsure of.",
  "- Don't turn an uncertain claim into an absolute ('never', 'only'); state what's established.",
  "- A practical safety claim (burns, disinfection, dosing) must be one you're sure of.",
  "- Inside a tangent, use the terms the conversation has already explained without redefining them, and don't restate what an earlier turn already said.",
  '- Leave out the closing offer to draw a diagram; if a diagram would help, make it one of the tangents instead.',
  "- Always end with the tangents block, with at most 6 suggestions, none that any paragraph of this reply already covers. It doesn't count toward the length.",
];

/**
 * Where Long and Very long differ, after `SPEND_RULE`. Long may stop early
 * on a narrow question, but not before the mechanism and what follows from
 * it (stopping at the bare answer left a Long reply thinner than Normal); Very long, read that way, stopped well short of its
 * range with material left, so it is pushed toward a chapter instead.
 */
const LENGTH_RULE: Readonly<Record<'long' | 'veryLong', string>> = {
  long: "- If the question is narrow, stop when it's answered, but even then give the mechanism and its practical consequence.",
  veryLong:
    "- A learner who picks Very long wants a chapter. Before ending, check what a textbook chapter on this would cover (the full mechanism, a second worked example of a different kind, the edge cases, where experts genuinely disagree, if they do; don't manufacture a debate) and cover what's missing. Come in under the range only when the question is truly narrow, and even then go clearly beyond what a Long reply would cover.",
};

const longRules = (length: 'long' | 'veryLong') =>
  `\n\n${[SPEND_RULE, LENGTH_RULE[length], ...LONG_RULES].join('\n')}`;

/** Normal's close: only the tangents block, which a short reply has no sections to repeat. */
const NORMAL_CLOSE = " The tangents block still comes last and doesn't count toward the length.";

const number = (n: number) => n.toLocaleString('en-US');

/**
 * What a Learn reply of `length` is asked after the history (with any
 * grounding text, in the same `replyInstructions` block), so the cached
 * prompt prefix is the same whatever the length. Built from
 * `REPLY_LENGTH_WORDS`, with Long and Very long sharing `SPEND_RULE` and `LONG_RULES` and
 * differing by `LENGTH_RULE`.
 */
export function replyLengthInstructions(length: LearnReplyLength): string {
  const { min, target, max } = REPLY_LENGTH_WORDS[length];
  const range =
    min > 0 ? `about ${number(min)}–${number(max)} words` : `up to about ${number(max)} words`;
  const rules = length === 'normal' ? NORMAL_CLOSE : longRules(length);
  return `## Reply length

The learner chose ${REPLY_LENGTH_LABELS[length].toLowerCase()} replies: ${range}, around ${number(target)} for a typical question. The range is leeway, not a quota. Write what this question needs: a simple question can come in well under it, and a hard one can run toward the top. Don't pad to reach it, and don't cut a needed explanation short to stay under it.${rules}`;
}

/** What the composer shows while a setting isn't the default (`learnReplyIndicator`). */
export interface LearnReplyIndicator {
  /** The settings that differ from the default, as they apply, e.g. "Very long · Max" or "Max · Long". */
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
 * Whether to warn that Long runs on Normal: allowed, but less accurate than
 * on Max. Not where the length doesn't apply (the pool) or the model can't
 * be chosen (an own key with one model).
 */
export function warnsLongOnNormal(
  settings: LearnReplySettings,
  context: LearnReplyContext,
): boolean {
  return (
    settings.replyLength === 'long' &&
    effectiveLearnTier(settings) === 'normal' &&
    !context.pool &&
    !context.fixedModel
  );
}

/**
 * The composer chip for `settings`, as they apply (`effectiveLearnTier`):
 * null when every setting that could apply is the default, so a learner who
 * changed one always sees it next to where they type. A length that
 * requires Max names it after itself ("Very long · Max").
 */
export function learnReplyIndicator(
  settings: LearnReplySettings,
  context: LearnReplyContext,
): LearnReplyIndicator | null {
  const max = effectiveLearnTier(settings) === 'max' && !context.fixedModel;
  const long = settings.replyLength !== 'normal';
  if (!max && !long) return null;
  const required = LENGTH_REQUIRES_MAX[settings.replyLength];
  const warn = warnsLongOnNormal(settings, context);
  const lengthLabel = REPLY_LENGTH_LABELS[settings.replyLength];
  const lengthSpoken = `${lengthLabel.toLowerCase()} replies`;
  const tierPart = max
    ? {
        label: TIER_LABELS.max,
        spoken: required ? `Max model (required for ${lengthSpoken})` : 'Max model',
      }
    : null;
  const lengthPart = long
    ? {
        label: warn ? `${LEARN_REPLY_WARNING_MARK} ${lengthLabel}` : lengthLabel,
        spoken: lengthSpoken,
      }
    : null;
  const parts = (required ? [lengthPart, tierPart] : [tierPart, lengthPart]).filter(
    (p): p is { label: string; spoken: string } => p !== null,
  );
  const note = context.pool ? LEARN_REPLY_POOL_NOTE : null;
  const spoken = parts.map((p) => p.spoken).join(', ');
  return {
    label: parts.map((p) => p.label).join(' · '),
    off: context.pool,
    note,
    ariaLabel: `Advanced settings: ${spoken}${note ? `, ${note.toLowerCase()}` : ''}.${warn ? ` ${LEARN_REPLY_LONG_WARNING}` : ''} Change`,
  };
}

/** The sentence the pool-fallback notice adds when a credit send ran without the learner's settings. */
export const LEARN_REPLY_FALLBACK_NOTE = 'so this reply used Normal.';
