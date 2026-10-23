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
          replyLength: ReplyLength.long,
        ),
      )!;
      expect(both.label, 'Max · Long');
      expect(
        both.semanticLabel,
        'Advanced settings: Max model, long replies. Change',
      );
    });

    test(
      'shows Very long on Max, the model it needs, whatever tier is saved',
      () {
        for (final tier in ModelTier.values) {
          final veryLong = chip(
            LearnReplySettings(tier: tier, replyLength: ReplyLength.veryLong),
          )!;
          expect(veryLong.label, 'Very long · Max');
          expect(veryLong.off, isFalse);
          expect(
            veryLong.semanticLabel,
            'Advanced settings: very long replies, Max model (required for very long replies). Change',
          );
        }
      },
    );

    test('warns of Long on Normal, and says why to a screen reader', () {
      final long = chip(
        const LearnReplySettings(replyLength: ReplyLength.long),
      )!;
      expect(long.label, '⚠️ Long');
      expect(
        long.semanticLabel,
        'Advanced settings: long replies. $learnReplyLongWarning Change',
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
      // No warning where the length isn't used.
      expect(
        chip(const LearnReplySettings(replyLength: ReplyLength.long), (
          pool: true,
          fixedModel: false,
        ))!.label,
        'Long',
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
      expect(
        chip(
          const LearnReplySettings(replyLength: ReplyLength.veryLong),
          fixed,
        )!.semanticLabel,
        'Advanced settings: very long replies. Change',
      );
      expect(
        chip(
          const LearnReplySettings(replyLength: ReplyLength.long),
          fixed,
        )!.label,
        'Long',
      );
    });
  });

  group('effectiveLearnTier', () {
    test('runs Very long on Max whatever tier is saved, the rest on the saved tier', () {
      expect(replyLengthRequiresMax, {
        ReplyLength.normal: false,
        ReplyLength.long: false,
        ReplyLength.veryLong: true,
      });
      for (final tier in ModelTier.values) {
        expect(
          effectiveLearnTier(
            LearnReplySettings(tier: tier, replyLength: ReplyLength.veryLong),
          ),
          ModelTier.max,
        );
        for (final length in [ReplyLength.normal, ReplyLength.long]) {
          expect(
            effectiveLearnTier(
              LearnReplySettings(tier: tier, replyLength: length),
            ),
            tier,
          );
        }
      }
    });
  });

  group('warnsLongOnNormal', () {
    test('warns only of Long on Normal, where the model can be chosen and the length applies', () {
      bool warns(
        LearnReplySettings settings, [
        ({bool pool, bool fixedModel}) context = paid,
      ]) => warnsLongOnNormal(
        settings,
        pool: context.pool,
        fixedModel: context.fixedModel,
      );
      const long = LearnReplySettings(replyLength: ReplyLength.long);
      expect(warns(long), isTrue);
      expect(warns(long.copyWith(tier: ModelTier.max)), isFalse);
      expect(warns(LearnReplySettings.defaults), isFalse);
      expect(
        warns(const LearnReplySettings(replyLength: ReplyLength.veryLong)),
        isFalse,
      );
      expect(warns(long, (pool: false, fixedModel: true)), isFalse);
      expect(warns(long, (pool: true, fixedModel: false)), isFalse);
    });
  });
}
