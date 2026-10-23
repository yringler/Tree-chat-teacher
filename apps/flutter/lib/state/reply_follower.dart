import 'dart:async';

import '../api/models.dart';
import '../api/reply_stream.dart';

/// The replies a lesson follows while they are written: which ones, and
/// what happens when a reply's stream ends. Each event goes to [onEvent];
/// the owner keeps the nodes, and answers [isStreaming] from them.
class ReplyFollower {
  ReplyFollower({
    required this._transport,
    required this.onEvent,
    required this.isStreaming,
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

  /// Whether [replyId] is still shown being written.
  final bool Function(String replyId) isStreaming;

  /// Why a send was refused, or a reply's stream gave up.
  final void Function(Object error) onError;

  /// Reads the lesson again from the server.
  final Future<void> Function() reload;

  /// A reply's stream ended, after [onError] and [reload] were started.
  final void Function() onEnded;

  final _streams = <ReplyStream>{};
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
  /// ended first (refused, or lost).
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
      accept: accept,
    );
    return accepted.future;
  }

  void _run(ReplyStream stream, {void Function(bool started)? accept}) {
    _streams.add(stream);
    unawaited(
      stream
          .run((event) {
            if (event is StartEvent) accept?.call(true);
            onEvent(event, stream.replyId);
          })
          .then((outcome) => _ended(stream, outcome, accept)),
    );
  }

  void _ended(
    ReplyStream stream,
    ReplyOutcome outcome,
    void Function(bool started)? accept,
  ) {
    _streams.remove(stream);
    if (_disposed) return;
    switch (outcome) {
      case ReplyRefused(:final error):
        onError(error);
      case ReplyLost(:final error):
        onError(error);
      case ReplyDone() || ReplyErrored() || ReplyCancelled():
    }
    // The stream reconnects itself, so a reply still shown being written
    // when it ends was given up on: the lesson is read again to show what
    // the server has.
    final id = stream.replyId;
    if (id != null && isStreaming(id)) unawaited(reload());
    accept?.call(false);
    onEnded();
  }

  /// Stops following every reply; nothing is reported after this.
  void dispose() {
    _disposed = true;
    for (final stream in _streams.toList()) {
      stream.cancel();
    }
  }
}
