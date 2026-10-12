// The Worker's JSON shapes this app reads. The source of truth is the zod
// schemas and types in packages/shared/src (api.ts, domain.ts, pool.ts);
// these carry only the fields the app uses.

typedef Json = Map<String, Object?>;

/// Reads typed fields out of a decoded JSON object, failing loudly on a
/// shape the app doesn't expect.
extension JsonRead on Json {
  String str(String key) => _as<String>(key);
  String? strOrNull(String key) => _asOrNull<String>(key);
  int integer(String key) => _as<num>(key).toInt();
  int? intOrNull(String key) => _asOrNull<num>(key)?.toInt();
  bool boolean(String key) => _as<bool>(key);
  bool? boolOrNull(String key) => _asOrNull<bool>(key);
  Json obj(String key) => _as<Map<String, Object?>>(key);
  Json? objOrNull(String key) => _asOrNull<Map<String, Object?>>(key);
  List<Json> objList(String key) =>
      _as<List<Object?>>(key).cast<Map<String, Object?>>();
  List<Json>? objListOrNull(String key) =>
      _asOrNull<List<Object?>>(key)?.cast<Map<String, Object?>>();

  T _as<T>(String key) {
    final value = this[key];
    if (value is T) return value;
    throw FormatException('Expected $T at "$key", got ${value.runtimeType}');
  }

  T? _asOrNull<T>(String key) {
    final Object? value = this[key];
    if (value == null) return null;
    if (value is T) return value as T;
    throw FormatException('Expected $T? at "$key", got ${value.runtimeType}');
  }
}

/// `GET /api/me`.
class Me {
  const Me({
    required this.userId,
    required this.email,
    required this.devMode,
    required this.builtInCredit,
  });

  factory Me.fromJson(Json json) => Me(
    userId: json.strOrNull('userId'),
    email: json.strOrNull('email'),
    devMode: json.boolean('devMode'),
    builtInCredit: json.boolOrNull('builtInCredit') ?? false,
  );

  /// Null only under the local no-sign-in bypass (`devMode`).
  final String? userId;
  final String? email;
  final bool devMode;

  /// Tangent credit is offered to this user.
  final bool builtInCredit;
}

/// `GET /api/login-options`.
class LoginOptions {
  const LoginOptions({
    required this.configured,
    required this.devMode,
    required this.turnstileSiteKey,
    required this.signupsOpen,
  });

  factory LoginOptions.fromJson(Json json) => LoginOptions(
    configured: json.boolean('configured'),
    devMode: json.boolean('devMode'),
    turnstileSiteKey: json.strOrNull('turnstileSiteKey'),
    signupsOpen: json.boolOrNull('signupsOpen') ?? true,
  );

  /// Sign-in is set up on this server.
  final bool configured;

  /// The local no-sign-in bypass: every request is already signed in.
  final bool devMode;
  final String? turnstileSiteKey;
  final bool signupsOpen;
}

/// `GET /api/pool/status`.
class PoolStatus {
  const PoolStatus({required this.enabled, required this.modelLabel});

  factory PoolStatus.fromJson(Json json) => PoolStatus(
    enabled: json.boolean('enabled'),
    modelLabel: json.objOrNull('model')?.strOrNull('label'),
  );

  final bool enabled;
  final String? modelLabel;
}

/// `GET /api/billing`, the fields the payer choice needs.
class BillingSummary {
  const BillingSummary({
    required this.enabled,
    required this.builtInCredit,
    required this.availableMicros,
  });

  factory BillingSummary.fromJson(Json json) => BillingSummary(
    enabled: json.boolean('enabled'),
    builtInCredit: json.boolOrNull('builtInCredit') ?? false,
    availableMicros: json.intOrNull('availableMicros') ?? 0,
  );

  final bool enabled;
  final bool builtInCredit;

  /// Integer micro-dollars.
  final int availableMicros;
}

/// The model tiers Learn offers: Normal and Max.
enum Tier { normal, max }

