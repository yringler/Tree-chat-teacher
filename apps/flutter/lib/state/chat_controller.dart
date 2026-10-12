import 'dart:async';

import 'package:flutter/foundation.dart';

import '../api/models.dart';
import '../api/tangent_api.dart';
import '../api/tangents.dart';
import 'lessons_controller.dart';
import 'notice.dart';
import 'session_controller.dart';
import 'thread.dart';

/// One lesson: its branches and messages, the branch on screen, and the
/// replies streaming into it.
class ChatController extends ChangeNotifier {
  ChatController({
    required this.api,
    required this.session,
    required this.lessons,
    required this.treeId,
    String? branchId,
  }) : _requestedBranchId = branchId;

  final TangentApi api;
  final SessionController session;
  final LessonsController lessons;
  final String treeId;

  Tree? _tree;
  final _branches = <String, Branch>{};
  final _nodes = <String, ChatNode>{};
  final _status = <String, String>{};
  final _subscriptions = <StreamSubscription<StreamEvent>>{};
  String? _requestedBranchId;
  bool _disposed = false;

  bool _loading = true;
  bool get loading => _loading;

  /// Why the lesson couldn't be opened.
  Notice? _loadError;
  Notice? get loadError => _loadError;

  /// Why the last send or switch failed.
  Notice? _notice;
  Notice? get notice => _notice;

  /// A message is on its way and the server hasn't started its reply yet.
  bool _sending = false;
  bool get sending => _sending;

  bool _switching = false;
  bool get switching => _switching;

  String get title => lessons.titleOf(treeId) ?? _tree?.title ?? '';

  /// The branch on screen: the one asked for, else the trunk.
  String? get branchId {
    final requested = _requestedBranchId;
    if (requested != null && _branches.containsKey(requested)) {
      return requested;
    }
    return _tree?.trunkBranchId;
  }

  Branch? get branch => _branches[branchId];

  bool get isSideBranch => branch?.parentBranchId != null;

  String branchTitle(String branchId) => _branches[branchId]?.title ?? '';

  /// The branches from the trunk down to the one on screen.
  List<Branch> get chain {
    final id = branchId;
    return id == null ? const [] : branchChain(id, _branches);
  }

  /// Every branch of the lesson, side questions nested under their parents.
  List<OutlineEntry> get outline {
    final trunkId = _tree?.trunkBranchId;
    return trunkId == null ? const [] : branchOutline(trunkId, _branches);
  }

  List<ChatNode> get thread {
    final id = branchId;
    if (id == null) return const [];
    return threadPath(branchId: id, branches: _branches, nodes: _nodes.values);
  }

  /// The reply being written on this thread, if any.
  ChatNode? get streamingNode {
    for (final node in thread.reversed) {
      if (node.status == NodeStatus.streaming) return node;
    }
    return null;
  }

  /// Transient progress text of a reply being written ("Searching…").
  String? statusOf(String nodeId) => _status[nodeId];

  /// The tier this branch runs on, when its model is one of Learn's tiers.
  Tier? get tier {
    final id = branchId;
    return id == null ? null : lessons.tierOf(effectiveModel(id, _branches));
  }

  /// The open pool runs one model, so the learner can't pick a tier on it.
  bool get canSwitchTier =>
      session.payer != Payer.pool &&
      lessons.hasTiers &&
      !_switching &&
      streamingNode == null;

  /// The side branches that fork from [node], in the server's order.
  List<Branch> sideQuestionsAt(ChatNode node) => [
    for (final b in _branches.values)
      if (b.branchPointNodeId == node.id) b,
  ];

  /// The side branch from [node] titled [title], if one was opened before.
  Branch? branchFor(ChatNode node, String title) {
    for (final b in sideQuestionsAt(node)) {
      if (b.title == title) return b;
    }
    return null;
  }

  Future<void> load() async {
    try {
      _replace(await api.tree(treeId));
      _loadError = null;
    } on Object catch (error) {
      if (isUnauthorized(error)) {
        session.signedOut();
      } else {
        _loadError = noticeFor(error);
      }
    }
    if (_disposed) return;
    _loading = false;
    _notify();
    for (final node in _nodes.values.toList()) {
      if (node.role == Role.assistant && node.status == NodeStatus.streaming) {
        _listen(api.resume(node.id), nodeId: node.id);
      }
    }
  }

  void selectBranch(String? branchId) {
    if (branchId == _requestedBranchId) return;
    _requestedBranchId = branchId;
    _notice = null;
    _notify();
  }

  /// Sends [text] on the branch on screen. Completes with true once the
  /// server has started the reply, and false when it refused (see [notice]).
  Future<bool> send(String text) {
    final id = branchId;
    if (id == null || _sending) return Future.value(false);
    final accepted = Completer<bool>();
    _sending = true;
    _notice = null;
    _notify();
    _listen(api.sendMessage(id, text), accepted: accepted);
    return accepted.future;
  }

  /// Stops the reply being written; its stream then ends with an error.
  Future<void> stop() async {
    final node = streamingNode;
    if (node == null) return;
    try {
      await api.cancel(node.id);
    } on Object catch (error) {
      _fail(error);
    }
  }

