import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/api/models.dart';
import 'package:tangent/api/tangent_api.dart';
import 'package:tangent/api/token_store.dart';
import 'package:tangent/app.dart';
import 'package:tangent/ui/login_page.dart';

const unauthorized = ApiException(
  status: 401,
  code: 'unauthorized',
  message: 'Sign in first',
);

const signedInMe = Me(
  userId: 'u1',
  email: 'ada@example.com',
  devMode: false,
  builtInCredit: true,
);

ChatNode node(
  String id, {
  required String branch,
  required int seq,
  Role role = Role.user,
  String content = '',
  NodeStatus status = NodeStatus.complete,
  String? errorKind,
}) => ChatNode(
  id: id,
  branchId: branch,
  parentId: null,
  seq: seq,
  role: role,
  content: content,
  status: status,
  error: null,
  errorKind: errorKind,
);

Branch branch(
  String id, {
  String treeId = 't1',
  String? parent,
  String? fork,
  String title = '',
  String? anchorQuote,
}) => Branch(
  id: id,
  treeId: treeId,
  parentBranchId: parent,
  branchPointNodeId: fork,
  title: title,
  anchorQuote: anchorQuote,
);

TreeDetail treeDetail({
  String id = 't1',
  String title = 'New conversation',
  List<Branch>? branches,
  List<ChatNode> nodes = const [],
}) => TreeDetail(
  tree: Tree(id: id, title: title, trunkBranchId: 'trunk'),
  branches: branches ?? [branch('trunk', treeId: id)],
  nodes: nodes,
);

/// A reply stream the test drives event by event.
class ScriptedStream {
  ScriptedStream(this.target, this.content);

  /// The branch it was sent on, or the node it resumes.
  final String target;
  final String? content;
  final controller = StreamController<StreamEvent>();
}

/// A [TangentApi] with scripted answers that records what the app asked.
class FakeTangentApi implements TangentApi {
  Payer? payerSet;

  @override
  set payer(Payer payer) => payerSet = payer;

  /// Answers to `me()` in turn; the last one repeats.
  List<Object> meAnswers = [signedInMe];
  LoginOptions loginOptionsAnswer = const LoginOptions(
    configured: true,
    devMode: false,
    turnstileSiteKey: 'site-key',
    signupsOpen: true,
  );
  BillingSummary billingAnswer = const BillingSummary(
    enabled: true,
    builtInCredit: true,
    availableMicros: 0,
  );
  PoolStatus poolStatusAnswer = const PoolStatus(
    enabled: false,
    modelLabel: null,
  );
  KeyStatus keyStatusAnswer = const KeyStatus(enabled: true, providers: []);

  /// Thrown by `saveKey`, when set; otherwise the key is saved.
  ApiException? refuseKey;

  /// The keys `saveKey` was given.
  final savedKeys = <String>[];
  List<ProviderInfo> providersAnswer = const [
    ProviderInfo(id: 'other'),
    ProviderInfo(id: 'openrouter'),
  ];
  List<TreeSummary> treesAnswer = const [];

  /// Done by default, so only the tests of the walkthrough see it.
  Settings settingsAnswer = const Settings(
    walkthroughDoneAt: '2026-01-01T00:00:00.000Z',
  );

  /// How often `markWalkthroughDone` was called.
  var walkthroughDoneMarks = 0;
  final details = <String, TreeDetail>{};

  /// Thrown by `sendMessage`'s stream before any event, when set.
  ApiException? refuseSend;

  /// Thrown by `signInWithCode`, when set; otherwise the code signs in.
  ApiException? refuseCode;

  /// Thrown by `deleteAccount`, when set; otherwise the account goes.
  ApiException? refuseDeleteAccount;

  final magicLinks = <({String email, String captchaToken})>[];
  final codes = <({String email, String code})>[];
  final socialStarts = <({String provider, String callbackPath})>[];
  final googleSignIns = <({String idToken, String captchaToken})>[];

  /// Thrown by `signInWithGoogle`, when set; otherwise the token signs in.
  ApiException? refuseGoogle;

  /// The provider ids `createTree` was given.
  final createdTrees = <String?>[];
  final createdBranches =
      <({String fromNodeId, String? title, String? anchorQuote})>[];
  final deletedTrees = <String>[];

  /// The emails `deleteAccount` was confirmed with.
  final deletedAccounts = <String>[];
  final sends = <ScriptedStream>[];
  final resumes = <ScriptedStream>[];
  final cancelled = <String>[];
  var signedOut = false;
  var _meCalls = 0;
  var _branchCount = 0;

  @override
  Future<LoginOptions> loginOptions() async => loginOptionsAnswer;

  @override
  Future<void> sendMagicLink({
    required String email,
    required String captchaToken,
    required String callbackPath,
    required String errorCallbackPath,
  }) async {
    magicLinks.add((email: email, captchaToken: captchaToken));
  }

