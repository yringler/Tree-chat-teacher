import 'dart:async';

import 'package:flutter/foundation.dart';

import '../api/models.dart';
import '../api/tangent_api.dart';
import 'composer_plan.dart';
import 'lessons_controller.dart';
import 'notice.dart';
import 'reply_follower.dart';
import 'session_controller.dart';
import 'thread.dart';

/// One lesson: its branches and messages, the branch on screen, and the
/// replies streaming into it, which a [ReplyFollower] follows.
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
  String? _requestedBranchId;
  bool _disposed = false;

  late final _replies = ReplyFollower(
    transport: api,
    onEvent: _apply,
    isStreaming: (id) => _nodes[id]?.status == NodeStatus.streaming,
    onError: _fail,
    reload: _reload,
    onEnded: _notify,
  );

  bool _loading = true;
  bool get loading => _loading;

  /// Why the lesson couldn't be opened.
  Notice? _loadError;
  Notice? get loadError => _loadError;

  /// Why the last send or switch failed.
  Notice? _notice;
  Notice? get notice => _notice;

  /// A message is on its way and the server hasn't started its reply yet.
  bool get sending => _creatingTangent || _replies.sending;

  /// A tangent is being made for the message it starts with.
  bool _creatingTangent = false;

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

  Branch? branchById(String branchId) => _branches[branchId];

  String? anchorQuoteOf(String branchId) => _branches[branchId]?.anchorQuote;

  /// The branches from the trunk down to the one on screen.
  List<Branch> get chain {
    final id = branchId;
    return id == null ? const [] : branchChain(id, _branches);
  }

  /// The tangents the learner just came back from: on the way to the branch
  /// they left, not on the way to the one on screen. Going deeper leaves
  /// none; back to the parent, the tangent left. Coming back is when the
  /// learner looks for where they were, so its row under the reply is lit.
  /// A controller holds one lesson, so another lesson starts with none.
  Set<String> get cameFromIds => _cameFromIds;
  Set<String> _cameFromIds = const {};

  /// Every branch of the lesson, tangents nested under their parents.
  List<OutlineEntry> get outline {
    final trunkId = _tree?.trunkBranchId;
    return trunkId == null ? const [] : branchOutline(trunkId, _branches);
  }

  List<ChatNode> get thread {
    final id = branchId;
    if (id == null) return const [];
    return threadPath(branchId: id, branches: _branches, nodes: _nodes.values);
  }

  /// What the composer's next message asks about, on a tangent made when it
  /// is sent: a reply, or words "Ask about this" quoted from it. Moving to
  /// another thread drops it, and so does deleting that reply.
  ComposerLead? get lead => _lead;
  ComposerLead? _lead;

  /// The learner is at the start of the tangent on screen, where every
  /// tangent opens, reading its first reply, until they send or jump to the
  /// end: the app's stand-in for the focused message that picks the reply
  /// on the web, where `j` / `k` and a click move the focus too.
  bool _atTangentStart = true;

  /// What the composer offers, and the reply a tangent from it starts at
  /// (see [composerPlan]): the [lead], else the first reply of a tangent the
  /// learner is at the start of, else the thread's last reply.
  ComposerPlan get plan {
    final id = branchId;
    final path = thread;
    final opened = isSideBranch && _atTangentStart;
    return composerPlan(
      path: path,
      branchId: id,
      inTangent: isSideBranch,
      focusedId: opened
          ? path.where((n) => n.branchId == id).firstOrNull?.id
          : null,
      lead: _lead,
    );
  }

  /// The reply a tangent from the composer starts at. Null (the message
  /// continues the thread): an empty lesson or tangent, or a failed reply.
  ChatNode? get target => _nodes[plan.target];

  /// Aims the composer at [lead]; what is typed stays.
  void aim(ComposerLead lead) {
    _lead = lead;
    _notify();
  }

  /// Takes the lead off the composer; what is typed stays.
  void dropLead() {
    _lead = null;
    _notify();
  }

  /// The learner jumped to the end of the thread, so a tangent from the
  /// composer starts from its last reply.
  void jumpedToEnd() {
    if (!_atTangentStart) return;
    _atTangentStart = false;
    _notify();
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

  /// The tangents that start from [node], in the server's order.
  List<Branch> tangentsAt(ChatNode node) => [
    for (final b in _branches.values)
      if (b.branchPointNodeId == node.id) b,
  ];

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
    _replies.followAll(_nodes.values);
  }

  void selectBranch(String? branchId) {
    if (branchId == _requestedBranchId) return;
    final left = {for (final b in chain) b.id};
    _requestedBranchId = branchId;
    _cameFromIds = left.difference({for (final b in chain) b.id});
    _notice = null;
    _lead = null;
    _atTangentStart = true;
    _notify();
  }

  /// Sends [text] on the branch on screen. Completes with true once the
  /// server has started the reply, and false when it refused (see [notice]).
  Future<bool> send(String text) {
    final id = branchId;
    if (id == null || sending) return Future.value(false);
    _notice = null;
    _atTangentStart = false;
    final accepted = _replies.send(id, text);
    _notify();
    return accepted;
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

  /// Starts a tangent from [node] with [question] as its first message, and
  /// puts it on screen: titled [title] when it follows a suggestion, about
  /// [anchorQuote] when the learner selected words in it. A tangent is only
  /// made with its question. Returns its id and whether the server started
  /// the reply (see [send]), or null when it could not be made (see
  /// [notice]).
  Future<({String id, Future<bool> accepted})?> startTangent(
    ChatNode node,
    String question, {
    String? title,
    String? anchorQuote,
  }) async {
    if (question.trim().isEmpty) return null;
    _notice = null;
    _creatingTangent = true;
    _notify();
    try {
      final created = await api.createBranch(
        fromNodeId: node.id,
        title: title,
        anchorQuote: anchorQuote,
      );
      _branches[created.id] = created;
      _creatingTangent = false;
      selectBranch(created.id);
      return (id: created.id, accepted: send(question));
    } on Object catch (error) {
      _creatingTangent = false;
      _fail(error);
      _notify();
      return null;
    }
  }

  /// What to ask before deleting [node] (see [deleteMessageQuestion]); null
  /// for a reply, which can't be deleted.
  String? deleteQuestion(
    ChatNode node, {
    required String Function(Branch) titleOf,
  }) => deleteMessageQuestion(
    node,
    branches: _branches,
    nodes: _nodes.values,
    titleOf: titleOf,
  );

  /// Deletes [node], one of the learner's messages, with everything after
  /// it on its thread (see [TangentApi.deleteMessage]). Completes with true
  /// once it is gone, and false when the server refused (see [notice]).
  /// The page moves off a branch that went with it.
  Future<bool> deleteMessage(ChatNode node) async {
    _notice = null;
    try {
      final deleted = await api.deleteMessage(node.id);
      _branches.removeWhere((id, _) => deleted.branchIds.contains(id));
      for (final id in deleted.nodeIds) {
        _nodes.remove(id);
        _status.remove(id);
      }
      _dropLeadIfGone();
      // Counts and the last update in the lesson list.
      unawaited(lessons.refresh());
      _notify();
      return true;
    } on Object catch (error) {
      _fail(error);
      _notify();
      return false;
    }
  }

  void dismissNotice() {
    _notice = null;
    _notify();
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
      // A reply only ends in the thread it started in: one deleted while it
      // was written (its stream ends after the delete) stays deleted.
      case DoneEvent(:final node, :final branch):
        if (!_nodes.containsKey(node.id)) break;
        _nodes[node.id] = node;
        _branches[branch.id] = branch;
        _status.remove(node.id);
        // The lesson's title is written after its first reply.
        unawaited(lessons.refresh());
      case ErrorEvent(:final nodeId, :final message, :final node):
        if (node != null) {
          if (!_nodes.containsKey(node.id)) break;
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
    _dropLeadIfGone();
  }

  /// A message deleted from under the box takes the lead with it: the box
  /// can't ask about a message that isn't there.
  void _dropLeadIfGone() {
    if (_lead case final lead? when !_nodes.containsKey(lead.nodeId)) {
      _lead = null;
    }
  }

  void _fail(Object error) {
    if (isUnauthorized(error)) {
      session.signedOut();
    } else {
      _notice = noticeFor(error);
      session.refused(error);
    }
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _replies.dispose();
    super.dispose();
  }
}
