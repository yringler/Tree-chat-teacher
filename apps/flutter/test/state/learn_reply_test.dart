import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/api/models.dart';
import 'package:tangent/state/learn_reply.dart';

void main() {
  const paid = (pool: false, fixedModel: false);

  LearnReplyIndicator? chip(
    LearnReplySettings settings, [
    ({bool pool, bool fixedModel}) context = paid,
  ]) => learnReplyIndicator(
    settings,
    pool: context.pool,
    fixedModel: context.fixedModel,
  );

  group('learnReplyIndicator', () {
    test('shows nothing while every setting is the default', () {
      expect(chip(LearnReplySettings.defaults), isNull);
      expect(
        chip(LearnReplySettings.defaults, (pool: true, fixedModel: false)),
        isNull,
      );
    });

    test('names only the settings that differ from the default', () {
      final max = chip(const LearnReplySettings(tier: ModelTier.max))!;
      expect(max.label, 'Max');
      expect(max.off, isFalse);
      expect(max.note, isNull);
      expect(max.semanticLabel, 'Advanced settings: Max model. Change');
      final both = chip(
        const LearnReplySettings(
          tier: ModelTier.max,
          replyLength: ReplyLength.veryLong,
        ),
      )!;
      expect(both.label, 'Max · Very long');
      expect(
        both.semanticLabel,
        'Advanced settings: Max model, very long replies. Change',
      );
    });

    test('is muted, with a note, while the open pool pays', () {
      final off = chip(
        const LearnReplySettings(
          tier: ModelTier.max,
          replyLength: ReplyLength.long,
        ),
        (pool: true, fixedModel: false),
      )!;
      expect(off.label, 'Max · Long');
      expect(off.off, isTrue);
      expect(off.note, learnReplyPoolNote);
      expect(
        off.semanticLabel,
        'Advanced settings: Max model, long replies, not used for free replies. Change',
      );
    });

    test('leaves out Max on a key with one model', () {
      const fixed = (pool: false, fixedModel: true);
      expect(
        chip(const LearnReplySettings(tier: ModelTier.max), fixed),
        isNull,
      );
      expect(
        chip(
          const LearnReplySettings(
            tier: ModelTier.max,
            replyLength: ReplyLength.veryLong,
          ),
          fixed,
        )!.label,
        'Very long',
      );
    });
  });
}
