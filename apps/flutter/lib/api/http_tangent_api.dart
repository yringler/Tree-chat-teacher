import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'models.dart';
import 'reply_stream.dart';
import 'sse.dart';
import 'tangent_api.dart';
import 'token_store.dart';

/// [TangentApi] over `package:http`. On the web, `http.Client()` is a
/// fetch-based client that streams response bodies and sends the session
/// and key cookies on same-origin requests. A native build has no cookies:
/// it signs in by code and keeps the session token in [tokens], sending it
/// as `Authorization: Bearer`, and keeps the sealed key cookie in
/// [keyCookie], sending it back as the browser would.
class HttpTangentApi implements TangentApi {
  HttpTangentApi({
    required this.baseUri,
    http.Client? client,
    this.tokens,
    this.keyCookie,
    this._idleTimeout = const Duration(seconds: 45),
    this._headersTimeout = const Duration(seconds: 30),
  }) : _client = client ?? http.Client();

  /// The Worker's origin; every call goes to `/api` under it.
  final Uri baseUri;
  final http.Client _client;

  /// Where the session token is kept; null on the web.
  final TokenStore? tokens;

  /// The token, read from [tokens] before the first call.
  Future<String?>? _token;

  /// Where the sealed `__Host-llmkey` cookie is kept; null on the web. The
  /// value is sealed by the Worker for this user, so the app can't read the
  /// key in it.
  final TokenStore? keyCookie;

  /// The key cookie's value, read from [keyCookie] before the first call.
  Future<String?>? _keyCookieValue;

  /// How long a reply's body may go without a byte before its connection
  /// counts as lost. The server sends a keepalive comment every 15s
  /// (`KEEPALIVE_MS` in apps/worker/src/do/tree-session.ts), so three missed
  /// in a row mean the connection is gone.
  final Duration _idleTimeout;

  /// How long a reply's connection or a JSON read may wait for the
  /// response's headers, and a JSON body for its next byte, before its
  /// connection counts as lost.
  final Duration _headersTimeout;

  /// The server's own default when the header is absent; the app sets it
  /// once it knows who pays.
  @override
  Payer payer = Payer.ownKey;

  /// OpenRouter, the server's own default when the header is absent.
  @override
  LearnKey ownKey = LearnKey.openRouter;

  // Sign-in.

  @override
  Future<LoginOptions> loginOptions() async =>
      LoginOptions.fromJson(await _object('GET', ['login-options']));

  @override
  Future<void> sendMagicLink({
    required String email,
    required String captchaToken,
    required String callbackPath,
    required String errorCallbackPath,
  }) async {
    await _send(
      'POST',
      ['auth', 'sign-in', 'magic-link'],
      body: {
        'email': email,
        'callbackURL': callbackPath,
        'errorCallbackURL': errorCallbackPath,
      },
      headers: {'x-captcha-response': captchaToken},
    );
  }

  @override
  Future<void> signInWithCode({
    required String email,
    required String code,
  }) async {
    final response = await _send(
      'POST',
      ['auth', 'sign-in', 'email-otp'],
      body: {'email': email, 'otp': code},
    );
    await _keepSessionToken(response);
  }

  @override
  Future<Uri> socialSignInUrl({
    required String provider,
    required String callbackPath,
    required String errorCallbackPath,
  }) async {
    final json = await _object(
      'POST',
      ['auth', 'sign-in', 'social'],
      body: {
        'provider': provider,
        'callbackURL': callbackPath,
        'errorCallbackURL': errorCallbackPath,
      },
    );
    return Uri.parse(json.str('url'));
  }

  @override
  Future<void> signInWithGoogle({
    required String idToken,
    required String captchaToken,
  }) async {
    final response = await _send(
      'POST',
      ['auth', 'sign-in', 'social'],
      body: {
        'provider': 'google',
        'idToken': {'token': idToken},
      },
      headers: {'x-captcha-response': captchaToken},
    );
    await _keepSessionToken(response);
  }

  /// Keeps the signed session token a sign-in answered with (Better Auth's
  /// bearer plugin), for a client that keeps it itself. Without one such a
  /// client would stay signed out with nothing said, so that is an error.
  Future<void> _keepSessionToken(http.StreamedResponse response) async {
    await response.stream.drain<void>();
    final token = response.headers['set-auth-token'];
    final store = tokens;
    if (store == null) return;
    if (token == null || token.isEmpty) {
      throw ApiException(
        status: response.statusCode,
        code: 'no_session_token',
        message:
            'The server signed you in but sent the app no session. '
            'Please try again.',
      );
    }
    await store.write(token);
    _token = Future.value(token);
  }

