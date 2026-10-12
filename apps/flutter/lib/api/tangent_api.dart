import 'models.dart';

/// The Worker's HTTP API, as this app uses it. `HttpTangentApi` is the real
/// one; tests use a fake. Every call throws [ApiException] on a non-2xx
/// response.
abstract interface class TangentApi {
  /// Who pays for replies from here on (`x-tangent-payment`).
  set payer(Payer payer);

  // Sign-in (Better Auth under /api/auth).

  Future<LoginOptions> loginOptions();

  /// Emails a magic link and a 6-digit code. [captchaToken] is Turnstile's
  /// token (`x-captcha-response`). Opening the link signs in and lands on
  /// [callbackPath], a path on this origin; the code signs in through
  /// [signInWithCode].
  Future<void> sendMagicLink({
    required String email,
    required String captchaToken,
    required String callbackPath,
    required String errorCallbackPath,
  });

  /// Signs in with the code from the sign-in email; the first sign-in
  /// creates the account. Throws `INVALID_OTP` for a wrong code,
  /// `OTP_EXPIRED` and `TOO_MANY_ATTEMPTS` when it no longer works.
  Future<void> signInWithCode({required String email, required String code});

  /// The signed-in user; throws `unauthorized` when signed out.
  Future<Me> me();

  /// Rolls the session forward (`GET /api/auth/get-session`). Returns false
  /// when there is no session.
  Future<bool> refreshSession();

  Future<void> signOut();

  /// Deletes the signed-in account and everything in it (`DELETE
  /// /api/account`). [confirmEmail] must be the account's email, which the
  /// server checks; afterwards there is no session.
  Future<void> deleteAccount(String confirmEmail);

  /// The account's settings (`GET /api/settings`).
  Future<Settings> settings();

  /// Records that the account finished or skipped the first-run walkthrough
  /// (`PATCH /api/settings`), so it doesn't show again on any device.
  Future<void> markWalkthroughDone();

  // Paying for replies.

  Future<PoolStatus> poolStatus();
  Future<BillingSummary> billing();

  // The learner's own OpenRouter key. The server seals it into the
  // `__Host-llmkey` cookie and never returns any part of it.

  Future<KeyStatus> keyStatus();

  /// Saves [apiKey] as the learner's OpenRouter key, once the server has
  /// checked it with OpenRouter; a rejected key throws `bad_request`.
  Future<void> saveKey(String apiKey);

  Future<void> forgetKey();

  // Lessons.

  Future<List<ProviderInfo>> providers();
  Future<List<TreeSummary>> trees();

  /// A new lesson on [providerId] and [model] (the server's defaults when
  /// null). Its trunk is empty.
  Future<TreeDetail> createTree({String? providerId, String? model});
  Future<TreeDetail> tree(String treeId);
  Future<void> deleteTree(String treeId);

  /// A side branch from [fromNodeId] (context mode `path`).
  Future<Branch> createBranch({
    required String fromNodeId,
    String? title,
    String? anchorQuote,
  });

  /// Switches a branch's model (Normal/Max).
  Future<Branch> setBranchModel(String branchId, String model);

  // Replies.

  /// Sends [content] on [branchId] and streams the reply. A refusal (out of
  /// credit, pool empty, …) throws [ApiException] before any event.
  Stream<StreamEvent> sendMessage(String branchId, String content);

  /// Re-attaches to a reply still being written: snapshot, then live events.
  Stream<StreamEvent> resume(String nodeId);

  /// Stops a reply; its stream then ends with an error event (`cancelled`).
  Future<void> cancel(String nodeId);
}
