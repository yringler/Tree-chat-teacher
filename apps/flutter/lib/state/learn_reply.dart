import '../api/models.dart';

// Learn's Advanced settings, as the learner sees them: the words of
// packages/shared/src/learn-reply.ts, which a parity spec there checks
// against this file. The prompt each length sends is the server's alone.

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
  ReplyLength.veryLong: 'About a chapter, in sections. Works best with Max.',
};

/// Under the length choice (`REPLY_LENGTH_FOOTNOTE`).
const replyLengthFootnote =
    'Longer replies cost more, and make later messages in the lesson cost more, since the tutor rereads them. They apply to new replies.';

/// The chip's note while the open pool pays (`LEARN_REPLY_POOL_NOTE`).
const learnReplyPoolNote = 'Not used for free replies';

/// In place of the model choice on an Anthropic key (`LEARN_REPLY_FIXED_MODEL_NOTE`).
const learnReplyFixedModelNote =
    'Your Anthropic key always uses the stronger model.';

/// What the composer shows while a setting isn't the default
/// (`LearnReplyIndicator`).
class LearnReplyIndicator {
  const LearnReplyIndicator({
    required this.label,
    required this.off,
    required this.note,
    required this.semanticLabel,
  });

  /// The non-default settings, e.g. "Max · Very long".
  final String label;

  /// Replies don't use them now (the open pool pays).
  final bool off;

  /// Why they're off; null when they apply.
  final String? note;

  /// What a screen reader says for the chip (`ariaLabel`).
  final String semanticLabel;
}

/// The composer chip for [settings] (`learnReplyIndicator`): null while
/// every setting that could apply is the default. [pool]: the open pool
/// pays; [fixedModel]: the own key has one model, so the tier doesn't apply.
LearnReplyIndicator? learnReplyIndicator(
  LearnReplySettings settings, {
  required bool pool,
  required bool fixedModel,
}) {
  final max = settings.tier == ModelTier.max && !fixedModel;
  final long = settings.replyLength != ReplyLength.normal;
  if (!max && !long) return null;
  final length = replyLengthLabels[settings.replyLength]!;
  final label = [
    if (max) tierLabels[ModelTier.max]!,
    if (long) length,
  ].join(' · ');
  final spoken = [
    if (max) 'Max model',
    if (long) '${length.toLowerCase()} replies',
  ].join(', ');
  final note = pool ? learnReplyPoolNote : null;
  return LearnReplyIndicator(
    label: label,
    off: pool,
    note: note,
    semanticLabel:
        'Advanced settings: $spoken${note != null ? ', ${note.toLowerCase()}' : ''}. Change',
  );
}