class ModelInfo {
  const ModelInfo({required this.id, required this.label, required this.tier});

  factory ModelInfo.fromJson(Json json) => ModelInfo(
    id: json.str('id'),
    label: json.strOrNull('label') ?? json.str('id'),
    tier: switch (json.strOrNull('tier')) {
      'normal' => Tier.normal,
      'max' => Tier.max,
      _ => null,
    },
  );

  final String id;
  final String label;
  final Tier? tier;
}

/// An entry of `GET /api/providers`.
class ProviderInfo {
  const ProviderInfo({
    required this.id,
    required this.defaultModel,
    required this.models,
  });

  factory ProviderInfo.fromJson(Json json) => ProviderInfo(
    id: json.str('id'),
    defaultModel: json.strOrNull('defaultModel'),
    models: (json.objListOrNull('models') ?? const [])
        .map(ModelInfo.fromJson)
        .toList(),
  );

  final String id;
  final String? defaultModel;
  final List<ModelInfo> models;

  ModelInfo? modelFor(Tier tier) {
    for (final model in models) {
      if (model.tier == tier) return model;
    }
    return null;
  }
}

/// An entry of `GET /api/trees`. A tree is a lesson.
class TreeSummary {
  const TreeSummary({
    required this.id,
    required this.title,
    required this.updatedAt,
    required this.branchCount,
  });

  factory TreeSummary.fromJson(Json json) => TreeSummary(
    id: json.str('id'),
    title: json.str('title'),
    updatedAt: DateTime.parse(json.str('updatedAt')),
    branchCount: json.intOrNull('branchCount') ?? 1,
  );

  final String id;
  final String title;
  final DateTime updatedAt;
  final int branchCount;
}

/// `GET /api/settings`: the account's settings this app reads.
class Settings {
  const Settings({required this.walkthroughDoneAt});

  factory Settings.fromJson(Json json) =>
      Settings(walkthroughDoneAt: json.strOrNull('walkthroughDoneAt'));

  /// When the account finished or skipped the first-run walkthrough (ISO
  /// time); null while it hasn't, so the walkthrough shows.
  final String? walkthroughDoneAt;
}

class Tree {
  const Tree({
    required this.id,
    required this.title,
    required this.trunkBranchId,
  });

  factory Tree.fromJson(Json json) => Tree(
    id: json.str('id'),
    title: json.str('title'),
    trunkBranchId: json.str('trunkBranchId'),
  );

  final String id;
  final String title;
  final String trunkBranchId;
}

class Branch {
  const Branch({
    required this.id,
    required this.treeId,
    required this.parentBranchId,
    required this.branchPointNodeId,
    required this.title,
    required this.model,
    this.titleSource = 'user',
    this.anchorQuote,
  });

  factory Branch.fromJson(Json json) => Branch(
    id: json.str('id'),
    treeId: json.str('treeId'),
    parentBranchId: json.strOrNull('parentBranchId'),
    branchPointNodeId: json.strOrNull('branchPointNodeId'),
    title: json.strOrNull('title') ?? '',
    model: json.strOrNull('model'),
    titleSource: json.str('titleSource'),
    anchorQuote: json.strOrNull('anchorQuote'),
  );

  final String id;
  final String treeId;

  /// Null on the trunk.
  final String? parentBranchId;

  /// The node in the parent branch this branch forks from; null on the trunk.
  final String? branchPointNodeId;
  final String title;
  final String? model;

  /// Who named the branch: 'default' while it carries the server's
  /// placeholder ("Tangent: " and the first words), 'auto' once the tutor's
  /// first reply named it, 'user' when the learner did.
  final String titleSource;

  /// The words of the parent's message this tangent asks about.
  final String? anchorQuote;
}

enum Role { user, assistant, system }

enum NodeStatus { streaming, complete, error }

class ChatNode {
  const ChatNode({
    required this.id,
    required this.branchId,
    required this.parentId,
    required this.seq,
    required this.role,
    required this.content,
    required this.status,
    required this.error,
    required this.errorKind,
  });