  @override
  Future<Me> me() async => Me.fromJson(await _object('GET', ['me']));

  @override
  Future<bool> refreshSession() async =>
      await _json('GET', ['auth', 'get-session']) != null;

  @override
  Future<void> signOut() async {
    try {
      await _send('POST', [
        'auth',
        'sign-out',
      ], body: const <String, Object?>{});
    } finally {
      // Signed out on this device either way, and the key with the session,
      // as the server clears the browser's key cookie.
      await _forgetSession();
    }
  }

  @override
  Future<void> deleteAccount(String confirmEmail) async {
    await _send('DELETE', ['account'], body: {'confirmEmail': confirmEmail});
    // The session went with the account. A refusal throws above and keeps
    // the token: the account is still there.
    await _forgetSession();
  }

  Future<void> _forgetSession() async {
    _token = Future.value(null);
    await tokens?.clear();
    await _keepKeyCookie('');
  }

  @override
  Future<Settings> settings() async =>
      Settings.fromJson(await _object('GET', ['settings']));

  @override
  Future<void> markWalkthroughDone() async {
    await _send('PATCH', ['settings'], body: {'walkthroughDone': true});
  }

  @override
  Future<LearnReplySettings> updateLearnReply({
    ModelTier? tier,
    ReplyLength? replyLength,
  }) async {
    final saved = await _object(
      'PATCH',
      ['settings'],
      body: {
        'learn': {
          if (tier != null) 'tier': tier.id,
          if (replyLength != null) 'replyLength': replyLength.id,
        },
      },
    );
    return Settings.fromJson(saved).learn;
  }

  // Paying for replies.

  @override
  Future<PoolStatus> poolStatus() async =>
      PoolStatus.fromJson(await _object('GET', ['pool', 'status']));

  @override
  Future<BillingSummary> billing() async =>
      BillingSummary.fromJson(await _object('GET', ['billing']));

  // The learner's own key.

  @override
  Future<KeyStatus> keyStatus() async =>
      KeyStatus.fromJson(await _object('GET', ['key', 'status']));

  @override
  Future<void> saveKey(LearnKey key, String apiKey) async {
    await _send('POST', ['key'], body: {'provider': key.id, 'apiKey': apiKey});
  }

  @override
  Future<void> forgetKey(LearnKey key) async {
    await _send('DELETE', ['key'], body: {'provider': key.id});
  }

  // Lessons.

  @override
  Future<List<ProviderInfo>> providers() async =>
      (await _list('GET', ['providers'])).map(ProviderInfo.fromJson).toList();

  @override
  Future<List<TreeSummary>> trees() async =>
      (await _list('GET', ['trees'])).map(TreeSummary.fromJson).toList();

  @override
  Future<TreeDetail> createTree({String? providerId}) async =>
      TreeDetail.fromJson(
        await _object('POST', ['trees'], body: {'providerId': ?providerId}),
      );

  @override
  Future<TreeDetail> tree(String treeId) async =>
      TreeDetail.fromJson(await _object('GET', ['trees', treeId]));

  @override
  Future<void> deleteTree(String treeId) async {
    await _send('DELETE', ['trees', treeId]);
  }

  @override
  Future<Branch> createBranch({
    required String fromNodeId,
    String? title,
    String? anchorQuote,
  }) async => Branch.fromJson(
    await _object(
      'POST',
      ['branches'],
      body: {
        'fromNodeId': fromNodeId,
        'contextMode': 'path',
        'anchorQuote': anchorQuote,
        'title': ?title,
      },
    ),
  );

  // Replies.

  @override
  Future<Stream<StreamEvent>> sendMessage(
    String branchId,
    String content, {
    Future<void>? abort,
  }) async => _events(
    await _send(
      'POST',
      ['branches', branchId, 'messages'],
      body: {'content': content},
      timeout: _headersTimeout,
      abort: abort,
    ),
  );

  @override
  Future<Stream<StreamEvent>> attachReply(
    String nodeId, {
    Future<void>? abort,
  }) async => _events(
    await _send(
      'GET',
      ['nodes', nodeId, 'stream'],
      timeout: _headersTimeout,
      abort: abort,
    ),
  );

