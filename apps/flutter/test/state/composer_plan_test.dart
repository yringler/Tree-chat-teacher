import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/api/models.dart';
import 'package:tangent/state/composer_plan.dart';

import '../fakes.dart';

// The cases of composerPlan in packages/shared/src/composer-plan.spec.ts, by
// name. replyToAim's are the web's alone: Flutter has no `b`.

ChatNode question(String id, [String branchId = 'trunk']) =>
    node(id, branch: branchId, seq: 0);

ChatNode reply(
  String id, [
  String branchId = 'trunk',
  NodeStatus status = NodeStatus.complete,
]) => node(id, branch: branchId, seq: 0, role: Role.assistant, status: status);

/// The main thread: u1 a1 u2 a2.
final trunkPath = [question('u1'), reply('a1'), question('u2'), reply('a2')];

/// The tangent `side` from a1, as it is shown: u1 a1, then its own u3 a3 u4 a4.
final sidePath = [
  question('u1'),
  reply('a1'),
  question('u3', 'side'),
  reply('a3', 'side'),
  question('u4', 'side'),
  reply('a4', 'side'),
];

ComposerPlan onMain({
  List<ChatNode>? path,
  String? focusedId,
  ComposerLead? lead,
}) => composerPlan(
  path: path ?? trunkPath,
  branchId: 'trunk',
  inTangent: false,
  focusedId: focusedId,
  lead: lead,
);

ComposerPlan inSide({
  List<ChatNode>? path,
  String branchId = 'side',
  String? focusedId,
  ComposerLead? lead,
}) => composerPlan(
  path: path ?? sidePath,
  branchId: branchId,
  inTangent: true,
  focusedId: focusedId,
  lead: lead,
);

const tangent = (id: ComposerSendId.tangent, primary: true);
const next = (id: ComposerSendId.next, primary: false);

