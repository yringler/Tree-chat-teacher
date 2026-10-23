import 'dart:async';

import '../api/models.dart';
import '../api/reply_stream.dart';

/// The replies a lesson follows while they are written: which ones, and
/// what happens when a reply's stream ends. Each event goes to [onEvent];
/// the owner keeps the nodes, and shows them through [nodes].
class ReplyFollower {
  ReplyFollower({
    required this._transport,
    required this.onEvent,
    required this.nodes,
    required this.onError,
    required this.reload,
    required this.onEnded,
    this._delay = Future<void>.delayed,
    this._policy = const ReconnectPolicy(),
  });

  final ReplyTransport _transport;
  final Delay _delay;
  final ReconnectPolicy _policy;

  /// An event of [replyId]'s stream (null until a send's `start`).
  final void Function(StreamEvent event, String? replyId) onEvent;

  /// The lesson's nodes, as the owner shows them.
  final Iterable<ChatNode> Function() nodes;

  /// Why a send was refused, or a reply's stream gave up.
  final void Function(Object error) onError;

  /// Reads the lesson again from the server, and shows it through [nodes];
  /// throws when it can't.
  final Future<void> Function() reload;

  /// A reply's stream ended, and whatever that called for is done.
  final void Function() onEnded;

  final _streams = <ReplyStream>{};

  /// The replies read again once after their stream gave up.
  final _recovered = <String>{};
  int _unstarted = 0;
  bool _disposed = false;

  /// A send is waiting for the server to start its reply.
  bool get sending => _unstarted > 0;

  /// Whether a stream already follows [replyId].
  bool isFollowing(String replyId) =>
      _streams.any((stream) => stream.replyId == replyId);

  /// Follows [replyId], a reply being written, unless it is followed already.
  void follow(String replyId) {
    if (_disposed || isFollowing(replyId)) return;
    _run(
      ReplyStream.attach(_transport, replyId, delay: _delay, policy: _policy),
    );
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
        delay: _delay,
        policy: _policy,
      ),
      send: (
        branchId: branchId,
        known: {for (final node in nodes()) node.id},
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
            onEvent(event, stream.replyId);
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
    if (_disposed) return;
    final id = stream.replyId;
    var started = false;
    switch (outcome) {
      case ReplyRefused(:final error):
        onError(error);
      case ReplyLost(:final error, replyId: null)
          when send != null && error is ApiException && error.status == 0:
        started = await _recoverSend(send, error);
      // The stream reconnects itself, so a reply still shown being written
      // when it ends was given up on.
      case ReplyLost(:final error) when id != null && _isStreaming(id):
        await _recoverReply(id, error);
      case ReplyLost(:final error):
        onError(error);
      case ReplyDone() || ReplyErrored() || ReplyCancelled():
    }
    if (_disposed) return;
    send?.accept(started);
    onEnded();
  }

  /// Reads the lesson again to show what the server has of [replyId], whose
  /// stream gave up while it is shown being written, and follows it again
  /// if the server still writes it. A reply given up on twice, or whose
  /// lesson can't be read, is marked failed instead: while reads work but
  /// its stream keeps failing, recovering again would never end.
  Future<void> _recoverReply(String replyId, Object error) async {
    if (!_recovered.add(replyId)) return _giveUp(replyId, error);
    try {
      await reload();
    } on Object catch (reloadError) {
      if (!_disposed) _giveUp(replyId, reloadError);
      return;
    }
    if (_disposed) return;
    if (_isStreaming(replyId)) follow(replyId);
  }

  void _giveUp(String replyId, Object error) {
    onError(error);
    onEvent(
      ErrorEvent(nodeId: replyId, message: connectionLostText, node: null),
      replyId,
    );
  }

  /// Reads the lesson again after [send] was lost before its reply started:
  /// the message may have reached the server, which then writes its reply
  /// and refuses another send on the branch. A message of the learner's on
  /// the branch that wasn't there before means it did; the replies still
  /// being written are followed either way. Answers whether it did.
  Future<bool> _recoverSend(_Send send, Object error) async {
    try {
      await reload();
    } on Object catch (reloadError) {
      if (!_disposed) onError(reloadError);
      return false;
    }
    if (_disposed) return false;
    followAll(nodes());
    final arrived = nodes().any(
      (node) =>
          node.branchId == send.branchId &&
          node.role == Role.user &&
          !send.known.contains(node.id),
    );
    if (!arrived) onError(error);
    return arrived;
  }

  /// Whether [replyId] is still shown being written.
  bool _isStreaming(String replyId) => nodes().any(
    (node) => node.id == replyId && node.status == NodeStatus.streaming,
  );

  /// Stops following every reply; nothing is reported after this.
  void dispose() {
    _disposed = true;
    for (final stream in _streams.toList()) {
      stream.cancel();
    }
  }
}

/// What a reply given up on says in place of its end.
const connectionLostText =
    'Connection lost. Open the lesson again to see the final reply.';

/// A send being followed: its branch, the nodes shown when it was sent, and
/// how to settle what [ReplyFollower.send] answers.
typedef _Send = ({
  String branchId,
  Set<String> known,
  void Function(bool started) accept,
});
