import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/api/models.dart';
import 'package:tangent/state/lessons_controller.dart';
import 'package:tangent/state/session_controller.dart';

import '../fakes.dart';

void main() {
  test(
    'reads the providers again whenever the key replies run on changes',
    () async {
      final api = FakeTangentApi()
        ..poolStatusAnswer = const PoolStatus(enabled: true, modelLabel: null)
        ..keyStatusAnswer = const KeyStatus(
          enabled: true,
          providers: ['anthropic'],
          learnProviders: [LearnKey.openRouter, LearnKey.anthropic],
        );
      final session = SessionController(
        api,
        keyChoiceStore: MemoryStore()..value = 'anthropic',
        choiceStore: MemoryStore()..value = 'own-key',
      );
      final lessons = LessonsController(api: api, session: session);
      await session.start();
      await lessons.load();
      expect(api.providersCalls, 1);

      // Off the Anthropic key: the built-in endpoint's list.
      await session.choose(Payer.pool);
      await pumpEventQueue();
      expect(api.providersCalls, 2);
      // Credit runs on the same endpoint as the pool: nothing to read again.
      await session.choose(Payer.credit);
      await pumpEventQueue();
      expect(api.providersCalls, 2);
      await session.chooseKey(LearnKey.anthropic);
      await pumpEventQueue();
      expect(api.providersCalls, 3);
    },
  );
}
