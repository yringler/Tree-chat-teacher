import 'dart:async';

import 'package:flutter/foundation.dart';

import '../api/models.dart';
import '../api/tangent_api.dart';
import 'notice.dart';
import 'session_controller.dart';

/// The learner's lessons, and the provider new ones run on.
class LessonsController extends ChangeNotifier {
  LessonsController({required this.api, required this.session}) {
    session.addListener(_onSession);
  }

  final TangentApi api;
  final SessionController session;

  List<ProviderInfo> _providers = const [];

  /// The key the latest provider list was asked for; null until [load].
  LearnKey? _providersFor;

  /// Only the latest request's answer is kept, so a slower earlier one
  /// can't overwrite it.
  int _providersRequest = 0;

  /// Null until the first load.
  List<TreeSummary>? _trees;
  List<TreeSummary>? get trees => _trees;

  Notice? _notice;
  Notice? get notice => _notice;

  bool _loading = false;
  bool get loading => _loading;

  /// The first message of a lesson just started, for its chat page to send.
  final _firstMessages = <String, String>{};

  /// Learn runs on OpenRouter where the server offers it.
  ProviderInfo? get provider {
    for (final p in _providers) {
      if (p.id == LearnKey.openRouter.id) return p;
    }
    return _providers.isEmpty ? null : _providers.first;
  }

  String? titleOf(String treeId) {
    for (final t in _trees ?? const <TreeSummary>[]) {
      if (t.id == treeId) return t.title;
    }
    return null;
  }

  Future<void> ensureLoaded() async {
    if (_trees == null && !_loading) await load();
  }

  Future<void> load() async {
    _loading = true;
    notifyListeners();
    try {
      _providersFor = session.replyKey;
      final request = ++_providersRequest;
      final providers = await api.providers();
      if (request == _providersRequest) _providers = providers;
      _trees = await api.trees();
      _notice = null;
    } on Object catch (error) {
      _fail(error);
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  /// Picks up new titles and dates quietly, e.g. after a reply.
  Future<void> refresh() async {
    try {
      _trees = await api.trees();
      notifyListeners();
    } on Object catch (error) {
      if (isUnauthorized(error)) session.signedOut();
    }
  }

  /// Creates a lesson and returns its id, or null when that failed (see
  /// [notice]). A non-empty [topic] becomes its first message, which the
  /// chat page sends (see [takeFirstMessage]).
  Future<String?> start(String topic) async {
    _notice = null;
    notifyListeners();
    try {
      final detail = await api.createTree(providerId: provider?.id);
      final tree = detail.tree;
      _trees = [
        TreeSummary(
          id: tree.id,
          title: tree.title,
          updatedAt: DateTime.now(),
          branchCount: 1,
        ),
        ...?_trees,
      ];
      final text = topic.trim();
      if (text.isNotEmpty) _firstMessages[tree.id] = text;
      notifyListeners();
      return tree.id;
    } on Object catch (error) {
      _fail(error);
      notifyListeners();
      return null;
    }
  }

  String? takeFirstMessage(String treeId) => _firstMessages.remove(treeId);

  Future<void> delete(String treeId) async {
    try {
      await api.deleteTree(treeId);
      _trees = _trees?.where((t) => t.id != treeId).toList();
      _notice = null;
    } on Object catch (error) {
      _fail(error);
    }
    notifyListeners();
  }

  void dismissNotice() {
    _notice = null;
    notifyListeners();
  }

  void _fail(Object error) {
    if (isUnauthorized(error)) {
      session.signedOut();
    } else {
      _notice = noticeFor(error);
      session.refused(error);
    }
  }

  /// The list follows the key replies run on, however that changes (a pick,
  /// or a key status or balance read that moves the payer).
  Future<void> _reloadProviders() async {
    _providersFor = session.replyKey;
    final request = ++_providersRequest;
    try {
      final providers = await api.providers();
      if (request != _providersRequest) return;
      _providers = providers;
      notifyListeners();
    } on Object catch (error) {
      _fail(error);
      notifyListeners();
    }
  }

  void _onSession() {
    if (session.status == SessionStatus.signedIn) {
      final loadedFor = _providersFor;
      if (loadedFor != null && session.replyKey != loadedFor) {
        unawaited(_reloadProviders());
      }
      return;
    }
    if (session.status != SessionStatus.signedOut) return;
    _providersFor = null;
    _providers = const [];
    _trees = null;
    _firstMessages.clear();
    _notice = null;
  }

  @override
  void dispose() {
    session.removeListener(_onSession);
    super.dispose();
  }
}
