// A reply's stream with reconnects, matching
// packages/web-shared/src/sse/stream-runner.ts. Pure Dart: the HTTP side is
// a [ReplyTransport], and the waits between reconnects are timers from an
// injected [StartTimer], so it tests without a server or real time.

import 'dart:async';

import 'models.dart';

/// Opens the connections a reply's stream is made of, one at a time. Each
/// answers a 2xx response's body as events; anything else throws
/// [ApiException] before any event. A body fails with [ApiException] when
/// its connection is lost; any other error there is a bug, and ends the
/// reply's stream without a reconnect. Once [abort] completes, the request
/// and its body are no longer wanted, and are dropped where the client can.
abstract interface class ReplyTransport {
  /// Sends [content] on [branchId] (`POST /api/branches/:id/messages`). A
  /// refusal (out of credit, pool empty, …) throws before any event.
  Future<Stream<StreamEvent>> sendMessage(
    String branchId,
    String content, {
    Future<void>? abort,
  });

  /// Attaches to a reply being written (`GET /api/nodes/:id/stream`):
  /// snapshot, then live events.
  Future<Stream<StreamEvent>> attachReply(String nodeId, {Future<void>? abort});
}

/// Starts a timer: [Timer.new], or a test's own.
typedef StartTimer = Timer Function(
  Duration duration,
  void Function() callback,
);

/// When a reply's stream reconnects, and when it gives up.
abstract final class ReconnectPolicy {
  /// Reconnects in a row without an event before giving up.
  static const maxReconnects = 4;

  /// The wait before the first reconnect, doubling with each one after.
  static const baseDelay = Duration(milliseconds: 500);

  /// The wait before reconnect [attempt] (from 0). A reply only attached to
  /// tries its first reconnect at once: nothing has failed yet.
  static Duration delayBefore(int attempt, {required bool sent}) =>
      sent || attempt > 0 ? baseDelay * (1 << attempt) : Duration.zero;

  /// A refusal no reconnect will change: a 4xx other than 408 and 429.
  static bool isPermanent(ApiException error) =>
      error.status >= 400 &&
      error.status < 500 &&
      error.status != 408 &&
      error.status != 429;
}

/// How a reply's stream finished.
sealed class ReplyOutcome {
  const ReplyOutcome();
}

/// The reply was written to the end.
final class ReplyDone extends ReplyOutcome {
  const ReplyDone(this.event);
  final DoneEvent event;
}

/// The reply ended in an error event (failed, or stopped).
final class ReplyErrored extends ReplyOutcome {
  const ReplyErrored(this.event);
  final ErrorEvent event;
}

/// The server answered the send with a refusal: no reply was started.
final class ReplyRefused extends ReplyOutcome {
  const ReplyRefused(this.error);
  final ApiException error;
}

/// The stream gave up before the reply ended, for [error]. [replyId] is the
/// reply it followed, null when it was lost before the server named one.
final class ReplyLost extends ReplyOutcome {
  const ReplyLost(this.error, {required this.replyId});
  final Object error;
  final String? replyId;
}

/// [ReplyStream.cancel] stopped it.
final class ReplyCancelled extends ReplyOutcome {
  const ReplyCancelled();
}

/// One reply's events, reconnecting through [ReplyTransport.attachReply]
/// when a body ends or fails before `done` or `error`. Run it once.
class ReplyStream {
  /// Sends a message and follows the reply the server starts for it.
  ReplyStream.send(
    ReplyTransport transport, {
    required String branchId,
    required String content,
    this._startTimer = Timer.new,
  }) : _transport = transport,
       _open = ((abort) =>
           transport.sendMessage(branchId, content, abort: abort)),
       _replyId = null;

  /// Follows [replyId], a reply being written, starting by attaching to it.
  ReplyStream.attach(
    ReplyTransport transport,
    String replyId, {
    this._startTimer = Timer.new,
  }) : _transport = transport,
       _open = null,
       _replyId = replyId;

  final ReplyTransport _transport;
  final StartTimer _startTimer;

  /// The send, for a stream that starts with one.
  final Future<Stream<StreamEvent>> Function(Future<void> abort)? _open;

  /// The reply followed: given, or named by `start` or `snapshot`.
  String? get replyId => _replyId;
  String? _replyId;

  final _cancel = Completer<void>();
  bool get _cancelled => _cancel.isCompleted;

  /// Stops the body being read, if any.
  void Function()? _stopBody;

  /// The wait before a reconnect, while there is one.
  Timer? _wait;
  bool _ran = false;

  /// Stops the stream: [run] finishes with [ReplyCancelled] and gives no
  /// more events.
  void cancel() {
    if (_cancelled) return;
    _cancel.complete();
    _wait?.cancel();
    _stopBody?.call();
  }

