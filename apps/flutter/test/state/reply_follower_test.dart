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

/// A [ReplyHost] that shows [shown] and logs what it is asked, in order.
class FakeHost implements ReplyHost {
  final log = <String>[];

  /// The nodes it shows.
  List<ChatNode> shown = [];

  /// What reading the lesson again does.
  Future<void> Function() reloading = () async {};

  @override
  Iterable<ChatNode> get nodes => shown;

  @override
  void apply(StreamEvent event, String? replyId) =>
      log.add('${event.runtimeType} $replyId');

  @override
  void markFailed(String replyId, String message) =>
      log.add('failed $replyId: $message');

  @override
  void report(Object error) => log.add('error $error');

  @override
  void resolved(Object error) => log.add('resolved $error');

  @override
  Future<void> reload() {
    log.add('reload');
    return reloading();
  }

  @override
  void changed() => log.add('changed');
}

void main() {
  late FakeTangentApi api;
  late FakeHost host;
  late ReplyFollower follower;

  /// What the follower asked of its host, in order.
  late List<String> log;

  /// The follower's timers, which fire at once.
  late FakeTimers timers;

  ReplyFollower make({bool holdTimers = false}) {
    // The waits to read the lesson again for a reply given up on are held:
    // a test fires them.
    timers = FakeTimers(
      hold: holdTimers,
      holdFrom: ReplyFollower.checkAgainDelay,
    );
    return ReplyFollower(transport: api, host: host, startTimer: timers.call);
  }

  /// Loses each reconnect a stream makes before it gives up, after its
  /// connection was lost.
  Future<void> loseReconnects() async {
    for (var i = 0; i < ReconnectPolicy.maxReconnects; i++) {
      await pumpEventQueue();
      await api.resumes.last.controller.close();
    }
    await pumpEventQueue();
  }

  setUp(() {
    api = FakeTangentApi();
    host = FakeHost();
    log = host.log;
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
      expect(log, [
        'StartEvent a1',
        'DeltaEvent a1',
        'DoneEvent a1',
        'changed',
      ]);
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
        expect(log.last, 'changed');
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
      expect(log, ['DoneEvent a1', 'changed']);
    });

    test(
      'a reply an error event ends without naming it is marked failed',
      () async {
        host.shown = [reply('a1')];
        follower.follow('a1');
        api.resumes.single.controller.add(
          const ErrorEvent(nodeId: null, message: 'Boom', node: null),
        );
        await pumpEventQueue();
        expect(log, ['ErrorEvent a1', 'failed a1: Boom', 'changed']);
      },
    );

    test('a reply no longer shown being written is not reloaded', () async {
      unawaited(follower.send('trunk', 'Why tides?'));
      api.sends.single.controller.add(start);
      await api.sends.single.controller.close();
      await loseReconnects();
      expect(log, [
        'StartEvent a1',
        'error ApiException(0 network: Connection lost)',
        'changed',
      ]);
    });
  });

  group('a reply lost while shown being written', () {
    setUp(() => host.shown = [reply('a1')]);

    const offline = ApiException(
      status: 0,
      code: 'network',
      message: 'offline',
    );

    /// Sends a message and loses its reply after `start`, and its
    /// reconnects.
    Future<void> sendAndLose() async {
      unawaited(follower.send('trunk', 'Why tides?'));
      api.sends.single.controller.add(start);
      await api.sends.single.controller.close();
      await loseReconnects();
    }

    /// The attaches after the reconnects [sendAndLose] made.
    List<String> followedAgain() => [
      for (final r in api.resumes.skip(ReconnectPolicy.maxReconnects)) r.target,
    ];

    test('is read again, with no notice when it has ended', () async {
      host.reloading = () async =>
          host.shown = [reply('a1', status: NodeStatus.complete)];
      await sendAndLose();
      expect(log, ['StartEvent a1', 'reload', 'changed']);
      expect(followedAgain(), isEmpty);
    });

    test('is followed again while the server still writes it', () async {
      host.reloading = () async => host.shown = [reply('a1'), reply('a2')];
      await sendAndLose();
      expect(followedAgain(), ['a1']);
      expect(log, ['StartEvent a1', 'reload', 'changed']);

      api.resumes.last.controller.add(done);
      await pumpEventQueue();
      expect(log.skip(3), ['DoneEvent a1', 'changed']);
    });

    test(
      'is marked failed when lost again, without reading it again',
      () async {
        await sendAndLose();
        await loseReconnects();
        expect(log, [
          'StartEvent a1',
          'reload',
          'changed',
          'error ApiException(0 network: Connection lost)',
          'failed a1: $connectionLostText',
          'changed',
        ]);
        expect(
          connectionLostText,
          'Connection lost. The reply shows here once the connection is back.',
        );
        expect(followedAgain().toSet(), {'a1'});
      },
    );

    test('is read again when lost again after it made progress', () async {
      await sendAndLose();
      api.resumes.last.controller.add(
        const DeltaEvent(nodeId: 'a1', text: ' more'),
      );
      await pumpEventQueue();
      // The live body, then the reconnects that event started again.
      await api.resumes.last.controller.close();
      await loseReconnects();
      expect(log, [
        'StartEvent a1',
        'reload',
        'changed',
        'DeltaEvent a1',
        'reload',
        'changed',
      ]);
      expect(followedAgain().last, 'a1');
    });

    test('given up on, is read again later and shown as the server has it, '
        'with its error withdrawn', () async {
      var reads = 0;
      host.reloading = () async {
        if (++reads == 1) throw offline;
        host.shown = [reply('a1', status: NodeStatus.complete)];
      };
      await sendAndLose();
      expect(log, [
        'StartEvent a1',
        'reload',
        'error $offline',
        'failed a1: $connectionLostText',
        'changed',
      ]);
      expect(timers.started.last.duration, ReplyFollower.checkAgainDelay);

      timers.started.last.fire();
      await pumpEventQueue();
      expect(log.skip(5), ['reload', 'resolved $offline', 'changed']);
      expect(followedAgain(), isEmpty);
    });

    test('given up on, waits longer each time the lesson cannot be read, '
        'reports once, and follows the reply again', () async {
      var reads = 0;
      host.reloading = () async {
        if (++reads <= 5) throw offline;
        host.shown = [reply('a1')];
      };
      await sendAndLose();
      final waits = <Duration>[];
      for (var i = 0; i < 4; i++) {
        waits.add(timers.started.last.duration);
        timers.started.last.fire();
        await pumpEventQueue();
      }
      expect(waits, const [
        Duration(seconds: 5),
        Duration(seconds: 10),
        Duration(seconds: 20),
        Duration(seconds: 40),
      ]);
      expect(timers.started.last.duration, ReplyFollower.checkAgainMaxDelay);
      timers.started.last.fire();
      await pumpEventQueue();
      expect(log.where((line) => line.startsWith('error')), ['error $offline']);
      expect(log.skip(log.length - 2), ['resolved $offline', 'changed']);
      expect(followedAgain(), ['a1']);

      api.resumes.last.controller.add(done);
      await pumpEventQueue();
      expect(log.skip(log.length - 2), ['DoneEvent a1', 'changed']);
    });

    test('given up on, stops reading the lesson again once disposed', () async {
      host.reloading = () async => throw offline;
      await sendAndLose();
      follower.dispose();
      timers.started.last.fire();
      await pumpEventQueue();
      expect(log.where((line) => line == 'reload'), hasLength(1));
    });

    test('is marked failed when the lesson cannot be read again', () async {
      host.reloading = () async => throw const ApiException(
        status: 0,
        code: 'network',
        message: 'offline',
      );
      await sendAndLose();
      expect(log, [
        'StartEvent a1',
        'reload',
        'error ApiException(0 network: offline)',
        'failed a1: $connectionLostText',
        'changed',
      ]);
      expect(followedAgain(), isEmpty);
    });
  });

  group('a send lost before its reply started', () {
    final asked = node('u1', branch: 'trunk', seq: 2);

    setUp(() {
      // A message from before the send isn't taken for it.
      host.shown = [node('u0', branch: 'trunk', seq: 0)];
    });

    test('is read again, and is sending until then', () async {
      final read = Completer<void>();
      host.reloading = () => read.future;
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
      host.reloading = () async =>
          host.shown = [...host.shown, asked, reply('a1'), reply('a9')];
      final accepted = follower.send('trunk', 'Why tides?');
      await api.sends.single.controller.close();
      expect(await accepted, isTrue);
      await pumpEventQueue();
      expect(log, ['reload', 'changed']);
      expect([for (final r in api.resumes) r.target], ['a1', 'a9']);
    });

    test('completes with true when its reply has already ended too', () async {
      host.reloading = () async => host.shown = [
        ...host.shown,
        asked,
        reply('a1', status: NodeStatus.complete),
      ];
      final accepted = follower.send('trunk', 'Why tides?');
      await api.sends.single.controller.close();
      expect(await accepted, isTrue);
      await pumpEventQueue();
      expect(log, ['reload', 'changed']);
      expect(api.resumes, isEmpty);
    });

    test(
      'completes with false and reports why when its message is not there',
      () async {
        final accepted = follower.send('trunk', 'Why tides?');
        await api.sends.single.controller.close();
        expect(await accepted, isFalse);
        await pumpEventQueue();
        expect(log, hasLength(4));
        expect(log.take(2), ['reload', 'reload']);
        expect(log[2], contains('The reply ended before it started'));
        expect(log.last, 'changed');
      },
    );

    test('is read once more 3s later when its message is not there yet, '
        'as the server may still be writing it', () async {
      var reads = 0;
      host.reloading = () async {
        if (++reads == 2) host.shown = [...host.shown, asked, reply('a1')];
      };
      final accepted = follower.send('trunk', 'Why tides?');
      await api.sends.single.controller.close();
      expect(await accepted, isTrue);
      await pumpEventQueue();
      expect(log, ['reload', 'reload', 'changed']);
      expect(timers.durations, [const Duration(seconds: 3)]);
      expect([for (final r in api.resumes) r.target], ['a1']);
    });

    test(
      'completes with false and reports why the lesson cannot be read',
      () async {
        host.reloading = () async => throw const ApiException(
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
          'changed',
        ]);
      },
    );
  });

  group('dispose', () {
    test('during the wait to read a lost send again, stops the wait, and '
        'completes the send with false', () async {
      follower = make(holdTimers: true);
      final accepted = follower.send('trunk', 'Why tides?');
      await api.sends.single.controller.close();
      await pumpEventQueue();
      expect(log, ['reload']);
      expect(timers.started.single.isActive, isTrue);

      follower.dispose();
      expect(timers.started.single.isActive, isFalse);
      expect(await accepted.timeout(const Duration(seconds: 1)), isFalse);
      await pumpEventQueue();
      expect(log, ['reload']);
    });

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
      host.shown = [reply('a1')];
      final read = Completer<void>();
      host.reloading = () => read.future;
      unawaited(follower.send('trunk', 'Why tides?'));
      api.sends.single.controller.add(start);
      await api.sends.single.controller.close();
      await loseReconnects();
      expect(log, ['StartEvent a1', 'reload']);

      follower.dispose();
      read.complete();
      await pumpEventQueue();
      expect(log, ['StartEvent a1', 'reload']);
      expect(api.resumes, hasLength(ReconnectPolicy.maxReconnects));
    });

    test('reports nothing when a reload it waits on fails after', () async {
      final read = Completer<void>();
      host.reloading = () => read.future;
      final accepted = follower.send('trunk', 'Why tides?');
      await api.sends.single.controller.close();
      await pumpEventQueue();
      expect(log, ['reload']);

      follower.dispose();
      read.completeError(
        const ApiException(status: 0, code: 'network', message: 'offline'),
      );
      expect(await accepted, isFalse);
      await pumpEventQueue();
      expect(log, ['reload']);
    });

    test('settles a send waiting for its start as not started', () async {
      final accepted = follower.send('trunk', 'Why tides?');
      await pumpEventQueue();
      follower.dispose();
      expect(await accepted.timeout(const Duration(seconds: 1)), isFalse);
      expect(follower.sending, isFalse);
      expect(log, isEmpty);
    });
  });
}
