import 'dart:async';

import 'package:tangent/api/models.dart';
import 'package:tangent/api/tangent_api.dart';

/// The screens [ScreenApi] can open on, by `?screen=` name, and where each
/// one starts.
const screenLocations = {
  // The main thread after its first reply, with its suggestions.
  'lesson-reply': '/t/tides',
  // A tangent from that reply, with a reply of its own.
  'in-tangent': '/t/tides/b/bulge',
  // Back on the main thread, the tangent listed under the reply.
  'back-on-trunk': '/t/tides',
  // The walkthrough's three steps, for an account that hasn't had it: the
  // first on the main thread's reply, the second in a tangent. For the
  // third, open coach3 and tap the breadcrumb's Main thread.
  'coach1': '/t/tides',
  'coach2': '/t/tides/b/bulge',
  'coach3': '/t/tides/b/bulge',
  // The lessons, for the "?" in the app bar and the help it opens.
  'help': '/',
  // Two levels deep in a lesson with several tangents, for the tangents
  // drawer the app bar's list button opens.
  'tangents': '/t/tides/b/far-side',
};

/// The screens shot for an account that hasn't had the walkthrough.
const _firstRun = {'coach1', 'coach2', 'coach3'};

/// The screens with a tangent from the first reply.
const _withTangent = {
  'in-tangent',
  'back-on-trunk',
  'coach2',
  'coach3',
  'tangents',
};

/// The screens with tangents beyond that one, some of them nested.
const _withMoreTangents = {'tangents'};

const _trunkReply = '''
Tides are the sea rising and falling twice a day, and the **Moon** does most of the work.

Its gravity pulls hardest on the water facing it, so the ocean heaps up into a bulge there. The Earth turns under that bulge, and each coast passes through it: high tide.

<tangents>
- [deeper] Why two tides a day? — the bulge on the far side
- [tangent] What is a tidal bulge? — the shape the pull makes
- [tangent] Spring and neap tides — when the Sun joins in
- [tangent] Tidal locking — why we only ever see one face of the Moon
</tangents>''';

const _tangentReply = '''
A tidal bulge is the ocean stretched into a slight egg shape, a metre or so high in open water, pointing at the Moon and away from it.

<tangents>
- [deeper] How high does it get? — coasts that funnel it
- [tangent] Why away from the Moon too? — the pull is weaker there
</tangents>''';

const _nextReply = '''
Here is the next step: the bulge on the far side forms because the Moon pulls the Earth itself a little more than the water behind it.

<tangents>
- [deeper] What sets the exact times? — the Moon's day is 24 h 50 min
- [tangent] Inertia — what “left behind” really means
</tangents>''';

const _farSideReply = '''
The Moon pulls hardest on the side of the Earth facing it, less on the Earth's centre, and least on the far side. So the far ocean is left behind as the Earth is pulled away from it, and it heaps up too.

Two bulges, one on each side, and every coast turns through both of them a day: two high tides.

<tangents>
- [deeper] Why not exactly 12 hours apart? — the Moon moves on
- [tangent] Is it really "left behind"? — the stretch, not a push
</tangents>''';

/// The tangents of the 'tangents' screen beyond the first: id, the branch
/// and reply it forks from, and its title.
const _moreTangents = [
  ('far-side', 'bulge', 's2', 'Why away from the Moon too?'),
  ('spring', 'trunk', 'a1', 'Spring and neap tides'),
  ('sun', 'spring', 'spring-a', 'Why does the Sun pull less?'),
  ('locking', 'trunk', 'a1', 'Tidal locking'),
];

/// A [TangentApi] for the screenshot harnesses (screens.dart in a browser,
/// screenshots/store_screenshots_test.dart headlessly): a learner who
/// is signed in, one lesson about tides, and replies that write themselves.
/// It stands in for the Worker so the screens look the same on every run;
/// the widget tests use test/fakes.dart instead.
class ScreenApi implements TangentApi {
  ScreenApi({required this.screen}) {
    _branches['trunk'] = _branch('trunk', title: '');
    _nodes
      ..add(_node('u1', 'trunk', 0, Role.user, 'Why are there tides?'))
      ..add(_node('a1', 'trunk', 1, Role.assistant, _trunkReply));
    if (_withTangent.contains(screen)) {
      _branches['bulge'] = _branch(
        'bulge',
        parent: 'trunk',
        fork: 'a1',
        title: 'What is a tidal bulge?',
      );
      _nodes
        ..add(_node('s1', 'bulge', 0, Role.user, 'What is a tidal bulge?'))
        ..add(_node('s2', 'bulge', 1, Role.assistant, _tangentReply));
    }
    if (_withMoreTangents.contains(screen)) {
      for (final (id, parent, fork, title) in _moreTangents) {
        _branches[id] = _branch(id, parent: parent, fork: fork, title: title);
        final reply = id == 'far-side' ? _farSideReply : _tangentReply;
        _nodes
          ..add(_node('$id-u', id, 0, Role.user, title))
          ..add(_node('$id-a', id, 1, Role.assistant, reply));
      }
    }
  }

  /// One of [screenLocations]' names.
  final String screen;

  final _branches = <String, Branch>{};
  final _nodes = <ChatNode>[];
  var _count = 0;

  static const _treeId = 'tides';

