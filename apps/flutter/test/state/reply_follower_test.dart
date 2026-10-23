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

  /// The replies the owner shows being written.
  late Set<String> streaming;

  ReplyFollower make({ReconnectPolicy policy = const ReconnectPolicy()}) =>
      ReplyFollower(
        transport: api,
        onEvent: (event, replyId) => log.add('${event.runtimeType} $replyId'),
        isStreaming: streaming.contains,
        onError: (error) => log.add('error $error'),
        reload: () async => log.add('reload'),
        onEnded: () => log.add('ended'),
        delay: (_) async {},
        policy: policy,
      );

  setUp(() {
    api = FakeTangentApi();
    log = [];
    streaming = {};
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

    test(
      'a reply lost while shown being written reports why and reloads',
      () async {
        follower = make(policy: const ReconnectPolicy(maxReconnects: 0));
        streaming.add('a1');
        unawaited(follower.send('trunk', 'Why tides?'));
        api.sends.single.controller.add(start);
        await api.sends.single.controller.close();
        await pumpEventQueue();
        expect(log, [
          'StartEvent a1',
          'error ApiException(0 network: Connection lost)',
          'reload',
          'ended',
        ]);
      },
    );

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

    test(
      'a send lost before start completes with false, with no reload',
      () async {
        final accepted = follower.send('trunk', 'Why tides?');
        await api.sends.single.controller.close();
        expect(await accepted, isFalse);
        await pumpEventQueue();
        expect(log, hasLength(2));
        expect(log.first, contains('The reply ended before it started'));
        expect(log.last, 'ended');
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
  });
}
