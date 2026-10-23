import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/api/models.dart';
import 'package:tangent/api/reply_stream.dart';
import 'package:tangent/state/reply_follower.dart';

import '../fakes.dart';

ChatNode reply(String id, {NodeStatus status = NodeStatus.streaming}) =>
    node(id, branch: 'trunk', seq: 1, role: Role.assistant, status: status);

final start = StartEvent(
  userNode: node('u1', branch: 'trunk', seq: 0),
  assistantNode: reply('a1'),
  branch: branch('trunk'),
);
final done = DoneEvent(
  node: reply('a1', status: NodeStatus.complete),
  branch: branch('trunk'),
);

void main() {
  late FakeTangentApi api;
  late ReplyFollower follower;

  /// What the follower reported, in order.
  late List<String> log;

  /// The nodes the owner shows.
  late List<ChatNode> shown;

  /// What reading the lesson again does.
  late Future<void> Function() reloading;

  /// The last event given.
  StreamEvent? lastEvent;

  ReplyFollower make({ReconnectPolicy policy = const ReconnectPolicy()}) =>
      ReplyFollower(
        transport: api,
        onEvent: (event, replyId) {
          lastEvent = event;
          log.add('${event.runtimeType} $replyId');
        },
        nodes: () => shown,
        onError: (error) => log.add('error $error'),
        reload: () {
          log.add('reload');
          return reloading();
        },
        onEnded: () => log.add('ended'),
        delay: (_) async {},
        policy: policy,
      );

  setUp(() {
    api = FakeTangentApi();
    log = [];
    shown = [];
    reloading = () async {};
    lastEvent = null;
    follower = make();
  });

  tearDown(() => follower.dispose());

  group('send', () {
    test('completes with true at start, and is sending until then', () async {
      final accepted = follower.send('trunk', 'Why tides?');
      expect(api.sends.single.target, 'trunk');
      expect(api.sends.single.content, 'Why tides?');
      expect(follower.sending, isTrue);

      api.sends.single.controller.add(start);
      expect(await accepted, isTrue);
      expect(follower.sending, isFalse);
      expect(log, ['StartEvent a1']);
    });

    test('gives each event with its reply, then ends', () async {
      unawaited(follower.send('trunk', 'Why tides?'));
      api.sends.single.controller
        ..add(start)
        ..add(const DeltaEvent(nodeId: 'a1', text: 'The moon'))
        ..add(done);
      await pumpEventQueue();
      expect(log, ['StartEvent a1', 'DeltaEvent a1', 'DoneEvent a1', 'ended']);
    });

    test(
      'a refusal completes with false and reports it, with no reload',
      () async {
        api.refuseSend = const ApiException(
          status: 402,
          code: 'payment_required',
          message: 'No credit',
        );
        expect(await follower.send('trunk', 'Why tides?'), isFalse);
        await pumpEventQueue();
        expect(follower.sending, isFalse);
        expect(log, hasLength(2));
        expect(log.first, startsWith('error ApiException(402'));
        expect(log.last, 'ended');
      },
    );

    test('its reply is followed once started', () async {
      unawaited(follower.send('trunk', 'Why tides?'));
      expect(follower.isFollowing('a1'), isFalse);
      api.sends.single.controller.add(start);
      await pumpEventQueue();
      expect(follower.isFollowing('a1'), isTrue);

      follower.follow('a1');
      expect(api.resumes, isEmpty);
    });
  });

  group('follow', () {
    test('attaches to the reply', () {
      follower.follow('a1');
      expect(api.resumes.single.target, 'a1');
      expect(follower.isFollowing('a1'), isTrue);
    });

    test('is idempotent', () {
      follower
        ..follow('a1')
        ..follow('a1');
      expect(api.resumes, hasLength(1));
    });

    test('a reply that ended can be followed again', () async {
      follower.follow('a1');
      api.resumes.single.controller.add(done);
      await pumpEventQueue();
      expect(follower.isFollowing('a1'), isFalse);
      follower.follow('a1');
      expect(api.resumes, hasLength(2));
    });

    test('followAll follows the replies still being written', () {
      follower.followAll([
        node('u1', branch: 'trunk', seq: 0, status: NodeStatus.streaming),
        reply('a1'),
        reply('a2', status: NodeStatus.complete),
        reply('a3'),
      ]);
      expect([for (final s in api.resumes) s.target], ['a1', 'a3']);
    });
  });

  group('when a stream ends', () {
    test('a reply done is not reloaded', () async {
      follower.follow('a1');
      api.resumes.single.controller.add(done);
      await pumpEventQueue();
      expect(log, ['DoneEvent a1', 'ended']);
    });

    test('a reply no longer shown being written is not reloaded', () async {
      follower = make(policy: const ReconnectPolicy(maxReconnects: 0));
      unawaited(follower.send('trunk', 'Why tides?'));
      api.sends.single.controller.add(start);
      await api.sends.single.controller.close();
      await pumpEventQueue();
      expect(log, [
        'StartEvent a1',
        'error ApiException(0 network: Connection lost)',
        'ended',
      ]);
    });
  });

  group('a reply lost while shown being written', () {
    setUp(() {
      follower = make(policy: const ReconnectPolicy(maxReconnects: 1));
      shown = [reply('a1')];
    });

    /// Sends a message and loses its reply after `start`, and its one
    /// reconnect.
    Future<void> sendAndLose() async {
      unawaited(follower.send('trunk', 'Why tides?'));
      api.sends.single.controller.add(start);
      await api.sends.single.controller.close();
      await pumpEventQueue();
      await api.resumes.single.controller.close();
      await pumpEventQueue();
    }

    /// The attaches after the reconnect [sendAndLose] made.
    List<String> followedAgain() => [
      for (final r in api.resumes.skip(1)) r.target,
    ];

    test('is read again, with no notice when it has ended', () async {
      reloading = () async =>
          shown = [reply('a1', status: NodeStatus.complete)];
      await sendAndLose();
      expect(log, ['StartEvent a1', 'reload', 'ended']);
      expect(followedAgain(), isEmpty);
    });

    test('is followed again while the server still writes it', () async {
      reloading = () async => shown = [reply('a1'), reply('a2')];
      await sendAndLose();
      expect(followedAgain(), ['a1']);
      expect(log, ['StartEvent a1', 'reload', 'ended']);

      api.resumes.last.controller.add(done);
      await pumpEventQueue();
      expect(log.skip(3), ['DoneEvent a1', 'ended']);
    });

    test('is marked failed when lost again, without reading it again', () async {
      await sendAndLose();
      await api.resumes.last.controller.close();
      await pumpEventQueue();
      expect(log, [
        'StartEvent a1',
        'reload',
        'ended',
        'error ApiException(0 network: Connection lost)',
        'ErrorEvent a1',
        'ended',
      ]);
      expect(
        lastEvent,
        isA<ErrorEvent>()
            .having((e) => e.nodeId, 'nodeId', 'a1')
            .having((e) => e.node, 'node', isNull)
            .having(
              (e) => e.message,
              'message',
              'Connection lost. Open the lesson again to see the final reply.',
            ),
      );
      expect(followedAgain(), ['a1']);
    });

    test('is marked failed when the lesson cannot be read again', () async {
      reloading = () async => throw const ApiException(
        status: 0,
        code: 'network',
        message: 'offline',
      );
      await sendAndLose();
      expect(log, [
        'StartEvent a1',
        'reload',
        'error ApiException(0 network: offline)',
        'ErrorEvent a1',
        'ended',
      ]);
      expect(followedAgain(), isEmpty);
    });
  });

  group('a send lost before its reply started', () {
    final asked = node('u1', branch: 'trunk', seq: 2);

    setUp(() {
      // A message from before the send isn't taken for it.
      shown = [node('u0', branch: 'trunk', seq: 0)];
    });

    test('is read again, and is sending until then', () async {
      final read = Completer<void>();
      reloading = () => read.future;
      final accepted = follower.send('trunk', 'Why tides?');
      await api.sends.single.controller.close();
      await pumpEventQueue();
      expect(log, ['reload']);
      expect(follower.sending, isTrue);

      read.complete();
      expect(await accepted, isFalse);
      expect(follower.sending, isFalse);
    });

    test('completes with true when its message reached the server, and '
        'follows the replies still being written', () async {
      reloading = () async =>
          shown = [...shown, asked, reply('a1'), reply('a9')];
      final accepted = follower.send('trunk', 'Why tides?');
      await api.sends.single.controller.close();
      expect(await accepted, isTrue);
      await pumpEventQueue();
      expect(log, ['reload', 'ended']);
      expect([for (final r in api.resumes) r.target], ['a1', 'a9']);
    });

    test('completes with true when its reply has already ended too', () async {
      reloading = () async =>
          shown = [...shown, asked, reply('a1', status: NodeStatus.complete)];
      final accepted = follower.send('trunk', 'Why tides?');
      await api.sends.single.controller.close();
      expect(await accepted, isTrue);
      await pumpEventQueue();
      expect(log, ['reload', 'ended']);
      expect(api.resumes, isEmpty);
    });

    test(
      'completes with false and reports why when its message is not there',
      () async {
        final accepted = follower.send('trunk', 'Why tides?');
        await api.sends.single.controller.close();
        expect(await accepted, isFalse);
        await pumpEventQueue();
        expect(log, hasLength(3));
        expect(log.first, 'reload');
        expect(log[1], contains('The reply ended before it started'));
        expect(log.last, 'ended');
      },
    );

    test(
      'completes with false and reports why the lesson cannot be read',
      () async {
        reloading = () async => throw const ApiException(
          status: 0,
          code: 'network',
          message: 'offline',
        );
        final accepted = follower.send('trunk', 'Why tides?');
        await api.sends.single.controller.close();
        expect(await accepted, isFalse);
        await pumpEventQueue();
        expect(log, [
          'reload',
          'error ApiException(0 network: offline)',
          'ended',
        ]);
      },
    );
  });

  group('dispose', () {
    test('stops every stream, and reports nothing after', () async {
      final cancelled = <String>[];
      unawaited(follower.send('trunk', 'Why tides?'));
      follower
        ..follow('a7')
        ..follow('a8');
      await pumpEventQueue();
      for (final scripted in [...api.sends, ...api.resumes]) {
        scripted.controller.onCancel = () => cancelled.add(scripted.target);
      }
      api.sends.single.controller.add(start);
      await pumpEventQueue();
      log.clear();

      follower.dispose();
      await pumpEventQueue();
      expect(cancelled, unorderedEquals(['trunk', 'a7', 'a8']));
      expect(log, isEmpty);

      follower.follow('a9');
      expect(api.resumes, hasLength(2));
    });

    test('reports nothing when a reload it waits on ends after', () async {
      follower = make(policy: const ReconnectPolicy(maxReconnects: 0));
      shown = [reply('a1')];
      final read = Completer<void>();
      reloading = () => read.future;
      unawaited(follower.send('trunk', 'Why tides?'));
      api.sends.single.controller.add(start);
      await api.sends.single.controller.close();
      await pumpEventQueue();
      expect(log, ['StartEvent a1', 'reload']);

      follower.dispose();
      read.complete();
      await pumpEventQueue();
      expect(log, ['StartEvent a1', 'reload']);
      expect(api.resumes, isEmpty);
    });

    test('reports nothing when a reload it waits on fails after', () async {
      final read = Completer<void>();
      reloading = () => read.future;
      final accepted = follower.send('trunk', 'Why tides?');
      var settled = false;
      unawaited(accepted.then((_) => settled = true));
      await api.sends.single.controller.close();
      await pumpEventQueue();
      expect(log, ['reload']);

      follower.dispose();
      read.completeError(
        const ApiException(status: 0, code: 'network', message: 'offline'),
      );
      await pumpEventQueue();
      expect(log, ['reload']);
      expect(settled, isFalse);
    });
  });
}