  @override
  Future<void> cancel(String nodeId) async {
    await _send('POST', ['nodes', nodeId, 'cancel']);
  }

  @override
  Future<DeletedMessages> deleteMessage(String nodeId) async =>
      DeletedMessages.fromJson(await _object('DELETE', ['nodes', nodeId]));

  /// A reply's response body as events. A connection lost mid-body fails
  /// it with an [ApiException], as [ReplyTransport] asks: so does silence
  /// past [_idleTimeout], which is how a connection that died without a
  /// reset (a phone changing network) shows. The timer watches bytes, so
  /// the server's keepalive comments, which give no event, keep it alive.
  Stream<StreamEvent> _events(http.StreamedResponse response) =>
      readStreamEvents(_failWhenQuiet(response.stream, _idleTimeout)).transform(
        StreamTransformer.fromHandlers(
          handleError: (error, stack, sink) =>
              sink.addError(_bodyError(error), stack),
        ),
      );

  /// What a body's [error] means. Mid-body, package:http wraps an
  /// `HttpException` in a [http.ClientException] but passes a
  /// `SocketException` or `TlsException` through as it is, so any exception
  /// but a [FormatException] (a frame of ours with the wrong shape: a bug)
  /// is the connection.
  static Object _bodyError(Object error) => switch (error) {
    ApiException() || FormatException() || Error() => error,
    http.ClientException() => _network(error),
    _ => ApiException.connectionLost,
  };

  static ApiException _network(http.ClientException error) =>
      ApiException(status: 0, code: 'network', message: error.message);

  static ApiException _noAnswer(Duration timeout) => ApiException(
    status: 0,
    code: 'network',
    message: 'No answer from the server in ${timeout.inSeconds}s',
  );

  /// [body], which fails with [_noAnswer] and stops reading once it goes
  /// [limit] without a byte; stopping drops the connection, on a client
  /// that can. Not [Stream.timeout]: its stream waits for a microtask of
  /// the root zone to end or fail, which fake_async never runs.
  static Stream<List<int>> _failWhenQuiet(
    Stream<List<int>> body,
    Duration limit,
  ) {
    final out = StreamController<List<int>>(sync: true);
    StreamSubscription<List<int>>? reading;
    Timer? quiet;
    void wait() {
      quiet?.cancel();
      quiet = Timer(limit, () {
        unawaited(reading?.cancel());
        out.addError(_noAnswer(limit));
        unawaited(out.close());
      });
    }

    out
      ..onListen = () {
        wait();
        reading = body.listen(
          (chunk) {
            wait();
            out.add(chunk);
          },
          onError: (Object error, StackTrace stack) {
            wait();
            out.addError(error, stack);
          },
          onDone: () {
            quiet?.cancel();
            unawaited(out.close());
          },
        );
      }
      ..onPause = () {
        quiet?.cancel();
        reading?.pause();
      }
      ..onResume = () {
        wait();
        reading?.resume();
      }
      ..onCancel = () {
        quiet?.cancel();
        unawaited(reading?.cancel());
      };
    return out.stream;
  }

  // Plumbing.

  Future<Json> _object(String method, List<String> path, {Json? body}) async {
    final value = await _json(method, path, body: body);
    if (value is Json) return value;
    throw FormatException('Expected a JSON object from /api/${path.join('/')}');
  }

  Future<List<Json>> _list(String method, List<String> path) async {
    final value = await _json(method, path);
    if (value is List<Object?>) return value.cast<Json>();
    throw FormatException('Expected a JSON array from /api/${path.join('/')}');
  }

  /// A JSON response's body, decoded. Its headers, and each stretch of its
  /// body without a byte, get [_headersTimeout]: a read on a link that died
  /// fails then, so whatever waits on it (a reply shown being written, a
  /// send) moves on.
  Future<Object?> _json(String method, List<String> path, {Json? body}) async {
    final response = await _send(
      method,
      path,
      body: body,
      timeout: _headersTimeout,
    );
    try {
      final text = await http.ByteStream(
        _failWhenQuiet(response.stream, _headersTimeout),
      ).bytesToString();
      return jsonDecode(text);
    } on http.ClientException catch (error) {
      throw _network(error);
    }
  }

