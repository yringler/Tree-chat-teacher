import 'dart:async';

import '../api/models.dart';
import '../api/reply_stream.dart';

/// What a [ReplyFollower] asks of the lesson it follows replies for, which
/// keeps the nodes and shows them.
abstract interface class ReplyHost {
  /// The lesson's nodes, as shown.
  Iterable<ChatNode> get nodes;

  /// Shows an event of [replyId]'s stream (null until a send's `start`).
  void apply(StreamEvent event, String? replyId);

  /// Shows [replyId] failed with [message]: its stream ended while it is
  /// still shown being written.
  void markFailed(String replyId, String message);

  /// Says why a send was refused, or a reply's stream gave up.
  void report(Object error);

  /// The [error] reported for a reply given up on no longer holds: the
  /// lesson was read again since.
  void resolved(Object error);

  /// Reads the lesson again from the server, and shows it through [nodes];
  /// throws when it can't.
  Future<void> reload();

  /// A reply's stream ended, and whatever that called for is done.
  void changed();
}

/// The replies a lesson follows while they are written: which ones, and
/// what happens when a reply's stream ends. Its [ReplyHost] shows them.
class ReplyFollower {
  ReplyFollower({
    required this._transport,
    required this._host,
    this._startTimer = Timer.new,
  });

  final ReplyTransport _transport;
  final ReplyHost _host;
  final StartTimer _startTimer;

  final _streams = <ReplyStream>{};

  /// The replies read again after their stream gave up, and followed
  /// again with no event since.
  final _recovered = <String>{};

  /// The replies given up on with no event since, with how many waits to
  /// read the lesson again they have had.
  final _givenUp = <String, int>{};

  /// The replies given up on whose lesson is waiting to be read again.
  final _checking = <String>{};
  int _unstarted = 0;
  bool _disposed = false;

  /// The waits running, which [dispose] stops.
  final _waits = <Timer>{};
  final _stopped = Completer<void>();

  /// How long a lost send whose message isn't in the lesson waits before
  /// the lesson is read once more: a send can lose its connection while
  /// the server, slow to start (a cold Durable Object), hasn't written the
  /// message yet.
  static const recheckDelay = Duration(seconds: 3);

  /// How long a reply given up on waits before the lesson is read again,
  /// to show what the server made of it. Its connection is often only
  /// paused (a phone locked, or between networks) while the server
  /// finishes the reply.
  static const checkAgainDelay = Duration(seconds: 5);

  /// The longest wait between reads of the lesson for a reply given up on.
  static const checkAgainMaxDelay = Duration(minutes: 1);

  /// A send is waiting for the server to start its reply.
  bool get sending => _unstarted > 0;

  /// Whether a stream already follows [replyId].
  bool isFollowing(String replyId) =>
      _streams.any((stream) => stream.replyId == replyId);

  /// Follows [replyId], a reply being written, unless it is followed already.
  void follow(String replyId) {
    if (_disposed || isFollowing(replyId)) return;
    _run(ReplyStream.attach(_transport, replyId, startTimer: _startTimer));
  }

  /// Follows every reply in [nodes] that is still being written.
  void followAll(Iterable<ChatNode> nodes) {
    for (final node in nodes.toList()) {
      if (node.role == Role.assistant && node.status == NodeStatus.streaming) {
        follow(node.id);
      }
    }
  }

  /// Sends [content] on [branchId] and follows its reply. Completes with
  /// true once the server has started the reply, and false when the stream
  /// ended first (refused, or lost) and the message didn't reach the server.
  Future<bool> send(String branchId, String content) {
    final accepted = Completer<bool>();
    _unstarted++;
    void accept(bool value) {
      if (accepted.isCompleted) return;
      _unstarted--;
      accepted.complete(value);
    }

    _run(
      ReplyStream.send(
        _transport,
        branchId: branchId,
        content: content,
        startTimer: _startTimer,
      ),
      send: (
        branchId: branchId,
        known: {for (final node in _host.nodes) node.id},
        accept: accept,
      ),
    );
    return accepted.future;
  }

  void _run(ReplyStream stream, {_Send? send}) {
    _streams.add(stream);
    unawaited(
      stream
          .run((event) {
            if (event is StartEvent) send?.accept(true);
            // A reply whose stream makes progress may be recovered again.
            _recovered.remove(stream.replyId);
            _givenUp.remove(stream.replyId);
            _host.apply(event, stream.replyId);
          })
          .then((outcome) => _ended(stream, outcome, send)),
    );
  }