  Future<void> setTier(Tier tier) async {
    final id = branchId;
    final model = lessons.modelFor(tier);
    if (id == null || model == null || !canSwitchTier) return;
    _switching = true;
    _notice = null;
    _notify();
    try {
      final updated = await api.setBranchModel(id, model);
      _branches[updated.id] = updated;
    } on Object catch (error) {
      _fail(error);
    }
    _switching = false;
    _notify();
  }

  /// Opens the side branch that follows [tangent] from [node], creating it
  /// when it's new. Returns its id and whether it was created (its first
  /// message, the tangent's title, is then still to send), or null on error.
  Future<({String branchId, bool created})?> followTangent(
    ChatNode node,
    Tangent tangent,
  ) async {
    final existing = branchFor(node, tangent.title);
    if (existing != null) {
      selectBranch(existing.id);
      return (branchId: existing.id, created: false);
    }
    _notice = null;
    _sending = true;
    _notify();
    try {
      final created = await api.createBranch(
        fromNodeId: node.id,
        title: tangent.title,
      );
      _branches[created.id] = created;
      _sending = false;
      selectBranch(created.id);
      return (branchId: created.id, created: true);
    } on Object catch (error) {
      _sending = false;
      _fail(error);
      _notify();
      return null;
    }
  }

  void dismissNotice() {
    _notice = null;
    _notify();
  }

  void _listen(
    Stream<StreamEvent> stream, {
    Completer<bool>? accepted,
    String? nodeId,
  }) {
    var replyId = nodeId;
    late final StreamSubscription<StreamEvent> subscription;

    void accept(bool value) {
      if (accepted == null || accepted.isCompleted) return;
      _sending = false;
      accepted.complete(value);
    }

    // The API re-attaches a broken stream itself, so one that still ends
    // before the reply is done has given up: the lesson is reloaded to show
    // what the server has.
    void ended(Object? error) {
      _subscriptions.remove(subscription);
      final node = replyId == null ? null : _nodes[replyId];
      if (error != null) _fail(error);
      if (node != null && node.status == NodeStatus.streaming) {
        unawaited(_reload());
      }
      accept(false);
      _notify();
    }

    subscription = stream.listen(
      (event) {
        switch (event) {
          case StartEvent(:final assistantNode):
            replyId = assistantNode.id;
            accept(true);
          case SnapshotEvent(:final node):
            replyId = node.id;
          default:
        }
        _apply(event, replyId);
      },
      onError: (Object error) {
        if (_disposed) return;
        ended(error);
      },
      onDone: () {
        if (_disposed) return;
        ended(null);
      },
      cancelOnError: true,
    );
    _subscriptions.add(subscription);
  }

  void _apply(StreamEvent event, String? replyId) {
    switch (event) {
      case StartEvent(:final userNode, :final assistantNode, :final branch):
        _nodes[userNode.id] = userNode;
        _nodes[assistantNode.id] = assistantNode;
        _branches[branch.id] = branch;
      case SnapshotEvent(:final node):
        _nodes[node.id] = node;
      case StatusEvent(:final message):
        if (replyId != null) _status[replyId] = message;
      case DeltaEvent(:final nodeId, :final text):
        final node = _nodes[nodeId];
        if (node != null) {
          _nodes[nodeId] = node.copyWith(content: node.content + text);
        }
        _status.remove(nodeId);
      case DoneEvent(:final node, :final branch):
        _nodes[node.id] = node;
        _branches[branch.id] = branch;
        _status.remove(node.id);
        // The lesson's title is written after its first reply.
        unawaited(lessons.refresh());
      case ErrorEvent(:final nodeId, :final message, :final node):
        if (node != null) {
          _nodes[node.id] = node;
          _status.remove(node.id);
        } else if (nodeId != null) {
          _markFailed(nodeId, message);
        }
    }
    _notify();
  }

  void _markFailed(String nodeId, String message) {
    final node = _nodes[nodeId];
    _status.remove(nodeId);
    if (node == null) return;
    _nodes[nodeId] = ChatNode(
      id: node.id,
      branchId: node.branchId,
      parentId: node.parentId,
      seq: node.seq,
      role: node.role,
      content: node.content,
      status: NodeStatus.error,
      error: message,
      errorKind: null,
    );
  }

  Future<void> _reload() async {
    try {
      _replace(await api.tree(treeId));
    } on Object catch (error) {
      _fail(error);
    }
    _notify();
  }

  void _replace(TreeDetail detail) {
    _tree = detail.tree;
    _branches
      ..clear()
      ..addEntries(detail.branches.map((b) => MapEntry(b.id, b)));
    _nodes
      ..clear()
      ..addEntries(detail.nodes.map((n) => MapEntry(n.id, n)));
  }

  void _fail(Object error) {
    if (isUnauthorized(error)) {
      session.signedOut();
    } else {
      _notice = noticeFor(error);
    }
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    for (final subscription in _subscriptions) {
      unawaited(subscription.cancel());
    }
    super.dispose();
  }
}
