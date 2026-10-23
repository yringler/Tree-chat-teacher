import '../api/models.dart';

// Learn's Advanced settings, as the learner sees them: the words and rules
// of packages/shared/src/learn-reply.ts, which a parity spec there checks
// against this file. The prompt each length sends is the server's alone.

/// The lengths that run only on Max, whatever tier is saved
/// (`LENGTH_REQUIRES_MAX`): Normal's very long replies were unreliable on
/// reasoning and arithmetic.
const replyLengthRequiresMax = {
  ReplyLength.normal: false,
  ReplyLength.long: false,
  ReplyLength.veryLong: true,
};

/// The tier replies run on under [settings] (`effectiveLearnTier`), as the
/// server routes and holds them.
ModelTier effectiveLearnTier(LearnReplySettings settings) =>
    replyLengthRequiresMax[settings.replyLength]!
    ? ModelTier.max
    : settings.tier;

/// What each tier is called (`TIER_LABELS`).
const tierLabels = {ModelTier.normal: 'Normal', ModelTier.max: 'Max'};

/// The line under each tier (`LEARN_TIER_HINTS`).
const tierHints = {
  ModelTier.normal: 'Quick and good for most lessons.',
  ModelTier.max: 'A stronger model for hard topics. Slower, and each reply costs about 20 times as much.',
};

/// What each length is called (`REPLY_LENGTH_LABELS`).
const replyLengthLabels = {
  ReplyLength.normal: 'Normal',
  ReplyLength.long: 'Long',
  ReplyLength.veryLong: 'Very long',
};

/// The line under each length (`REPLY_LENGTH_HINTS`).
const replyLengthHints = {
  ReplyLength.normal: 'A page or so. Short questions still get short answers.',
  ReplyLength.long: 'A few pages, in sections.',
  ReplyLength.veryLong: 'About a chapter, in sections. Uses the Max model for accuracy (about 20× the cost of Normal) and sets aside more credit before each reply.',
};

/// Under the length choice (`REPLY_LENGTH_FOOTNOTE`).
const replyLengthFootnote =
    'Longer replies cost more, and make later messages in the lesson cost more, since the tutor rereads them. They apply to new replies.';

/// The chip's note while the open pool pays (`LEARN_REPLY_POOL_NOTE`).
const learnReplyPoolNote = 'Not used for free replies';

/// In place of the model choice on an Anthropic key (`LEARN_REPLY_FIXED_MODEL_NOTE`).
const learnReplyFixedModelNote =
    'Your Anthropic key always uses the stronger model.';

/// Under the model choice while a length that requires Max locks it there
/// (`LEARN_REPLY_MAX_REQUIRED_NOTE`).
const learnReplyMaxRequiredNote =
    'Very long replies need Max. Pick a shorter length to choose Normal.';

/// Marks a warning; left out of what a screen reader says
/// (`LEARN_REPLY_WARNING_MARK`).
const learnReplyWarningMark = '⚠️';

/// Under the length choice, after the mark, while [warnsLongOnNormal]
/// (`LEARN_REPLY_LONG_WARNING`).
const learnReplyLongWarning =
    'On the Normal model, long replies are more likely to have accuracy issues. Consider switching to Max.';

/// Whether to warn that Long runs on Normal (`warnsLongOnNormal`): not on
/// the pool, where the length doesn't apply, or on a key with one model.
bool warnsLongOnNormal(
  LearnReplySettings settings, {
  required bool pool,
  required bool fixedModel,
}) =>
    settings.replyLength == ReplyLength.long &&
    effectiveLearnTier(settings) == ModelTier.normal &&
    !pool &&
    !fixedModel;

/// What the composer shows while a setting isn't the default
/// (`LearnReplyIndicator`).
class LearnReplyIndicator {
  const LearnReplyIndicator({
    required this.label,
    required this.off,
    required this.note,
    required this.semanticLabel,
  });

  /// The settings that differ from the default, as they apply, e.g.
  /// "Very long · Max" or "Max · Long".
  final String label;

  /// Replies don't use them now (the open pool pays).
  final bool off;

  /// Why they're off; null when they apply.
  final String? note;

  /// What a screen reader says for the chip (`ariaLabel`).
  final String semanticLabel;
}

/// The composer chip for [settings], as they apply (`learnReplyIndicator`):
/// null while every setting that could apply is the default. [pool]: the
/// open pool pays; [fixedModel]: the own key has one model, so the tier
/// doesn't apply. A length that requires Max names it after itself.
LearnReplyIndicator? learnReplyIndicator(
  LearnReplySettings settings, {
  required bool pool,
  required bool fixedModel,
}) {
  final max = effectiveLearnTier(settings) == ModelTier.max && !fixedModel;
  final long = settings.replyLength != ReplyLength.normal;
  if (!max && !long) return null;
  final required = replyLengthRequiresMax[settings.replyLength]!;
  final warn = warnsLongOnNormal(settings, pool: pool, fixedModel: fixedModel);
  final lengthLabel = replyLengthLabels[settings.replyLength]!;
  final lengthSpoken = '${lengthLabel.toLowerCase()} replies';
  final tierPart = max
      ? (
          label: tierLabels[ModelTier.max]!,
          spoken: required
              ? 'Max model (required for $lengthSpoken)'
              : 'Max model',
        )
      : null;
  final lengthPart = long
      ? (
          label: warn ? '$learnReplyWarningMark $lengthLabel' : lengthLabel,
          spoken: lengthSpoken,
        )
      : null;
  final parts = (required ? [lengthPart, tierPart] : [tierPart, lengthPart])
      .nonNulls
      .toList();
  final note = pool ? learnReplyPoolNote : null;
  final spoken = parts.map((p) => p.spoken).join(', ');
  return LearnReplyIndicator(
    label: parts.map((p) => p.label).join(' · '),
    off: pool,
    note: note,
    semanticLabel:
        'Advanced settings: $spoken${note != null ? ', ${note.toLowerCase()}' : ''}.${warn ? ' $learnReplyLongWarning' : ''} Change',
  );
}
