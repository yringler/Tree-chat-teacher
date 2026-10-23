import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/api/models.dart';
import 'package:tangent/api/reply_stream.dart';

import '../fakes.dart';

/// One connection's answer: its body, or an error thrown before any event.
typedef Answer = Stream<StreamEvent> Function();

/// A [ReplyTransport] answering each connection with the next of [answers],
/// and recording what was opened.
class FakeTransport implements ReplyTransport {
  FakeTransport(this.answers);

  final List<Answer> answers;
  final sent = <String>[];
  final attached = <String>[];

  @override
  Future<Stream<StreamEvent>> sendMessage(
    String branchId,
    String content,
  ) async {
    sent.add(branchId);
    return answers.removeAt(0)();
  }

  @override
  Future<Stream<StreamEvent>> attachReply(String nodeId) async {
    attached.add(nodeId);
    return answers.removeAt(0)();
  }
}

/// A body of [events], ending cleanly or failing with [error].
Answer body(List<StreamEvent> events, {Object? error}) => () async* {
  yield* Stream.fromIterable(events);
  if (error != null) throw error;
};

/// A connection the server refuses with [error].
Answer refuse(Object error) =>
    () => throw error;

const lost = ApiException(status: 0, code: 'network', message: 'reset');
const down = ApiException(status: 503, code: 'internal', message: 'Down');

ApiException status(int code) =>
    ApiException(status: code, code: 'http_$code', message: 'HTTP $code');

ChatNode reply(String id, {NodeStatus status = NodeStatus.streaming}) =>
    node(id, branch: 'b1', seq: 1, role: Role.assistant, status: status);

final start = StartEvent(
  userNode: node('u1', branch: 'b1', seq: 0),
  assistantNode: reply('a1'),
  branch: branch('b1'),
);
SnapshotEvent snapshot([String id = 'a1']) => SnapshotEvent(reply(id));
DeltaEvent delta(String text) => DeltaEvent(nodeId: 'a1', text: text);
final done = DoneEvent(
  node: reply('a1', status: NodeStatus.complete),
  branch: branch('b1'),
);
const failed = ErrorEvent(nodeId: 'a1', message: 'Cancelled', node: null);

List<String> types(List<StreamEvent> events) => [
  for (final event in events)
    switch (event) {
      StartEvent() => 'start',
      SnapshotEvent() => 'snapshot',
      StatusEvent() => 'status',
      DeltaEvent() => 'delta',
      DoneEvent() => 'done',
      ErrorEvent() => 'error',
    },
];

Matcher isLost(Object error, {required String? replyId}) => isA<ReplyLost>()
    .having((o) => o.error, 'error', error)
    .having((o) => o.replyId, 'replyId', replyId);