  factory ChatNode.fromJson(Json json) => ChatNode(
    id: json.str('id'),
    branchId: json.str('branchId'),
    parentId: json.strOrNull('parentId'),
    seq: json.integer('seq'),
    role: Role.values.byName(json.str('role')),
    content: json.str('content'),
    status: NodeStatus.values.byName(json.str('status')),
    error: json.strOrNull('error'),
    errorKind: json.strOrNull('errorKind'),
  );

  final String id;
  final String branchId;
  final String? parentId;

  /// Order within the branch, from 0.
  final int seq;
  final Role role;
  final String content;
  final NodeStatus status;
  final String? error;

  /// `cut_off`, `cancelled`, `provider`, … (domain.ts `ErrorKind`).
  final String? errorKind;

  ChatNode copyWith({String? content, NodeStatus? status}) => ChatNode(
    id: id,
    branchId: branchId,
    parentId: parentId,
    seq: seq,
    role: role,
    content: content ?? this.content,
    status: status ?? this.status,
    error: error,
    errorKind: errorKind,
  );
}

/// `GET /api/trees/:id` and `POST /api/trees`.
class TreeDetail {
  const TreeDetail({
    required this.tree,
    required this.branches,
    required this.nodes,
  });

  factory TreeDetail.fromJson(Json json) => TreeDetail(
    tree: Tree.fromJson(json.obj('tree')),
    branches: json.objList('branches').map(Branch.fromJson).toList(),
    nodes: json.objList('nodes').map(ChatNode.fromJson).toList(),
  );

  final Tree tree;
  final List<Branch> branches;
  final List<ChatNode> nodes;
}

/// Who pays for a reply (`x-tangent-payment`).
enum Payer {
  ownKey('own-key'),
  credit('credit'),
  pool('pool');

  const Payer(this.header);
  final String header;
}

/// One event of a reply's stream (`StreamEvent` in packages/shared/src/api.ts).
/// Order: start, status*, delta*, then exactly one of done or error.
/// A reconnect starts with snapshot instead of start.
sealed class StreamEvent {
  const StreamEvent();
}

class StartEvent extends StreamEvent {
  const StartEvent({
    required this.userNode,
    required this.assistantNode,
    required this.branch,
  });
  final ChatNode userNode;
  final ChatNode assistantNode;
  final Branch branch;
}

/// The whole reply so far, on reconnect: replaces the text.
class SnapshotEvent extends StreamEvent {
  const SnapshotEvent(this.node);
  final ChatNode node;
}

/// Transient progress text, cleared by the next delta.
class StatusEvent extends StreamEvent {
  const StatusEvent(this.message);
  final String message;
}

class DeltaEvent extends StreamEvent {
  const DeltaEvent({required this.nodeId, required this.text});
  final String nodeId;
  final String text;
}

class DoneEvent extends StreamEvent {
  const DoneEvent({required this.node, required this.branch});
  final ChatNode node;
  final Branch branch;
}

class ErrorEvent extends StreamEvent {
  const ErrorEvent({
    required this.nodeId,
    required this.message,
    required this.node,
  });
  final String? nodeId;
  final String message;

  /// The failed node (status error), when one was written.
  final ChatNode? node;
}

/// A non-2xx response: `{"error":{"code","message","pool"?}}`.
class ApiException implements Exception {
  const ApiException({
    required this.status,
    required this.code,
    required this.message,
    this.poolReason,
  });

  final int status;

  /// `unauthorized`, `pool_empty`, `pool_cap_reached`, `pool_unavailable`,
  /// `payment_required`, `key_required`, `conflict`, … (ApiErrorCode).
  final String code;
  final String message;

  /// `pool.reason` on `pool_*` codes: `empty`, `verify`, `cap_requests`, …
  final String? poolReason;

  @override
  String toString() => 'ApiException($status $code: $message)';
}
