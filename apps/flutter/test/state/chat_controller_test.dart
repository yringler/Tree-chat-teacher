import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/state/chat_controller.dart';
import 'package:tangent/state/lessons_controller.dart';
import 'package:tangent/state/session_controller.dart';

import '../fakes.dart';

void main() {
  group('cameFromIds', () {
    late ChatController chat;

    /// The main thread with Moon › Deep and Sun under its first reply.
    setUp(() async {
      final api = FakeTangentApi()
        ..details['t1'] = treeDetail(
          branches: [
            branch('trunk'),
            branch('moon', parent: 'trunk', fork: 'a1'),
            branch('deep', parent: 'moon', fork: 'm1'),
            branch('sun', parent: 'trunk', fork: 'a1'),
          ],
        );
      final session = SessionController(api);
      chat = ChatController(
        api: api,
        session: session,
        lessons: LessonsController(api: api, session: session),
        treeId: 't1',
      );
      await chat.load();
    });

    tearDown(() => chat.dispose());

    test('is empty when the lesson opens', () {
      expect(chat.cameFromIds, isEmpty);
    });

    test('stays empty going deeper', () {
      chat.selectBranch('moon');
      expect(chat.cameFromIds, isEmpty);
      chat.selectBranch('deep');
      expect(chat.cameFromIds, isEmpty);
    });

    test('back on the parent, holds the tangent left', () {
      chat
        ..selectBranch('moon')
        ..selectBranch(null);
      expect(chat.cameFromIds, {'moon'});
    });

    test('back on the main thread from deeper, holds every tangent left', () {
      chat
        ..selectBranch('deep')
        ..selectBranch(null);
      expect(chat.cameFromIds, {'moon', 'deep'});
    });

    test('back one step, holds only the step left', () {
      chat
        ..selectBranch('deep')
        ..selectBranch('moon');
      expect(chat.cameFromIds, {'deep'});
    });

    test('across to another tangent, holds the one left', () {
      chat
        ..selectBranch('moon')
        ..selectBranch('sun');
      expect(chat.cameFromIds, {'moon'});
    });

    test('clears on going back into the tangent', () {
      chat
        ..selectBranch('moon')
        ..selectBranch(null)
        ..selectBranch('moon');
      expect(chat.cameFromIds, isEmpty);
    });
  });
}
