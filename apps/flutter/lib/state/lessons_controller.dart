import 'package:flutter/foundation.dart';

import '../api/models.dart';
import '../api/tangent_api.dart';
import 'notice.dart';
import 'session_controller.dart';

/// The learner's lessons, and the provider and models new ones run on.
class LessonsController extends ChangeNotifier {
  LessonsController({required this.api, required this.session}) {
    session.addListener(_onSession);
  }

  final TangentApi api;
  final SessionController session;

  List<ProviderInfo> _providers = const [];

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
      if (p.id == 'openrouter') return p;
    }
    return _providers.isEmpty ? null : _providers.first;
  }

  List<ModelInfo> get models => provider?.models ?? const [];

  /// Both tiers are on offer, so the Normal/Max switch has a choice.
  bool get hasTiers =>
      provider?.modelFor(Tier.normal) != null &&
      provider?.modelFor(Tier.max) != null;

  String? modelFor(Tier tier) => provider?.modelFor(tier)?.id;

  Tier? tierOf(String? modelId) {
    for (final m in models) {
      if (m.id == modelId) return m.tier;
    }
    return null;
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
      _providers = await api.providers();
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
  Future<String?> start(String topic, Tier tier) async {
    _notice = null;
    notifyListeners();
    try {
      final detail = await api.createTree(
        providerId: provider?.id,
        model: modelFor(tier),
      );
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
    }
  }

  void _onSession() {
    if (session.status != SessionStatus.signedOut) return;
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