  Future<void> _ended(
    ReplyStream stream,
    ReplyOutcome outcome,
    _Send? send,
  ) async {
    _streams.remove(stream);
    if (_disposed) {
      send?.accept(false);
      return;
    }
    final id = stream.replyId;
    var started = false;
    switch (outcome) {
      case ReplyRefused(:final error):
        _host.report(error);
      case ReplyLost(:final error, replyId: null)
          when send != null && error is ApiException && error.status == 0:
        started = await _recoverSend(send, error);
      // The stream reconnects itself, so a reply still shown being written
      // when it ends was given up on.
      case ReplyLost(:final error) when id != null && _isStreaming(id):
        await _recoverReply(id, error);
      case ReplyLost(:final error):
        _host.report(error);
      // An error event that names no reply still ends the one followed.
      case ReplyErrored(:final event) when id != null && _isStreaming(id):
        _host.markFailed(id, event.message);
      case ReplyDone() || ReplyErrored() || ReplyCancelled():
    }
    send?.accept(started);
    if (!_disposed) _host.changed();
  }

  /// Reads the lesson again to show what the server has of [replyId], whose
  /// stream gave up while it is shown being written, and follows it again
  /// if the server still writes it. A reply given up on again with no
  /// event in between, or whose lesson can't be read, is marked failed
  /// instead: while reads work but its stream never gets anywhere,
  /// recovering again would never end.
  Future<void> _recoverReply(String replyId, Object error) async {
    if (!_recovered.add(replyId)) return _giveUp(replyId, error);
    try {
      await _host.reload();
    } on Object catch (reloadError) {
      if (!_disposed) _giveUp(replyId, reloadError);
      return;
    }
    if (_disposed) return;
    if (_isStreaming(replyId)) follow(replyId);
  }

  /// Marks [replyId] failed, and reads the lesson again from time to time
  /// until that works, to show the reply as the server has it then. [error]
  /// is reported once, however often the reply is given up on again with no
  /// event in between.
  void _giveUp(String replyId, Object error) {
    if (!_givenUp.containsKey(replyId)) {
      _givenUp[replyId] = 0;
      _host.report(error);
    }
    _host.markFailed(replyId, connectionLostText);
    if (_checking.add(replyId)) unawaited(_checkAgain(replyId, error));
  }

  /// Reads the lesson again for [replyId], given up on, after a wait that
  /// doubles with each wait since it was first given up on, until a read
  /// works or an event of the reply's comes first. A reply the server still
  /// writes is followed again.
  Future<void> _checkAgain(String replyId, Object error) async {
    try {
      for (;;) {
        final waits = _givenUp[replyId];
        if (waits == null) return;
        _givenUp[replyId] = waits + 1;
        final wait = checkAgainDelay * (1 << (waits < 4 ? waits : 4));
        await _wait(wait < checkAgainMaxDelay ? wait : checkAgainMaxDelay);
        if (_disposed || !_givenUp.containsKey(replyId)) return;
        try {
          await _host.reload();
        } on Object {
          continue;
        }
        if (_disposed) return;
        _host.resolved(error);
        // Lost again with no event, it is given up on again at once.
        _recovered.add(replyId);
        if (_isStreaming(replyId)) follow(replyId);
        _host.changed();
        return;
      }
    } finally {
      _checking.remove(replyId);
    }
  }

  /// Reads the lesson again after [send] was lost before its reply started:
  /// the message may have reached the server, which then writes its reply
  /// and refuses another send on the branch. A message of the learner's on
  /// the branch that wasn't there before means it did; one not there yet
  /// is looked for once more after [recheckDelay]. The replies still being
  /// written are followed either way. Answers whether it did.
  Future<bool> _recoverSend(_Send send, Object error) async {
    try {
      await _host.reload();
      if (!_disposed && !_arrived(send)) {
        await _wait(recheckDelay);
        if (!_disposed) await _host.reload();
      }
    } on Object catch (reloadError) {
      if (!_disposed) _host.report(reloadError);
      return false;
    }
    if (_disposed) return false;
    followAll(_host.nodes);
    final arrived = _arrived(send);
    if (!arrived) _host.report(error);
    return arrived;
  }

  /// Whether [send]'s message is in the lesson.
  bool _arrived(_Send send) => _host.nodes.any(
    (node) =>
        node.branchId == send.branchId &&
        node.role == Role.user &&
        !send.known.contains(node.id),
  );

  /// Waits [duration], or until [dispose].
  Future<void> _wait(Duration duration) async {
    final waited = Completer<void>();
    final timer = _startTimer(duration, waited.complete);
    _waits.add(timer);
    await Future.any([waited.future, _stopped.future]);
    _waits.remove(timer);
  }

  /// Whether [replyId] is still shown being written.
  bool _isStreaming(String replyId) => _host.nodes.any(
    (node) => node.id == replyId && node.status == NodeStatus.streaming,
  );

  /// Stops following every reply; nothing is reported after this, and a
  /// send not started yet completes with false.
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _stopped.complete();
    for (final timer in _waits) {
      timer.cancel();
    }
    for (final stream in _streams.toList()) {
      stream.cancel();
    }
  }
}

/// What a reply given up on says in place of its end.
const connectionLostText =
    'Connection lost. The reply shows here once the connection is back.';

/// A send being followed: its branch, the nodes shown when it was sent, and
/// how to settle what [ReplyFollower.send] answers.
typedef _Send = ({
  String branchId,
  Set<String> known,
  void Function(bool started) accept,
});
