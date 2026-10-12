import 'dart:convert';

import 'package:http/http.dart' as http;

import 'models.dart';
import 'sse.dart';
import 'tangent_api.dart';
import 'token_store.dart';

/// [TangentApi] over `package:http`. On the web, `http.Client()` is a
/// fetch-based client that streams response bodies and sends the session
/// cookie on same-origin requests. A native build has no cookies: it signs
/// in by code and keeps the session token in [tokens], sending it as
/// `Authorization: Bearer`.
class HttpTangentApi implements TangentApi {
  HttpTangentApi({
    required this.baseUri,
    http.Client? client,
    this.tokens,
    Future<void> Function(Duration)? delay,
  }) : _client = client ?? http.Client(),
       _delay = delay ?? Future<void>.delayed;

  /// The Worker's origin; every call goes to `/api` under it.
  final Uri baseUri;
  final http.Client _client;

  /// Where the session token is kept; null on the web.
  final TokenStore? tokens;

  /// The token, read from [tokens] before the first call.
  Future<String?>? _token;

  /// Waits between reconnects; tests pass one that doesn't.
  final Future<void> Function(Duration) _delay;

  /// The server's own default when the header is absent; the app sets it
  /// once it knows who pays.
  @override
  Payer payer = Payer.ownKey;

  /// Reconnects of a reply's stream before giving up, with the delay
  /// doubling from [_baseDelay] (stream-runner.ts in web-shared).
  static const _maxReconnects = 4;
  static const _baseDelay = Duration(milliseconds: 500);

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
    await response.stream.drain<void>();
    // The signed session token (Better Auth's bearer plugin), for a client
    // that keeps it itself.
    final token = response.headers['set-auth-token'];
    final store = tokens;
    if (store == null || token == null || token.isEmpty) return;
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
      // Signed out on this device either way.
      _token = Future.value(null);
      await tokens?.clear();
    }
  }

  @override
  Future<void> deleteAccount(String confirmEmail) async {
    await _send('DELETE', ['account'], body: {'confirmEmail': confirmEmail});
    // The session went with the account. A refusal throws above and keeps
    // the token: the account is still there.
    _token = Future.value(null);
    await tokens?.clear();
  }

  @override
  Future<Settings> settings() async =>
      Settings.fromJson(await _object('GET', ['settings']));

  @override
  Future<void> markWalkthroughDone() async {
    await _send('PATCH', ['settings'], body: {'walkthroughDone': true});
  }

  // Paying for replies.

  @override
  Future<PoolStatus> poolStatus() async =>
      PoolStatus.fromJson(await _object('GET', ['pool', 'status']));

  @override
  Future<BillingSummary> billing() async =>
      BillingSummary.fromJson(await _object('GET', ['billing']));

  // Lessons.

  @override
  Future<List<ProviderInfo>> providers() async =>
      (await _list('GET', ['providers'])).map(ProviderInfo.fromJson).toList();

  @override
  Future<List<TreeSummary>> trees() async =>
      (await _list('GET', ['trees'])).map(TreeSummary.fromJson).toList();

  @override
  Future<TreeDetail> createTree({String? providerId, String? model}) async =>
      TreeDetail.fromJson(
        await _object(
          'POST',
          ['trees'],
          body: {'providerId': ?providerId, 'model': ?model},
        ),
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

  @override
  Future<Branch> setBranchModel(String branchId, String model) async =>
      Branch.fromJson(
        await _object('PATCH', ['branches', branchId], body: {'model': model}),
      );

  // Replies.

  @override
  Stream<StreamEvent> sendMessage(String branchId, String content) => _stream(
    open: () => _send(
      'POST',
      ['branches', branchId, 'messages'],
      body: {'content': content},
    ),
  );

  @override
  Stream<StreamEvent> resume(String nodeId) => _stream(nodeId: nodeId);

  @override
  Future<void> cancel(String nodeId) async {
    await _send('POST', ['nodes', nodeId, 'cancel']);
  }

  /// One reply's events, reconnecting through `GET /api/nodes/:id/stream`
  /// when a body ends or fails before `done` or `error`. Without [open] it
  /// starts by reconnecting to [nodeId]. A refusal of [open] throws before
  /// any event; reconnects stop at a 4xx other than 408 and 429, and after
  /// [_maxReconnects] in a row without an event.
  Stream<StreamEvent> _stream({
    Future<http.StreamedResponse> Function()? open,
    String? nodeId,
  }) async* {
    var pendingOpen = open;
    var target = nodeId;
    var attempt = 0;
    ApiException lastError = _connectionLost;
    for (;;) {
      final http.StreamedResponse response;
      if (pendingOpen != null) {
        response = await pendingOpen();
        pendingOpen = null;
      } else {
        final id = target;
        if (id == null) {
          throw ApiException(
            status: 0,
            code: 'network',
            message: 'The reply ended before it started (${lastError.message})',
          );
        }
        if (attempt >= _maxReconnects) throw lastError;
        final wait = open != null || attempt > 0
            ? _baseDelay * (1 << attempt)
            : Duration.zero;
        attempt++;
        if (wait > Duration.zero) await _delay(wait);
        try {
          response = await _send('GET', ['nodes', id, 'stream']);
        } on ApiException catch (error) {
          if (_isPermanent(error)) rethrow;
          lastError = error;
          continue;
        }
      }
      try {
        await for (final event in readStreamEvents(response.stream)) {
          switch (event) {
            case StartEvent(:final assistantNode):
              target = assistantNode.id;
            case SnapshotEvent(:final node):
              target = node.id;
            default:
          }
          attempt = 0;
          yield event;
          if (isTerminal(event)) return;
        }
        lastError = _connectionLost;
      } on http.ClientException catch (error) {
        lastError = _network(error);
      }
    }
  }

  static const _connectionLost = ApiException(
    status: 0,
    code: 'network',
    message: 'Connection lost',
  );

  static bool _isPermanent(ApiException error) =>
      error.status >= 400 &&
      error.status < 500 &&
      error.status != 408 &&
      error.status != 429;

  static ApiException _network(http.ClientException error) =>
      ApiException(status: 0, code: 'network', message: error.message);

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

  Future<Object?> _json(String method, List<String> path, {Json? body}) async {
    final response = await _send(method, path, body: body);
    try {
      return jsonDecode(await response.stream.bytesToString());
    } on http.ClientException catch (error) {
      throw _network(error);
    }
  }

  /// Sends a request under `/api` and returns a 2xx response with its body
  /// unread; anything else throws [ApiException].
  Future<http.StreamedResponse> _send(
    String method,
    List<String> path, {
    Json? body,
    Map<String, String> headers = const {},
  }) async {
    final token = await (_token ??= _readToken());
    final request = http.Request(method, _url(path))
      ..headers.addAll({
        'x-tangent-mode': 'simple',
        'x-tangent-payment': payer.header,
        'accept': 'application/json, text/event-stream',
        if (body != null) 'content-type': 'application/json',
        if (token != null) 'authorization': 'Bearer $token',
        ...headers,
      });
    // Bytes, not `body`, so package:http leaves the content type as set.
    if (body != null) request.bodyBytes = utf8.encode(jsonEncode(body));
    try {
      final response = await _client.send(request);
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return response;
      }
      throw _error(response.statusCode, await response.stream.bytesToString());
    } on http.ClientException catch (error) {
      throw _network(error);
    }
  }

  Future<String?> _readToken() async {
    try {
      return await tokens?.read();
    } on Object {
      // A keystore that can't be read (e.g. restored onto another device)
      // means signing in again.
      return null;
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

  static String? _stringAt(Json? json, String key) => switch (json?[key]) {
    final String value => value,
    _ => null,
  };
}