  Branch _branch(
    String id, {
    String? parent,
    String? fork,
    required String title,
    String? anchorQuote,
  }) => Branch(
    id: id,
    treeId: _treeId,
    parentBranchId: parent,
    branchPointNodeId: fork,
    title: title,
    anchorQuote: anchorQuote,
  );

  ChatNode _node(
    String id,
    String branchId,
    int seq,
    Role role,
    String content, {
    NodeStatus status = NodeStatus.complete,
  }) => ChatNode(
    id: id,
    branchId: branchId,
    parentId: null,
    seq: seq,
    role: role,
    content: content,
    status: status,
    error: null,
    errorKind: null,
  );

  @override
  set payer(Payer payer) {}

  @override
  set ownKey(LearnKey key) {}

  @override
  Future<LoginOptions> loginOptions() async => const LoginOptions(
    configured: true,
    devMode: true,
    turnstileSiteKey: null,
    signupsOpen: true,
  );

  @override
  Future<void> sendMagicLink({
    required String email,
    required String captchaToken,
    required String callbackPath,
    required String errorCallbackPath,
  }) async {}

  @override
  Future<void> signInWithCode({
    required String email,
    required String code,
  }) async {}

  @override
  Future<Uri> socialSignInUrl({
    required String provider,
    required String callbackPath,
    required String errorCallbackPath,
  }) async => Uri.parse('https://accounts.google.com/');

  @override
  Future<void> signInWithGoogle({
    required String idToken,
    required String captchaToken,
  }) async {}

  @override
  Future<Me> me() async => const Me(
    userId: 'learner',
    email: 'learner@example.com',
    devMode: true,
    builtInCredit: true,
  );

  @override
  Future<bool> refreshSession() async => true;

  @override
  Future<void> signOut() async {}

  @override
  Future<void> deleteAccount(String confirmEmail) async {}

  @override
  Future<Settings> settings() async => Settings(
    walkthroughDoneAt: _firstRun.contains(screen) && !_walkthroughDone
        ? null
        : '2026-01-01T00:00:00.000Z',
  );

  var _walkthroughDone = false;

  @override
  Future<void> markWalkthroughDone() async => _walkthroughDone = true;

  @override
  Future<PoolStatus> poolStatus() async =>
      const PoolStatus(enabled: false, modelLabel: null);

  @override
  Future<BillingSummary> billing() async => const BillingSummary(
    enabled: true,
    builtInCredit: true,
    availableMicros: 5000000,
  );

  // The learner pays with credit: no key of their own.
  @override
  Future<KeyStatus> keyStatus() async =>
      const KeyStatus(enabled: true, providers: []);

  @override
  Future<void> saveKey(LearnKey key, String apiKey) async {}

  @override
  Future<void> forgetKey(LearnKey key) async {}

  @override
  Future<List<ProviderInfo>> providers() async => const [
    ProviderInfo(id: 'openrouter'),
  ];

  @override
  Future<List<TreeSummary>> trees() async => [
    TreeSummary(
      id: _treeId,
      title: 'How tides work',
      updatedAt: DateTime.now(),
      branchCount: _branches.length,
    ),
  ];

  @override
  Future<TreeDetail> createTree({String? providerId}) => tree(_treeId);

  @override
  Future<TreeDetail> tree(String treeId) async => TreeDetail(
    tree: const Tree(
      id: _treeId,
      title: 'How tides work',
      trunkBranchId: 'trunk',
    ),
    branches: _branches.values.toList(),
    nodes: List.of(_nodes),
  );

  @override
  Future<void> deleteTree(String treeId) async {}

  @override
  Future<Branch> createBranch({
    required String fromNodeId,
    String? title,
    String? anchorQuote,
  }) async {
    final from = _nodes.firstWhere((n) => n.id == fromNodeId);
    final created = _branch(
      'side-${++_count}',
      parent: from.branchId,
      fork: fromNodeId,
      title: title ?? '',
      anchorQuote: anchorQuote,
    );
    _branches[created.id] = created;
    return created;
  }

  /// Writes a canned reply a few words at a time.
  @override
  Stream<StreamEvent> sendMessage(String branchId, String content) async* {
    final branch = _branches[branchId]!;
    final seq = _nodes.where((n) => n.branchId == branchId).length;
    final id = ++_count;
    final user = _node('u-$id', branchId, seq, Role.user, content);
    final reply = branch.parentBranchId == null ? _nextReply : _tangentReply;
    var assistant = _node(
      'a-$id',
      branchId,
      seq + 1,
      Role.assistant,
      '',
      status: NodeStatus.streaming,
    );
    _nodes.add(user);
    yield StartEvent(userNode: user, assistantNode: assistant, branch: branch);
    for (final word in reply.split(' ')) {
      await Future<void>.delayed(const Duration(milliseconds: 15));
      yield DeltaEvent(nodeId: assistant.id, text: '$word ');
    }
    assistant = _node('a-$id', branchId, seq + 1, Role.assistant, reply);
    _nodes.add(assistant);
    yield DoneEvent(node: assistant, branch: branch);
  }

  @override
  Stream<StreamEvent> resume(String nodeId) => const Stream.empty();

  @override
  Future<void> cancel(String nodeId) async {}

  /// Keeps the lesson as it is, so every screen shows the same messages.
  @override
  Future<DeletedMessages> deleteMessage(String nodeId) async =>
      const DeletedMessages(branchIds: [], nodeIds: []);
}