  /// Gives each event to [onEvent], with [replyId] already updated for it,
  /// and finishes with how the stream ended. A send is opened before this
  /// returns its future.
  Future<ReplyOutcome> run(void Function(StreamEvent event) onEvent) async {
    assert(!_ran, 'A ReplyStream runs once');
    _ran = true;
    var pendingOpen = _open;
    var attempt = 0;
    ApiException lastError = ApiException.connectionLost;
    for (;;) {
      if (_cancelled) return const ReplyCancelled();
      final Stream<StreamEvent> body;
      if (pendingOpen != null) {
        final open = pendingOpen;
        pendingOpen = null;
        try {
          final opened = await _unlessCancelled(open(_cancel.future));
          if (opened == null) return const ReplyCancelled();
          body = opened;
        } on ApiException catch (error) {
          if (error.status != 0) return ReplyRefused(error);
          return ReplyLost(error, replyId: null);
        } on Object catch (error) {
          return ReplyLost(error, replyId: null);
        }
      } else {
        final id = _replyId;
        if (id == null) {
          return ReplyLost(
            ApiException(
              status: 0,
              code: 'network',
              message:
                  'The reply ended before it started (${lastError.message})',
            ),
            replyId: null,
          );
        }
        if (attempt >= ReconnectPolicy.maxReconnects) {
          return ReplyLost(lastError, replyId: id);
        }
        final wait = ReconnectPolicy.delayBefore(attempt, sent: _open != null);
        attempt++;
        if (wait > Duration.zero) {
          final waited = Completer<void>();
          _wait = _startTimer(wait, waited.complete);
          await Future.any([waited.future, _cancel.future]);
          _wait = null;
          if (_cancelled) return const ReplyCancelled();
        }
        try {
          final attached = await _unlessCancelled(
            _transport.attachReply(id, abort: _cancel.future),
          );
          if (attached == null) return const ReplyCancelled();
          body = attached;
        } on ApiException catch (error) {
          if (ReconnectPolicy.isPermanent(error)) {
            return ReplyLost(error, replyId: id);
          }
          lastError = error;
          continue;
        } on Object catch (error) {
          return ReplyLost(error, replyId: id);
        }
      }
      try {
        final outcome = await _read(body, (event) {
          attempt = 0;
          onEvent(event);
        });
        if (outcome != null) return outcome;
        lastError = ApiException.connectionLost;
      } on ApiException catch (error) {
        lastError = error;
      } on Object catch (error) {
        return ReplyLost(error, replyId: _replyId);
      }
    }
  }

  /// The body [opening] answers, or null when the stream is cancelled
  /// first. A body that comes after the cancel is cancelled too, in case
  /// the transport couldn't drop it.
  Future<Stream<StreamEvent>?> _unlessCancelled(
    Future<Stream<StreamEvent>> opening,
  ) async {
    final body = await Future.any([opening, _cancel.future.then((_) => null)]);
    if (!_cancelled) return body;
    unawaited(
      opening.then(
        (body) => body.listen(null).cancel(),
        onError: (Object _) {},
      ),
    );
    return null;
  }

  /// Reads [body] until a terminal event, its end or [cancel]: the outcome
  /// of a terminal event or the cancel, or null when the body ended first.
  /// A body's error is thrown.
  Future<ReplyOutcome?> _read(
    Stream<StreamEvent> body,
    void Function(StreamEvent event) onEvent,
  ) {
    final result = Completer<ReplyOutcome?>();
    late final StreamSubscription<StreamEvent> subscription;
    void finish(ReplyOutcome? outcome) {
      _stopBody = null;
      if (!result.isCompleted) result.complete(outcome);
    }

    subscription = body.listen(
      (event) {
        switch (event) {
          case StartEvent(:final assistantNode):
            _replyId = assistantNode.id;
          case SnapshotEvent(:final node):
            _replyId = node.id;
          default:
        }
        onEvent(event);
        final ReplyOutcome? outcome = switch (event) {
          DoneEvent() => ReplyDone(event),
          ErrorEvent() => ReplyErrored(event),
          _ => null,
        };
        if (outcome != null) {
          unawaited(subscription.cancel());
          finish(outcome);
        }
      },
      onError: (Object error, StackTrace stack) {
        _stopBody = null;
        if (!result.isCompleted) result.completeError(error, stack);
      },
      onDone: () => finish(null),
      cancelOnError: true,
    );
    _stopBody = () {
      unawaited(subscription.cancel());
      finish(const ReplyCancelled());
    };
    return result.future;
  }
}