void main() {
  group('composerPlan', () {
    test('a new conversation: a plain Send, from the start', () {
      final plan = onMain(path: const []);
      expect(plan.target, isNull);
      expect(plan.actions, isEmpty);
      expect(plan.place, ComposerPlace.start);
      expect(plan.nameTarget, isFalse);
    });

    test('after a reply on the main thread: Tangent ↳ from it, filled, and '
        'Next ➜ on the main thread', () {
      final plan = onMain();
      expect(plan.target, 'a2');
      expect(plan.actions, [tangent, next]);
      expect(plan.place, ComposerPlace.main);
      expect(plan.nameTarget, isFalse);
    });

    test('inside a tangent: Tangent ↳ from its last reply, and Next ➜ '
        'continues the tangent, filled', () {
      final plan = inSide();
      expect(plan.target, 'a4');
      expect(plan.actions, [
        (id: ComposerSendId.tangent, primary: false),
        (id: ComposerSendId.next, primary: true),
      ]);
      expect(plan.place, ComposerPlace.tangent);
      expect(plan.nameTarget, isFalse);
    });

    test('a tangent opened at its start: from its first reply, named', () {
      final plan = inSide(focusedId: 'u3');
      expect(plan.target, 'a3');
      expect(plan.nameTarget, isTrue);
      expect(
        [for (final a in plan.actions) a.id],
        [ComposerSendId.tangent, ComposerSendId.next],
      );
    });

    test('a focused reply of the open thread: from it, named unless it is '
        'the last', () {
      expect(onMain(focusedId: 'a1').target, 'a1');
      expect(onMain(focusedId: 'a1').nameTarget, isTrue);
      expect(onMain(focusedId: 'a2').target, 'a2');
      expect(onMain(focusedId: 'a2').nameTarget, isFalse);
    });

    test('a focused message of an earlier thread is context: from the open '
        'thread’s last reply', () {
      for (final focusedId in ['u1', 'a1']) {
        expect(inSide(focusedId: focusedId).target, 'a4', reason: focusedId);
        expect(inSide(focusedId: focusedId).nameTarget, isFalse);
      }
    });

    test('a focused reply that failed, or the question it answers: from the '
        'last reply', () {
      final path = [
        question('u1'),
        reply('a1', 'trunk', NodeStatus.error),
        question('u2'),
        reply('a2'),
      ];
      for (final focusedId in ['u1', 'a1']) {
        expect(onMain(path: path, focusedId: focusedId).target, 'a2');
      }
    });

    test('the last reply failed: a plain Send that continues, unless a '
        'finished reply is focused', () {
      final path = [
        ...trunkPath.sublist(0, 3),
        reply('a2', 'trunk', NodeStatus.error),
      ];
      final plan = onMain(path: path);
      expect(plan.target, isNull);
      expect(plan.actions, isEmpty);
      expect(plan.place, ComposerPlace.main);
      // The question whose reply failed has nothing to go on from either.
      expect(onMain(path: path, focusedId: 'u2').target, isNull);
      expect(onMain(path: path, focusedId: 'a1').target, 'a1');
      expect(onMain(path: path, focusedId: 'a1').nameTarget, isTrue);
    });

    test('aimed at a message: only Tangent ↳, filled, from it, though it is '
        'in an earlier thread', () {
      final plan = inSide(lead: (nodeId: 'a1', quote: 'wave'), focusedId: 'u3');
      expect(plan.target, 'a1');
      expect(plan.actions, [tangent]);
      expect(plan.place, ComposerPlace.lead);
      expect(plan.nameTarget, isFalse);
    });

    test('an empty tangent: a plain Send that starts it, or Tangent ↳ once '
        'aimed', () {
      final empty = inSide(path: sidePath.sublist(0, 2), branchId: 'empty');
      expect(empty.target, isNull);
      expect(empty.actions, isEmpty);
      expect(empty.place, ComposerPlace.emptyTangent);
      expect(empty.nameTarget, isFalse);
      final aimed = inSide(
        path: sidePath.sublist(0, 2),
        branchId: 'empty',
        lead: (nodeId: 'a1', quote: null),
      );
      expect(aimed.target, 'a1');
      expect(aimed.actions, [tangent]);
      expect(aimed.place, ComposerPlace.lead);
    });
  });

  group('sentByEnter', () {
    ComposerSendId? sent(ComposerPlan plan, {bool modified = false}) =>
        sentByEnter(
          plan.actions,
          primary: (a) => a.primary,
          modified: modified,
        )?.id;

    test('Enter fires the filled action, Ctrl or Cmd+Enter the other', () {
      expect(sent(onMain()), ComposerSendId.tangent);
      expect(sent(onMain(), modified: true), ComposerSendId.next);
      expect(sent(inSide()), ComposerSendId.next);
      expect(sent(inSide(), modified: true), ComposerSendId.tangent);
    });

    test('one action takes both keys; none leaves the plain Send', () {
      final aimed = onMain(lead: (nodeId: 'a1', quote: 'wave'));
      expect(sent(aimed), ComposerSendId.tangent);
      expect(sent(aimed, modified: true), ComposerSendId.tangent);
      expect(sent(onMain(path: const [])), isNull);
      expect(sent(onMain(path: const []), modified: true), isNull);
    });
  });

  group('enterSends', () {
    bool sends(
      TargetPlatform platform, {
      bool web = true,
      bool modified = false,
    }) => enterSends(web: web, platform: platform, modified: modified);

    test('in a browser on a computer, Enter and Ctrl or Cmd+Enter send', () {
      for (final p in [
        TargetPlatform.linux,
        TargetPlatform.macOS,
        TargetPlatform.windows,
      ]) {
        expect(sends(p), isTrue, reason: '$p');
        expect(sends(p, modified: true), isTrue, reason: '$p');
      }
    });

    test('on a phone or tablet, Enter starts a new line and only the buttons '
        'send; Ctrl or Cmd+Enter still sends', () {
      for (final p in [TargetPlatform.android, TargetPlatform.iOS]) {
        expect(sends(p), isFalse, reason: '$p');
        expect(sends(p, modified: true), isTrue, reason: '$p');
      }
    });

    test('a native keyboard never sends: its Enter is a new line', () {
      for (final p in TargetPlatform.values) {
        expect(sends(p, web: false), isFalse, reason: '$p');
        expect(sends(p, web: false, modified: true), isFalse, reason: '$p');
      }
    });
  });

  group('sendTooltip', () {
    test('names the key that sends each button where Enter sends', () {
      expect(
        sendTooltip('Explore.', primary: true, keys: true),
        'Explore. (Enter)',
      );
      expect(
        sendTooltip('Go on.', primary: false, keys: true),
        'Go on. (Ctrl+Enter)',
      );
    });

    test('elsewhere, the hint alone: only the buttons send', () {
      expect(sendTooltip('Explore.', primary: true, keys: false), 'Explore.');
      expect(sendTooltip('Go on.', primary: false, keys: false), 'Go on.');
    });
  });
}