  /// Sends a request under `/api` and returns a 2xx response with its body
  /// unread; anything else throws [ApiException], as does a response whose
  /// headers take longer than [timeout]. Once [abort] completes, the
  /// request and its body are aborted, on a client that can.
  Future<http.StreamedResponse> _send(
    String method,
    List<String> path, {
    Json? body,
    Map<String, String> headers = const {},
    Duration? timeout,
    Future<void>? abort,
  }) async {
    final token = await (_token ??= _read(tokens));
    final key = await (_keyCookieValue ??= _read(keyCookie));
    final aborted = Completer<void>();
    void abortRequest() {
      if (!aborted.isCompleted) aborted.complete();
    }

    unawaited(abort?.then((_) => abortRequest()));
    final request =
        http.AbortableRequest(method, _url(path), abortTrigger: aborted.future)
          ..headers.addAll({
            'x-tangent-mode': 'simple',
            'x-tangent-payment': payer.header,
            'x-tangent-own-key': ownKey.id,
            'accept': 'application/json, text/event-stream',
            if (body != null) 'content-type': 'application/json',
            if (token != null) 'authorization': 'Bearer $token',
            // Better Auth refuses a POST with cookies but no Origin, and needs
            // no key.
            if (key != null && key.isNotEmpty && path.first != 'auth')
              'cookie': '$keyCookieName=$key',
            ...headers,
          });
    // Bytes, not `body`, so package:http leaves the content type as set.
    if (body != null) request.bodyBytes = utf8.encode(jsonEncode(body));
    try {
      final sent = _client.send(request);
      final response = timeout == null
          ? await sent
          : await sent.timeout(
              timeout,
              onTimeout: () {
                // Frees the connection, on a client that can.
                abortRequest();
                throw _noAnswer(timeout);
              },
            );
      // Saving, renewing and clearing the key all set the cookie, on
      // refusals too (an unreadable key is cleared with its 401).
      if (keyCookie != null) {
        final kept = keyCookieIn(response.headers['set-cookie']);
        if (kept != null) await _keepKeyCookie(kept);
      }
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return response;
      }
      throw _error(response.statusCode, await response.stream.bytesToString());
    } on http.ClientException catch (error) {
      throw _network(error);
    }
  }

  Future<String?> _read(TokenStore? store) async {
    try {
      return await store?.read();
    } on Object {
      // A keystore that can't be read (e.g. restored onto another device)
      // means signing in again, or saving the key again.
      return null;
    }
  }

  /// Keeps the key cookie's new value; empty clears it.
  Future<void> _keepKeyCookie(String value) async {
    final store = keyCookie;
    if (store == null) return;
    _keyCookieValue = Future.value(value.isEmpty ? null : value);
    try {
      if (value.isEmpty) {
        await store.clear();
      } else {
        await store.write(value);
      }
    } on Object {
      // Kept for this run only; the key is asked for again after a restart.
    }
  }

  Uri _url(List<String> path) => baseUri.replace(
    pathSegments: [
      ...baseUri.pathSegments.where((segment) => segment.isNotEmpty),
      'api',
      ...path,
    ],
  );

  /// Our routes answer `{"error":{"code","message","pool"?}}`; Better Auth
  /// (`/api/auth/*`) answers `{"code","message"}`.
  static ApiException _error(int status, String text) {
    Object? decoded;
    try {
      decoded = jsonDecode(text);
    } on FormatException {
      decoded = null;
    }
    final Json? error = switch (decoded) {
      {'error': final Json inner} => inner,
      final Json outer => outer,
      _ => null,
    };
    return ApiException(
      status: status,
      code: _stringAt(error, 'code') ?? 'http_$status',
      message: _stringAt(error, 'message') ?? 'HTTP $status',
      poolReason: switch (error?['pool']) {
        {'reason': final String reason} => reason,
        _ => null,
      },
    );
  }

  /// The `__Host-llmkey` cookie (`KEY_COOKIE_NAME` in apps/worker).
  static const keyCookieName = '__Host-llmkey';

  /// The key cookie's value in a response's `Set-Cookie` (several cookies
  /// arrive joined by commas): empty when the server cleared it, null when
  /// the response doesn't set it. The sealed value is base64url with a
  /// version prefix, so it holds no comma or semicolon.
  @visibleForTesting
  static String? keyCookieIn(String? setCookie) {
    if (setCookie == null) return null;
    final match = RegExp('(?:^|,)\\s*${RegExp.escape(keyCookieName)}=([^;,]*)')
        .firstMatch(setCookie);
    return match?.group(1);
  }

  static String? _stringAt(Json? json, String key) => switch (json?[key]) {
    final String value => value,
    _ => null,
  };
}
