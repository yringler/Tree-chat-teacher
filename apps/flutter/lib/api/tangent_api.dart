import 'models.dart';

/// The Worker's HTTP API, as this app uses it. `HttpTangentApi` is the real
/// one; tests use a fake. Every call throws [ApiException] on a non-2xx
/// response.
abstract interface class TangentApi {
  /// Who pays for replies from here on (`x-tangent-payment`).
  set payer(Payer payer);

  /// Which own key replies run on while the learner pays with one
  /// (`x-tangent-own-key`).
  set ownKey(LearnKey key);

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

  /// Starts a browser's sign-in with [provider] (`google` or `github`) and
  /// returns the provider's page to open. Coming back signs in, the first
  /// time creating the account, and lands on [callbackPath], or on
  /// [errorCallbackPath] with `?error=`. The web build only: the callback
  /// signs the browser in, with its cookie.
  Future<Uri> socialSignInUrl({
    required String provider,
    required String callbackPath,
    required String errorCallbackPath,
  });

  /// Signs in with an ID token Google issued to this app (a native build);
  /// the first sign-in creates the account. [captchaToken] is Turnstile's
  /// token, as for [sendMagicLink].
  Future<void> signInWithGoogle({
    required String idToken,
    required String captchaToken,
  });

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

  /// Saves the Advanced settings [tier] and [replyLength] names, keeping the
  /// other (`PATCH /api/settings`); answers them as saved.
  Future<LearnReplySettings> updateLearnReply({
    ModelTier? tier,
    ReplyLength? replyLength,
  });

  // Paying for replies.

  Future<PoolStatus> poolStatus();
  Future<BillingSummary> billing();

  // The learner's own keys. The server seals them into the
  // `__Host-llmkey` cookie and never returns any part of them.

  Future<KeyStatus> keyStatus();

  /// Saves [apiKey] as the learner's [key], once the server has checked it
  /// with that provider; a rejected key throws `bad_request`.
  Future<void> saveKey(LearnKey key, String apiKey);

  Future<void> forgetKey(LearnKey key);

  // Lessons.

  Future<List<ProviderInfo>> providers();
  Future<List<TreeSummary>> trees();

  /// A new lesson on [providerId] (the server's default when null) and that
  /// provider's default model. Its trunk is empty.
  Future<TreeDetail> createTree({String? providerId});
  Future<TreeDetail> tree(String treeId);
  Future<void> deleteTree(String treeId);

  /// A side branch from [fromNodeId] (context mode `path`).
  Future<Branch> createBranch({
    required String fromNodeId,
    String? title,
    String? anchorQuote,
  });

  // Replies.

  /// Sends [content] on [branchId] and streams the reply. A refusal (out of
  /// credit, pool empty, …) throws [ApiException] before any event.
  Stream<StreamEvent> sendMessage(String branchId, String content);

  /// Re-attaches to a reply still being written: snapshot, then live events.
  Stream<StreamEvent> resume(String nodeId);

  /// Stops a reply; its stream then ends with an error event (`cancelled`).
  Future<void> cancel(String nodeId);

  /// Deletes one of the learner's messages with everything after it on its
  /// thread: the later messages, and the tangents started from them. The
  /// first message of a tangent takes the tangent. Replies being written
  /// there are stopped.
  Future<DeletedMessages> deleteMessage(String nodeId);
}