void main() {
  late FakeTimers timers;
  late List<StreamEvent> events;

  /// The waits before reconnects, which the timers don't wait.
  List<Duration> delays() => timers.durations;

  ReplyStream send(FakeTransport transport) => ReplyStream.send(
    transport,
    branchId: 'b1',
    content: 'hi',
    startTimer: timers.call,
  );

  ReplyStream attach(FakeTransport transport, [String id = 'a1']) =>
      ReplyStream.attach(transport, id, startTimer: timers.call);

  setUp(() {
    timers = FakeTimers();
    events = [];
  });

  group('a send', () {
    test('streams the reply to its done event', () async {
      final transport = FakeTransport([
        body([start, delta('Hel'), delta('lo'), done]),
      ]);
      final outcome = await send(transport).run(events.add);
      expect(outcome, isA<ReplyDone>().having((o) => o.event, 'event', done));
      expect(types(events), ['start', 'delta', 'delta', 'done']);
      expect(transport.sent, ['b1']);
      expect(transport.attached, isEmpty);
    });

    test('ends with the error event that ends the reply', () async {
      final transport = FakeTransport([
        body([start, failed]),
      ]);
      final outcome = await send(transport).run(events.add);
      expect(
        outcome,
        isA<ReplyErrored>().having((o) => o.event, 'event', failed),
      );
      expect(transport.attached, isEmpty);
    });

    test('is opened before run returns its future', () {
      final transport = FakeTransport([
        body([start, done]),
      ]);
      unawaited(send(transport).run(events.add));
      expect(transport.sent, ['b1']);
    });

    test('a refusal ends it before any event, with no reconnect', () async {
      final refusal = status(409);
      final transport = FakeTransport([refuse(refusal)]);
      final outcome = await send(transport).run(events.add);
      expect(
        outcome,
        isA<ReplyRefused>().having((o) => o.error, 'error', refusal),
      );
      expect(events, isEmpty);
      expect(transport.attached, isEmpty);
    });

    test('a network failure on the send is lost before any reply', () async {
      final transport = FakeTransport([refuse(lost)]);
      final outcome = await send(transport).run(events.add);
      expect(outcome, isLost(lost, replyId: null));
      expect(transport.attached, isEmpty);
    });

    test('a body that ends before start is lost, not resumed', () async {
      final transport = FakeTransport([body([])]);
      final outcome = await send(transport).run(events.add);
      expect(
        outcome,
        isA<ReplyLost>()
            .having((o) => o.replyId, 'replyId', isNull)
            .having(
              (o) => o.error,
              'error',
              isA<ApiException>().having(
                (e) => e.message,
                'message',
                'The reply ended before it started (Connection lost)',
              ),
            ),
      );
      expect(transport.attached, isEmpty);
    });
  });

  group('reconnects', () {
    test('after a body that ends early, to the reply start named', () async {
      final transport = FakeTransport([
        body([start, delta('Hel')]),
        body([snapshot(), delta('lo'), done]),
      ]);
      final stream = send(transport);
      final outcome = await stream.run(events.add);
      expect(outcome, isA<ReplyDone>());
      expect(types(events), ['start', 'delta', 'snapshot', 'delta', 'done']);
      expect(transport.attached, ['a1']);
      expect(stream.replyId, 'a1');
      expect(delays(), [const Duration(milliseconds: 500)]);
    });

    test('after a connection lost mid-body', () async {
      final transport = FakeTransport([
        body([start, delta('Hel')], error: lost),
        body([done]),
      ]);
      final outcome = await send(transport).run(events.add);
      expect(outcome, isA<ReplyDone>());
      expect(types(events), ['start', 'delta', 'done']);
      expect(transport.attached, ['a1']);
    });

    test('backs off and gives up after four in a row, lost', () async {
      final transport = FakeTransport([
        body([start]),
        for (var i = 0; i < 4; i++) refuse(down),
      ]);
      final outcome = await send(transport).run(events.add);
      expect(outcome, isLost(down, replyId: 'a1'));
      expect(transport.attached, hasLength(4));
      expect(delays().map((d) => d.inMilliseconds), [500, 1000, 2000, 4000]);
    });

    test('a body that ends early counts as an attempt, as lost', () async {
      final transport = FakeTransport([
        body([start]),
        for (var i = 0; i < 4; i++) body([]),
      ]);
      final outcome = await send(transport).run(events.add);
      expect(
        outcome,
        isA<ReplyLost>().having(
          (o) => o.error,
          'error',
          isA<ApiException>().having((e) => e.code, 'code', 'network'),
        ),
      );
      expect(transport.attached, hasLength(4));
    });

    test('an event starts the count and the backoff again', () async {
      final transport = FakeTransport([
        body([start]),
        refuse(down),
        body([snapshot()]),
        body([done]),
      ]);
      final outcome = await send(transport).run(events.add);
      expect(outcome, isA<ReplyDone>());
      expect(delays().map((d) => d.inMilliseconds), [500, 1000, 500]);
    });

    test('stop at a permanent refusal', () async {
      final gone = status(404);
      final transport = FakeTransport([
        body([start]),
        refuse(gone),
      ]);
      final outcome = await send(transport).run(events.add);
      expect(outcome, isLost(gone, replyId: 'a1'));
      expect(transport.attached, hasLength(1));
    });

    test('go on after a timeout or a rate limit', () async {
      final transport = FakeTransport([
        body([start]),
        refuse(status(408)),
        refuse(status(429)),
        body([done]),
      ]);
      final outcome = await send(transport).run(events.add);
      expect(outcome, isA<ReplyDone>());
      expect(transport.attached, hasLength(3));
    });

    test('not after an error that is not a lost connection', () async {
      const bug = FormatException('bad event');
      final transport = FakeTransport([
        body([start], error: bug),
      ]);
      final outcome = await send(transport).run(events.add);
      expect(outcome, isLost(bug, replyId: 'a1'));
      expect(transport.attached, isEmpty);
    });

    test('not after a reconnect that fails some other way', () async {
      final bug = StateError('no client');
      final transport = FakeTransport([
        body([start]),
        refuse(bug),
      ]);
      final outcome = await send(transport).run(events.add);
      expect(outcome, isLost(bug, replyId: 'a1'));
      expect(transport.attached, hasLength(1));
    });
  });

  group('an attach', () {
    test('attaches at once, then streams to the end', () async {
      final transport = FakeTransport([
        body([snapshot(), failed]),
      ]);
      final outcome = await attach(transport).run(events.add);
      expect(outcome, isA<ReplyErrored>());
      expect(types(events), ['snapshot', 'error']);
      expect(transport.sent, isEmpty);
      expect(transport.attached, ['a1']);
      expect(delays(), isEmpty);
    });

    test('waits from its second attempt, doubling', () async {
      final transport = FakeTransport([
        refuse(down),
        refuse(down),
        body([done]),
      ]);
      await attach(transport).run(events.add);
      expect(delays().map((d) => d.inMilliseconds), [1000, 2000]);
    });

    test('follows the reply its snapshot names', () async {
      final transport = FakeTransport([
        body([snapshot('a2')]),
        body([done]),
      ]);
      final stream = attach(transport);
      await stream.run(events.add);
      expect(transport.attached, ['a1', 'a2']);
      expect(stream.replyId, 'a2');
    });

    test('names its reply for each event as it arrives', () async {
      final transport = FakeTransport([
        body([start, delta('x'), done]),
      ]);
      final stream = send(transport);
      final seen = <String?>[];
      expect(stream.replyId, isNull);
      await stream.run((_) => seen.add(stream.replyId));
      expect(seen, ['a1', 'a1', 'a1']);
    });
  });

  group('cancel', () {
    test('stops the body being read, and gives no more events', () async {
      final live = StreamController<StreamEvent>();
      var bodyCancelled = false;
      live.onCancel = () => bodyCancelled = true;
      final transport = FakeTransport([() => live.stream]);
      final stream = send(transport);
      final outcome = stream.run(events.add);
      live.add(start);
      await pumpEventQueue();
      stream.cancel();
      live.add(delta('late'));
      expect(await outcome, isA<ReplyCancelled>());
      expect(types(events), ['start']);
      expect(bodyCancelled, isTrue);
    });

    test(
      'during the wait before a reconnect, stops it and the stream',
      () async {
        final held = FakeTimers(hold: true);
        final transport = FakeTransport([
          body([start]),
        ]);
        final stream = ReplyStream.send(
          transport,
          branchId: 'b1',
          content: 'hi',
          startTimer: held.call,
        );
        final outcome = stream.run(events.add);
        await pumpEventQueue();
        expect(held.started.single.isActive, isTrue);
        stream.cancel();
        expect(held.started.single.isActive, isFalse);
        expect(await outcome, isA<ReplyCancelled>());
        await pumpEventQueue();
        expect(transport.attached, isEmpty);
      },
    );

    test('during the wait before a reconnect, leaves no timer running', () {
      fakeAsync((async) {
        final transport = FakeTransport([
          body([start]),
        ]);
        final stream = ReplyStream.send(
          transport,
          branchId: 'b1',
          content: 'hi',
        );
        ReplyOutcome? outcome;
        unawaited(stream.run(events.add).then((o) => outcome = o));
        async.flushMicrotasks();
        expect(async.pendingTimers, hasLength(1));

        stream.cancel();
        async.flushMicrotasks();
        expect(outcome, isA<ReplyCancelled>());
        expect(async.pendingTimers, isEmpty);
      });
    });

    test('while the send is unanswered', () async {
      final answer = Completer<Stream<StreamEvent>>();
      final stream = ReplyStream.send(
        _Unanswered(answer.future),
        branchId: 'b1',
        content: 'hi',
      );
      final outcome = stream.run(events.add);
      stream.cancel();
      expect(await outcome, isA<ReplyCancelled>());
      answer.complete(Stream.value(start));
      await pumpEventQueue();
      expect(events, isEmpty);
    });

    test('from inside an event stops at that event', () async {
      final transport = FakeTransport([
        body([start, delta('x'), done]),
      ]);
      final stream = send(transport);
      final outcome = await stream.run((event) {
        events.add(event);
        stream.cancel();
      });
      expect(outcome, isA<ReplyCancelled>());
      expect(types(events), ['start']);
    });
  });

  group('ReconnectPolicy', () {
    test('treats a 4xx as permanent, but not a timeout or a rate limit', () {
      expect(ReconnectPolicy.isPermanent(status(400)), isTrue);
      expect(ReconnectPolicy.isPermanent(status(404)), isTrue);
      expect(ReconnectPolicy.isPermanent(status(408)), isFalse);
      expect(ReconnectPolicy.isPermanent(status(429)), isFalse);
      expect(ReconnectPolicy.isPermanent(status(500)), isFalse);
      expect(ReconnectPolicy.isPermanent(lost), isFalse);
    });

    test('doubles the wait, from none for an attach’s first try', () {
      expect(ReconnectPolicy.delayBefore(0, sent: false), Duration.zero);
      expect(ReconnectPolicy.delayBefore(1, sent: false).inMilliseconds, 1000);
      expect(ReconnectPolicy.delayBefore(0, sent: true).inMilliseconds, 500);
      expect(ReconnectPolicy.delayBefore(3, sent: true).inMilliseconds, 4000);
    });
  });
}

/// A transport whose send answers with [answer], whenever it completes.
class _Unanswered implements ReplyTransport {
  _Unanswered(this.answer);
  final Future<Stream<StreamEvent>> answer;

  @override
  Future<Stream<StreamEvent>> sendMessage(String branchId, String content) =>
      answer;

  @override
  Future<Stream<StreamEvent>> attachReply(String nodeId) =>
      throw UnimplementedError();
}