  @override
  Future<void> signInWithCode({
    required String email,
    required String code,
  }) async {
    codes.add((email: email, code: code));
    final refusal = refuseCode;
    if (refusal != null) throw refusal;
    meAnswers = [signedInMe];
  }

  @override
  Future<Uri> socialSignInUrl({
    required String provider,
    required String callbackPath,
    required String errorCallbackPath,
  }) async {
    socialStarts.add((provider: provider, callbackPath: callbackPath));
    return Uri.parse('https://accounts.example/$provider');
  }

  @override
  Future<void> signInWithGoogle({
    required String idToken,
    required String captchaToken,
  }) async {
    googleSignIns.add((idToken: idToken, captchaToken: captchaToken));
    final refusal = refuseGoogle;
    if (refusal != null) throw refusal;
    meAnswers = [signedInMe];
  }

  @override
  Future<Me> me() async {
    final answer = meAnswers[_meCalls.clamp(0, meAnswers.length - 1)];
    _meCalls++;
    if (answer is Me) return answer;
    throw answer;
  }

  @override
  Future<bool> refreshSession() async => true;

  @override
  Future<void> signOut() async => signedOut = true;

  @override
  Future<void> deleteAccount(String confirmEmail) async {
    final refusal = refuseDeleteAccount;
    if (refusal != null) throw refusal;
    deletedAccounts.add(confirmEmail);
    meAnswers = [unauthorized];
  }

  @override
  Future<Settings> settings() async => settingsAnswer;

  @override
  Future<void> markWalkthroughDone() async => walkthroughDoneMarks++;

  @override
  Future<PoolStatus> poolStatus() async => poolStatusAnswer;

  @override
  Future<BillingSummary> billing() async => billingAnswer;

  @override
  Future<KeyStatus> keyStatus() async => keyStatusAnswer;

  @override
  Future<void> saveKey(String apiKey) async {
    final refusal = refuseKey;
    if (refusal != null) throw refusal;
    savedKeys.add(apiKey);
    keyStatusAnswer = const KeyStatus(
      enabled: true,
      providers: [openRouterProviderId],
    );
  }

  @override
  Future<void> forgetKey() async =>
      keyStatusAnswer = const KeyStatus(enabled: true, providers: []);

  @override
  Future<List<ProviderInfo>> providers() async => providersAnswer;

  @override
  Future<List<TreeSummary>> trees() async => treesAnswer;

  @override
  Future<TreeDetail> createTree({String? providerId}) async {
    createdTrees.add(providerId);
    final detail = treeDetail(id: 'new-tree');
    details[detail.tree.id] = detail;
    return detail;
  }

  @override
  Future<TreeDetail> tree(String treeId) async {
    final detail = details[treeId];
    if (detail == null) {
      throw const ApiException(
        status: 404,
        code: 'not_found',
        message: 'No such lesson',
      );
    }
    return detail;
  }

  @override
  Future<void> deleteTree(String treeId) async => deletedTrees.add(treeId);

  @override
  Future<Branch> createBranch({
    required String fromNodeId,
    String? title,
    String? anchorQuote,
  }) async {
    createdBranches.add((
      fromNodeId: fromNodeId,
      title: title,
      anchorQuote: anchorQuote,
    ));
    return branch(
      'side-${++_branchCount}',
      parent: 'trunk',
      fork: fromNodeId,
      title: title ?? '',
      anchorQuote: anchorQuote,
    );
  }

  @override
  Stream<StreamEvent> sendMessage(String branchId, String content) {
    final scripted = ScriptedStream(branchId, content);
    sends.add(scripted);
    final refusal = refuseSend;
    if (refusal != null) {
      scripted.controller
        ..addError(refusal)
        ..close();
    }
    return scripted.controller.stream;
  }

  @override
  Stream<StreamEvent> resume(String nodeId) {
    final scripted = ScriptedStream(nodeId, null);
    resumes.add(scripted);
    return scripted.controller.stream;
  }

  @override
  Future<void> cancel(String nodeId) async => cancelled.add(nodeId);
}

/// Pumps frames until routes and loads settle. Not `pumpAndSettle`: a reply
/// being written blinks its cursor forever.
Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 10; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

/// Turnstile's stand-in: solved by a tap.
Widget fakeCaptcha({
  Key? key,
  required String siteKey,
  required ValueChanged<String?> onToken,
}) => TextButton(
  key: key,
  onPressed: () => onToken('captcha-token'),
  child: const Text('Solve'),
);

Future<void> pumpApp(
  WidgetTester tester,
  FakeTangentApi api, {
  String location = '/',
  CaptchaBuilder captcha = fakeCaptcha,
}) async {
  await tester.pumpWidget(
    TangentApp(api: api, initialLocation: location, captcha: captcha),
  );
  await settle(tester);
}

/// A [TokenStore] in memory.
class MemoryStore implements TokenStore {
  String? value;

  @override
  Future<String?> read() async => value;

  @override
  Future<void> write(String token) async => value = token;

  @override
  Future<void> clear() async => value = null;
}
