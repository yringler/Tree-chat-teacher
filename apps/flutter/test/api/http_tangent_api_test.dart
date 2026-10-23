import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:tangent/api/http_tangent_api.dart';
import 'package:tangent/api/models.dart';
import 'package:tangent/api/reply_stream.dart';
import 'package:tangent/api/token_store.dart';
import 'package:tangent/state/chat_controller.dart';
import 'package:tangent/state/lessons_controller.dart';
import 'package:tangent/state/reply_follower.dart';
import 'package:tangent/state/session_controller.dart';

import '../fakes.dart' show FakeTimers;

/// A request as the fake server saw it.
class Seen {
  Seen(this.method, this.url, this.headers, this.body);
  final String method;
  final Uri url;
  final Map<String, String> headers;
  final String body;

  Object? get json => jsonDecode(body);
}

typedef Reply = http.StreamedResponse Function(Seen request);

/// A [TokenStore] in memory that counts its reads.
class MemoryTokens implements TokenStore {
  MemoryTokens([this.token]);
  String? token;
  var reads = 0;

  @override
  Future<String?> read() async {
    reads++;
    return token;
  }

  @override
  Future<void> write(String token) async => this.token = token;

  @override
  Future<void> clear() async => token = null;
}

/// An API over a fake server that answers with [reply] and records every
/// request in [seen].
({HttpTangentApi api, List<Seen> seen}) fake(
  Reply reply, {
  String base = 'https://tangent.test',
  TokenStore? tokens,
  TokenStore? keyCookie,
  Duration idleTimeout = const Duration(minutes: 1),
  Duration headersTimeout = const Duration(minutes: 1),
}) {
  final seen = <Seen>[];
  final client = MockClient.streaming((request, body) async {
    final request0 = Seen(
      request.method,
      request.url,
      request.headers,
      utf8.decode(await body.toBytes()),
    );
    seen.add(request0);
    return reply(request0);
  });
  final api = HttpTangentApi(
    baseUri: Uri.parse(base),
    client: client,
    tokens: tokens,
    keyCookie: keyCookie,
    idleTimeout: idleTimeout,
    headersTimeout: headersTimeout,
  );
  return (api: api, seen: seen);
}

http.StreamedResponse json(Object? body, [int status = 200]) =>
    http.StreamedResponse(
      Stream.value(utf8.encode(jsonEncode(body))),
      status,
      headers: {'content-type': 'application/json'},
    );

http.StreamedResponse empty([int status = 204]) =>
    http.StreamedResponse(const Stream.empty(), status);

/// An SSE body of [events], ending cleanly or, with [fail], in a network
/// error: by default the [http.ClientException] package:http wraps an
/// `HttpException` in, else [failure].
http.StreamedResponse sse(
  List<Json> events, {
  bool fail = false,
  Exception? failure,
}) {
  final controller = StreamController<List<int>>();
  for (final event in events) {
    controller.add(
      utf8.encode('event: ${event['type']}\ndata: ${jsonEncode(event)}\n\n'),
    );
  }
  if (fail) {
    controller.addError(failure ?? http.ClientException('network reset'));
  }
  unawaited(controller.close());
  return http.StreamedResponse(
    controller.stream,
    200,
    headers: {'content-type': 'text/event-stream'},
  );
}

Json node(
  String id, {
  String role = 'assistant',
  String content = '',
  String status = 'streaming',
}) => {
  'id': id,
  'treeId': 't1',
  'branchId': 'b1',
  'parentId': null,
  'seq': 0,
  'role': role,
  'content': content,
  'status': status,
  'error': null,
  'errorKind': null,
  'providerId': 'p',
  'model': 'm',
  'usage': null,
  'sources': null,
  'createdAt': '2026-01-01T00:00:00.000Z',
};

const Json branch = {
  'id': 'b1',
  'treeId': 't1',
  'parentBranchId': null,
  'branchPointNodeId': null,
  'title': 'Trunk',
  'titleSource': 'auto',
  'model': 'm',
};

final Json start = {
  'type': 'start',
  'userNode': node('u1', role: 'user', content: 'hi', status: 'complete'),
  'assistantNode': node('a1'),
  'branch': branch,
  'funding': 'pool',
};

Json delta(String text) => {'type': 'delta', 'nodeId': 'a1', 'text': text};

final Json done = {
  'type': 'done',
  'node': node('a1', content: 'Hello', status: 'complete'),
  'branch': branch,
};

const Json treeDetail = {
  'tree': {'id': 't1', 'title': 'Ice', 'trunkBranchId': 'b1'},
  'branches': [branch],
  'nodes': <Json>[],
};

List<String> types(List<StreamEvent> events) => [
  for (final event in events)
    switch (event) {
      StartEvent() => 'start',
      SnapshotEvent() => 'snapshot',
      StatusEvent() => 'status',
      DeltaEvent() => 'delta',
      DoneEvent() => 'done',
      ErrorEvent() => 'error',
    },
];

Matcher apiError(int status, String code, {String? message, String? pool}) =>
    isA<ApiException>()
        .having((e) => e.status, 'status', status)
        .having((e) => e.code, 'code', code)
        .having((e) => e.message, 'message', message ?? anything)
        .having((e) => e.poolReason, 'poolReason', pool);

void main() {
  group('requests', () {
    test('send the mode, payer, own key and accept headers', () async {
      final f = fake((_) => json({'enabled': true, 'model': null}));
      await f.api.poolStatus();
      f.api
        ..payer = Payer.pool
        ..ownKey = LearnKey.anthropic;
      await f.api.poolStatus();
      final [first, second] = f.seen;
      expect(first.url.toString(), 'https://tangent.test/api/pool/status');
      expect(first.headers['x-tangent-mode'], 'simple');
      expect(first.headers['x-tangent-payment'], 'own-key');
      expect(first.headers['x-tangent-own-key'], 'openrouter');
      expect(second.headers['x-tangent-own-key'], 'anthropic');
      expect(first.headers['accept'], 'application/json, text/event-stream');
      expect(first.headers.containsKey('content-type'), isFalse);
      expect(second.headers['x-tangent-payment'], 'pool');
    });

    test('send JSON bodies with their content type', () async {
      final f = fake((_) => json(treeDetail, 201));
      final detail = await f.api.createTree(providerId: 'p2');
      expect(detail.tree.trunkBranchId, 'b1');
      final request = f.seen.single;
      expect(request.method, 'POST');
      expect(request.url.path, '/api/trees');
      expect(request.headers['content-type'], 'application/json');
      expect(request.json, {'providerId': 'p2'});
    });

    test('keep a base path and encode ids', () async {
      final f = fake((_) => json(treeDetail), base: 'https://h.test/x/');
      await f.api.tree('a/b c');
      expect(
        f.seen.single.url.toString(),
        'https://h.test/x/api/trees/a%2Fb%20c',
      );
    });

    test('magic link', () async {
      final f = fake((_) => json({'status': true}));
      await f.api.sendMagicLink(
        email: 'a@b.test',
        captchaToken: 'tok',
        callbackPath: '/app/',
        errorCallbackPath: '/app/login',
      );
      final request = f.seen.single;
      expect(request.url.path, '/api/auth/sign-in/magic-link');
      expect(request.headers['x-captcha-response'], 'tok');
      expect(request.json, {
        'email': 'a@b.test',
        'callbackURL': '/app/',
        'errorCallbackURL': '/app/login',
      });
    });

    test('session and sign-out', () async {
      final f = fake(
        (request) => switch (request.url.path) {
          '/api/auth/get-session' => json(null),
          _ => json({'success': true}),
        },
      );
      expect(await f.api.refreshSession(), isFalse);
      await f.api.signOut();
      expect(f.seen.last.method, 'POST');
      expect(f.seen.last.url.path, '/api/auth/sign-out');
      expect(f.seen.last.json, <String, Object?>{});

      final signedIn = fake(
        (_) => json({
          'session': {'id': 's'},
          'user': {'id': 'u'},
        }),
      );
      expect(await signedIn.api.refreshSession(), isTrue);
    });

    test('lessons', () async {
      final f = fake(
        (request) => switch ((request.method, request.url.path)) {
          ('GET', '/api/trees') => json([
            {
              'id': 't1',
              'title': 'Ice',
              'updatedAt': '2026-01-01T00:00:00.000Z',
            },
          ]),
          ('GET', '/api/providers') => json([
            {'id': 'p', 'defaultModel': 'm', 'models': <Json>[]},
          ]),
          ('POST', '/api/branches') => json({
            ...branch,
            'id': 'b2',
            'title': 'Tangent: Why',
            'titleSource': 'default',
          }),
          _ => empty(),
        },
      );
      expect((await f.api.trees()).single.title, 'Ice');
      expect((await f.api.providers()).single.id, 'p');
      await f.api.deleteTree('t1');
      expect(f.seen.last.method, 'DELETE');
      expect(f.seen.last.url.path, '/api/trees/t1');

      final created = await f.api.createBranch(fromNodeId: 'n1', title: 'Why');
      expect(created.id, 'b2');
      expect(created.titleSource, 'default');
      expect(f.seen.last.json, {
        'fromNodeId': 'n1',
        'contextMode': 'path',
        'anchorQuote': null,
        'title': 'Why',
      });

      await f.api.cancel('a1');
      expect(f.seen.last.method, 'POST');
      expect(f.seen.last.url.path, '/api/nodes/a1/cancel');
    });
  });

  group('a JSON read', () {
    test('whose response never comes is a lost connection in 30s', () {
      fakeAsync((async) {
        final api = HttpTangentApi(
          baseUri: Uri.parse('https://tangent.test'),
          client: MockClient.streaming(
            (_, _) => Completer<http.StreamedResponse>().future,
          ),
        );
        Object? error;
        unawaited(
          api.tree('t1').then<void>((_) {}, onError: (Object e) => error = e),
        );
        async.elapse(const Duration(seconds: 29));
        expect(error, isNull);
        async.elapse(const Duration(seconds: 1));
        expect(error, apiError(0, 'network'));
      });
    });

    test('whose body stalls is a lost connection 30s after its last byte', () {
      fakeAsync((async) {
        final stalled = StreamController<List<int>>();
        final f = fake((_) {
          stalled.add(utf8.encode('[{"id":'));
          return http.StreamedResponse(stalled.stream, 200);
        }, headersTimeout: const Duration(seconds: 30));
        Object? error;
        unawaited(
          f.api.trees().then<void>((_) {}, onError: (Object e) => error = e),
        );
        async.elapse(const Duration(seconds: 20));
        stalled.add(utf8.encode('"t1"'));
        async.elapse(const Duration(seconds: 29));
        expect(error, isNull);
        async.elapse(const Duration(seconds: 1));
        expect(error, apiError(0, 'network'));
      });
    });
  });

  group('settings', () {
    test('reads the walkthrough flag', () async {
      final f = fake(
        (_) => json({
          'systemPrompt': null,
          'defaultSystemPrompt': 'Be brief.',
          'walkthroughDoneAt': null,
          'learn': {'tier': 'max', 'replyLength': 'veryLong'},
        }),
      );
      final settings = await f.api.settings();
      expect(settings.walkthroughDoneAt, isNull);
      expect(
        settings.learn,
        const LearnReplySettings(
          tier: ModelTier.max,
          replyLength: ReplyLength.veryLong,
        ),
      );
      expect(f.seen.single.method, 'GET');
      expect(f.seen.single.url.path, '/api/settings');
    });

    test('marks the walkthrough done, and only that', () async {
      final f = fake(
        (_) => json({
          'systemPrompt': 'Mine',
          'defaultSystemPrompt': 'Be brief.',
          'walkthroughDoneAt': '2026-10-12T00:00:00.000Z',
          'learn': {'tier': 'normal', 'replyLength': 'normal'},
        }),
      );
      await f.api.markWalkthroughDone();
      expect(f.seen.single.method, 'PATCH');
      expect(f.seen.single.url.path, '/api/settings');
      expect(f.seen.single.json, {'walkthroughDone': true});
    });

    test(
      'saves only the Advanced setting it names, and reads back both',
      () async {
        final f = fake(
          (_) => json({
            'systemPrompt': null,
            'defaultSystemPrompt': 'Be brief.',
            'walkthroughDoneAt': null,
            'learn': {'tier': 'normal', 'replyLength': 'long'},
          }),
        );
        final saved = await f.api.updateLearnReply(
          replyLength: ReplyLength.long,
        );
        expect(f.seen.single.method, 'PATCH');
        expect(f.seen.single.url.path, '/api/settings');
        expect(f.seen.single.json, {
          'learn': {'replyLength': 'long'},
        });
        expect(saved, const LearnReplySettings(replyLength: ReplyLength.long));
      },
    );
  });

  group('own key', () {
    const sealed = 'v1.c2VhbGVk-_x';
    const setKey =
        '__Host-llmkey=$sealed; Max-Age=604800; Path=/; HttpOnly; Secure; '
        'SameSite=Strict';
    const clearKey =
        '__Host-llmkey=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 '
        '00:00:00 GMT; HttpOnly; Secure; SameSite=Strict';

    http.StreamedResponse setting(String cookie, [int status = 204]) =>
        http.StreamedResponse(
          const Stream.empty(),
          status,
          headers: {'set-cookie': cookie},
        );

    test('status, save and forget name the key', () async {
      final f = fake(
        (request) => request.url.path == '/api/key/status'
            ? json({
                'enabled': true,
                'hasKey': true,
                'providers': ['openai', 'openrouter'],
                'learnProviders': ['openrouter', 'anthropic', 'unknown'],
              })
            : empty(),
      );
      final status = await f.api.keyStatus();
      expect(status.enabled, isTrue);
      expect(status.has(LearnKey.openRouter), isTrue);
      expect(status.has(LearnKey.anthropic), isFalse);
      expect(status.learnProviders, [LearnKey.openRouter, LearnKey.anthropic]);
      await f.api.saveKey(LearnKey.anthropic, 'sk-ant-1');
      await f.api.forgetKey(LearnKey.openRouter);
      final [_, save, forget] = f.seen;
      expect((save.method, save.url.path), ('POST', '/api/key'));
      expect(save.json, {'provider': 'anthropic', 'apiKey': 'sk-ant-1'});
      expect((forget.method, forget.url.path), ('DELETE', '/api/key'));
      expect(forget.json, {'provider': 'openrouter'});
    });

    test('a status naming no Learn keys offers OpenRouter alone', () async {
      final f = fake(
        (request) =>
            json({'enabled': true, 'hasKey': false, 'providers': <String>[]}),
      );
      final status = await f.api.keyStatus();
      expect(status.learnProviders, [LearnKey.openRouter]);
    });

    test('a native build keeps the key cookie and sends it back', () async {
      final kept = MemoryTokens();
      final f = fake(
        (request) => request.url.path == '/api/key'
            ? setting(
                // Joined with the other cookies a response sets.
                'tangent-x=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT, $setKey',
              )
            : json({'enabled': true, 'model': null}),
        keyCookie: kept,
      );
      await f.api.poolStatus();
      expect(f.seen.last.headers.containsKey('cookie'), isFalse);
      await f.api.saveKey(LearnKey.openRouter, 'sk-or-1');
      expect(kept.token, sealed);
      await f.api.poolStatus();
      expect(f.seen.last.headers['cookie'], '__Host-llmkey=$sealed');
    });

    test('loads a kept key cookie before the first call', () async {
      final f = fake(
        (_) => json({'enabled': true, 'model': null}),
        keyCookie: MemoryTokens(sealed),
      );
      await f.api.poolStatus();
      expect(f.seen.single.headers['cookie'], '__Host-llmkey=$sealed');
    });

    test('is not sent to sign-in', () async {
      final f = fake(
        (_) => json({'success': true}),
        keyCookie: MemoryTokens(sealed),
      );
      await f.api.signInWithCode(email: 'a@b.test', code: '123456');
      expect(f.seen.single.headers.containsKey('cookie'), isFalse);
    });

    test('a cleared cookie is forgotten, on a refusal too', () async {
      final kept = MemoryTokens(sealed);
      final f = fake(
        (_) => http.StreamedResponse(
          Stream.value(
            utf8.encode(
              jsonEncode({
                'error': {'code': 'key_required', 'message': 'Enter it again'},
              }),
            ),
          ),
          401,
          headers: {'set-cookie': clearKey},
        ),
        keyCookie: kept,
      );
      await expectLater(f.api.poolStatus(), throwsA(isA<ApiException>()));
      expect(kept.token, isNull);
      await expectLater(f.api.poolStatus(), throwsA(isA<ApiException>()));
      expect(f.seen.last.headers.containsKey('cookie'), isFalse);
    });

    test('signing out forgets the key cookie', () async {
      final kept = MemoryTokens(sealed);
      final f = fake((_) => json({'success': true}), keyCookie: kept);
      await f.api.signOut();
      expect(kept.token, isNull);
    });

    test('the web build leaves the cookie to the browser', () async {
      final f = fake((_) => setting(setKey));
      await f.api.saveKey(LearnKey.openRouter, 'sk-or-1');
      await f.api.forgetKey(LearnKey.openRouter);
      expect(f.seen.last.headers.containsKey('cookie'), isFalse);
    });

    test('reads whether the membership the own key needs is missing', () {
      Me me(Object? membership) => Me.fromJson({
        'userId': 'u',
        'email': 'a@b.test',
        'devMode': false,
        'builtInCredit': true,
        'membership': membership,
      });
      expect(
        me({'required': true, 'status': 'inactive'}).membershipMissing,
        isTrue,
      );
      expect(
        me({'required': true, 'status': 'waived'}).membershipMissing,
        isFalse,
      );
      expect(
        me({'required': false, 'status': 'inactive'}).membershipMissing,
        isFalse,
      );
      expect(me(null).membershipMissing, isFalse);
    });

    test('reads the key cookie out of Set-Cookie', () {
      expect(HttpTangentApi.keyCookieIn(null), isNull);
      expect(HttpTangentApi.keyCookieIn('other=1; Path=/'), isNull);
      expect(HttpTangentApi.keyCookieIn(setKey), sealed);
      expect(HttpTangentApi.keyCookieIn(clearKey), '');
      expect(HttpTangentApi.keyCookieIn('x__Host-llmkey=nope'), isNull);
    });
  });

  group('sign-in by code', () {
    const meJson = {
      'userId': 'u1',
      'email': 'a@b.test',
      'devMode': false,
      'builtInCredit': false,
    };

    /// Answers the code sign-in with [token] in `set-auth-token`, and
    /// everything else as `/api/me`.
    Reply server({String? token = 'raw.signature'}) =>
        (request) => switch (request.url.path) {
          '/api/auth/sign-in/email-otp' => http.StreamedResponse(
            Stream.value(utf8.encode(jsonEncode({'token': 'raw'}))),
            200,
            headers: {
              'content-type': 'application/json',
              'set-auth-token': ?token,
            },
          ),
          _ => json(meJson),
        };

    test('posts the code, then sends the token it got on every call', () async {
      final tokens = MemoryTokens();
      final f = fake(server(), tokens: tokens);
      await f.api.signInWithCode(email: 'a@b.test', code: '042917');
      final signIn = f.seen.single;
      expect(signIn.method, 'POST');
      expect(signIn.url.path, '/api/auth/sign-in/email-otp');
      expect(signIn.json, {'email': 'a@b.test', 'otp': '042917'});
      expect(signIn.headers.containsKey('authorization'), isFalse);
      expect(tokens.token, 'raw.signature');

      await f.api.me();
      expect(f.seen.last.headers['authorization'], 'Bearer raw.signature');
    });

    test(
      'signs in with a Google ID token and the captcha, keeping the token',
      () async {
        final tokens = MemoryTokens();
        final f = fake(
          (request) => request.url.path == '/api/auth/sign-in/social'
              ? http.StreamedResponse(
                  Stream.value(utf8.encode(jsonEncode({'redirect': false}))),
                  200,
                  headers: {'set-auth-token': 'google.signature'},
                )
              : json(meJson),
          tokens: tokens,
        );
        await f.api.signInWithGoogle(idToken: 'id.token', captchaToken: 'pass');
        final signIn = f.seen.single;
        expect(signIn.method, 'POST');
        expect(signIn.url.path, '/api/auth/sign-in/social');
        expect(signIn.json, {
          'provider': 'google',
          'idToken': {'token': 'id.token'},
        });
        expect(signIn.headers['x-captcha-response'], 'pass');
        expect(tokens.token, 'google.signature');
      },
    );

    test(
      'a sign-in answered without a session token fails, not signed out',
      () async {
        final tokens = MemoryTokens();
        final f = fake(server(token: null), tokens: tokens);
        await expectLater(
          f.api.signInWithCode(email: 'a@b.test', code: '042917'),
          throwsA(apiError(200, 'no_session_token')),
        );
        expect(tokens.token, isNull);
      },
    );

    test('a browser sign-in with a provider answers with its page', () async {
      final f = fake(
        (_) => json({
          'url': 'https://accounts.google.com/o?x=1',
          'redirect': true,
        }),
      );
      final url = await f.api.socialSignInUrl(
        provider: 'github',
        callbackPath: '/app/',
        errorCallbackPath: '/app/login',
      );
      expect(url, Uri.parse('https://accounts.google.com/o?x=1'));
      expect(f.seen.single.url.path, '/api/auth/sign-in/social');
      expect(f.seen.single.json, {
        'provider': 'github',
        'callbackURL': '/app/',
        'errorCallbackURL': '/app/login',
      });
    });

    test('loads a kept token before the first call, once', () async {
      final tokens = MemoryTokens('kept.signature');
      final f = fake(server(), tokens: tokens);
      await f.api.me();
      await f.api.me();
      expect(f.seen.first.headers['authorization'], 'Bearer kept.signature');
      expect(tokens.reads, 1);
    });

    test(
      'signing out forgets the token, even when the request fails',
      () async {
        final tokens = MemoryTokens('kept.signature');
        final f = fake(
          (request) => request.url.path == '/api/auth/sign-out'
              ? json({'code': 'oops', 'message': 'down'}, 503)
              : json(meJson),
          tokens: tokens,
        );
        await expectLater(f.api.signOut(), throwsA(apiError(503, 'oops')));
        expect(f.seen.single.headers['authorization'], 'Bearer kept.signature');
        expect(tokens.token, isNull);
        await f.api.me();
        expect(f.seen.last.headers.containsKey('authorization'), isFalse);
      },
    );

    test(
      'deleting the account sends the typed email, then forgets the token',
      () async {
        final tokens = MemoryTokens('kept.signature');
        final f = fake(
          (request) =>
              request.url.path == '/api/account' ? empty() : json(meJson),
          tokens: tokens,
        );
        await f.api.deleteAccount('a@b.test');
        final delete = f.seen.single;
        expect(delete.method, 'DELETE');
        expect(delete.url.path, '/api/account');
        expect(delete.json, {'confirmEmail': 'a@b.test'});
        expect(delete.headers['authorization'], 'Bearer kept.signature');
        expect(tokens.token, isNull);
        await f.api.me();
        expect(f.seen.last.headers.containsKey('authorization'), isFalse);
      },
    );

    test(
      'a refused deletion keeps the token: the account is still there',
      () async {
        final tokens = MemoryTokens('kept.signature');
        final f = fake(
          (_) =>
              json({'code': 'validation', 'message': 'Type your email'}, 400),
          tokens: tokens,
        );
        await expectLater(
          f.api.deleteAccount('wrong@b.test'),
          throwsA(apiError(400, 'validation')),
        );
        expect(tokens.token, 'kept.signature');
      },
    );

    test(
      'on the web the session is the cookie: no token is kept or sent',
      () async {
        final f = fake(server());
        await f.api.signInWithCode(email: 'a@b.test', code: '042917');
        await f.api.me();
        expect(f.seen.last.headers.containsKey('authorization'), isFalse);
      },
    );

    test('a wrong code throws its code', () async {
      final tokens = MemoryTokens();
      final f = fake(
        (_) => json({'code': 'INVALID_OTP', 'message': 'Invalid OTP'}, 400),
        tokens: tokens,
      );
      await expectLater(
        f.api.signInWithCode(email: 'a@b.test', code: '000000'),
        throwsA(apiError(400, 'INVALID_OTP')),
      );
      expect(tokens.token, isNull);
    });
  });

  group('errors', () {
    test('our error body, with the pool reason', () async {
      final f = fake(
        (_) => json({
          'error': {
            'code': 'pool_empty',
            'message': 'The pool is empty.',
            'pool': {'reason': 'empty'},
          },
        }, 402),
      );
      await expectLater(
        f.api.billing(),
        throwsA(
          apiError(
            402,
            'pool_empty',
            message: 'The pool is empty.',
            pool: 'empty',
          ),
        ),
      );
    });

    test("Better Auth's error body", () async {
      final f = fake(
        (_) => json({'code': 'INVALID_EMAIL', 'message': 'Invalid email'}, 400),
      );
      await expectLater(
        f.api.sendMagicLink(
          email: 'x',
          captchaToken: 't',
          callbackPath: '/app/',
          errorCallbackPath: '/app/login',
        ),
        throwsA(apiError(400, 'INVALID_EMAIL', message: 'Invalid email')),
      );
    });

    test('a body that is not JSON', () async {
      final f = fake(
        (_) => http.StreamedResponse(
          Stream.value(utf8.encode('<html>Bad gateway</html>')),
          502,
        ),
      );
      await expectLater(f.api.me(), throwsA(apiError(502, 'http_502')));
    });

    test('signed out', () async {
      final f = fake(
        (_) => json({
          'error': {'code': 'unauthorized', 'message': 'Sign in'},
        }, 401),
      );
      await expectLater(f.api.me(), throwsA(apiError(401, 'unauthorized')));
    });

    test('a network failure', () async {
      final api = HttpTangentApi(
        baseUri: Uri.parse('https://tangent.test'),
        client: MockClient((_) => throw http.ClientException('offline')),
      );
      await expectLater(
        api.trees(),
        throwsA(apiError(0, 'network', message: 'offline')),
      );
    });
  });

  group('sendMessage', () {
    test('posts the message and streams the reply', () async {
      final f = fake((_) => sse([start, delta('Hel'), delta('lo'), done]));
      final events = await (await f.api.sendMessage('b1', 'hi')).toList();
      expect(types(events), ['start', 'delta', 'delta', 'done']);
      final request = f.seen.single;
      expect(request.method, 'POST');
      expect(request.url.path, '/api/branches/b1/messages');
      expect(request.json, {'content': 'hi'});
    });

    test('a refusal throws before any event', () async {
      final f = fake(
        (_) => json({
          'error': {
            'code': 'pool_cap_reached',
            'message': 'Daily limit reached.',
            'pool': {'reason': 'cap_requests'},
          },
        }, 429),
      );
      await expectLater(
        f.api.sendMessage('b1', 'hi'),
        throwsA(apiError(429, 'pool_cap_reached', pool: 'cap_requests')),
      );
      expect(f.seen, hasLength(1));
    });

    test(
      'a connection lost mid-body fails the body with a network error',
      () async {
        final f = fake((_) => sse([start, delta('Hel')], fail: true));
        final events = <StreamEvent>[];
        await expectLater(
          (await f.api.sendMessage('b1', 'hi')).forEach(events.add),
          throwsA(apiError(0, 'network', message: 'network reset')),
        );
        expect(types(events), ['start', 'delta']);
      },
    );
  });

  group('attachReply', () {
    test('gets the reply\'s stream with the usual headers', () async {
      final f = fake(
        (_) => sse([
          {'type': 'snapshot', 'node': node('a1', content: 'partial')},
          done,
        ]),
      );
      final events = await (await f.api.attachReply('a1')).toList();
      expect(types(events), ['snapshot', 'done']);
      expect(f.seen.single.method, 'GET');
      expect(f.seen.single.url.path, '/api/nodes/a1/stream');
      expect(f.seen.single.headers['x-tangent-mode'], 'simple');
    });

    test('a refusal throws', () async {
      final f = fake(
        (_) => json({
          'error': {'code': 'not_found', 'message': 'Gone'},
        }, 404),
      );
      await expectLater(
        f.api.attachReply('a1'),
        throwsA(apiError(404, 'not_found')),
      );
    });
  });

  group('a ReplyStream over the API', () {
    test('resumes a body that ends early, from its snapshot', () async {
      final f = fake(
        (request) => switch (request.url.path) {
          '/api/branches/b1/messages' => sse([start, delta('Hel')]),
          _ => sse([
            {'type': 'snapshot', 'node': node('a1', content: 'Hel')},
            delta('lo'),
            done,
          ]),
        },
      );
      final timers = FakeTimers();
      final events = <StreamEvent>[];
      final outcome = await ReplyStream.send(
        f.api,
        branchId: 'b1',
        content: 'hi',
        startTimer: timers.call,
      ).run(events.add);
      expect(outcome, isA<ReplyDone>());
      expect(types(events), ['start', 'delta', 'snapshot', 'delta', 'done']);
      expect(
        [for (final r in f.seen) r.url.path],
        ['/api/branches/b1/messages', '/api/nodes/a1/stream'],
      );
      expect(timers.durations, [const Duration(milliseconds: 500)]);
    });

    test('resumes after a network error mid-body', () async {
      var calls = 0;
      final f = fake((request) {
        calls++;
        return calls == 1
            ? sse([start, delta('Hel')], fail: true)
            : sse([done]);
      });
      final events = <StreamEvent>[];
      final outcome = await ReplyStream.send(
        f.api,
        branchId: 'b1',
        content: 'hi',
        startTimer: FakeTimers().call,
      ).run(events.add);
      expect(outcome, isA<ReplyDone>());
      expect(types(events), ['start', 'delta', 'done']);
    });

    test('reconnects after a socket reset mid-body', () async {
      // Mid-body, package:http passes a SocketException or TlsException
      // through as it is, not as a ClientException.
      var calls = 0;
      final f = fake((request) {
        calls++;
        return calls == 1
            ? sse(
                [start, delta('Hel')],
                fail: true,
                failure: const SocketException('Connection reset by peer'),
              )
            : sse([done]);
      });
      final events = <StreamEvent>[];
      final outcome = await ReplyStream.send(
        f.api,
        branchId: 'b1',
        content: 'hi',
        startTimer: FakeTimers().call,
      ).run(events.add);
      expect(outcome, isA<ReplyDone>());
      expect(types(events), ['start', 'delta', 'done']);
      expect(f.seen.last.url.path, '/api/nodes/a1/stream');
    });

    test('a frame of the wrong shape is not taken as the connection', () async {
      final controller = StreamController<List<int>>()
        ..add(utf8.encode('event: start\ndata: ${jsonEncode(start)}\n\n'))
        ..add(utf8.encode('data: {"type":"delta","nodeId":"a1"}\n\n'));
      unawaited(controller.close());
      final f = fake((_) => http.StreamedResponse(controller.stream, 200));
      final outcome = await ReplyStream.send(
        f.api,
        branchId: 'b1',
        content: 'hi',
        startTimer: FakeTimers().call,
      ).run((_) {});
      expect(
        outcome,
        isA<ReplyLost>().having((o) => o.error, 'error', isFormatException),
      );
      expect(f.seen, hasLength(1));
    });

    test('reconnects a body that goes quiet, as a dead one does', () async {
      // A phone's connection can die with no reset reaching it: the body
      // then neither ends nor sends anything, not even the keepalive.
      final stalled = StreamController<List<int>>();
      addTearDown(stalled.close);
      final f = fake(
        (request) => switch (request.url.path) {
          '/api/branches/b1/messages' => () {
            stalled.add(
              utf8.encode('event: start\ndata: ${jsonEncode(start)}\n\n'),
            );
            return http.StreamedResponse(stalled.stream, 200);
          }(),
          _ => sse([
            {'type': 'snapshot', 'node': node('a1')},
            done,
          ]),
        },
        idleTimeout: const Duration(milliseconds: 50),
      );
      final events = <StreamEvent>[];
      final outcome = await ReplyStream.send(
        f.api,
        branchId: 'b1',
        content: 'hi',
        startTimer: FakeTimers().call,
      ).run(events.add).timeout(const Duration(seconds: 5));
      expect(outcome, isA<ReplyDone>());
      expect(types(events), ['start', 'snapshot', 'done']);
      expect(f.seen.last.url.path, '/api/nodes/a1/stream');
    });

    test('a body kept alive by keepalive comments is not cut off', () {
      fakeAsync((async) {
        final body = StreamController<List<int>>();
        final f = fake(
          (_) => http.StreamedResponse(body.stream, 200),
          idleTimeout: const Duration(seconds: 45),
        );
        final events = <StreamEvent>[];
        ReplyOutcome? outcome;
        unawaited(
          ReplyStream.send(
            f.api,
            branchId: 'b1',
            content: 'hi',
            startTimer: FakeTimers().call,
          ).run(events.add).then((o) => outcome = o),
        );
        async.flushMicrotasks();
        body.add(utf8.encode('event: start\ndata: ${jsonEncode(start)}\n\n'));
        // Two minutes with nothing but the server's keepalive, every 15s.
        for (var i = 0; i < 8; i++) {
          async.elapse(const Duration(seconds: 15));
          body.add(utf8.encode(': keepalive\n\n'));
        }
        body.add(utf8.encode('event: done\ndata: ${jsonEncode(done)}\n\n'));
        unawaited(body.close());
        async.flushMicrotasks();
        expect(outcome, isA<ReplyDone>());
        expect(types(events), ['start', 'done']);
        expect(f.seen, hasLength(1));
      });
    });

    test('a reply stream cancelled while its send is unanswered aborts the '
        'request', () async {
      var aborted = false;
      final client = MockClient.streaming((request, _) async {
        final trigger = (request as http.Abortable).abortTrigger;
        await trigger;
        aborted = true;
        throw http.RequestAbortedException(request.url);
      });
      final api = HttpTangentApi(
        baseUri: Uri.parse('https://tangent.test'),
        client: client,
      );
      final stream = ReplyStream.send(api, branchId: 'b1', content: 'hi');
      final outcome = stream.run((_) {});
      await pumpEventQueue();
      stream.cancel();
      expect(await outcome, isA<ReplyCancelled>());
      await pumpEventQueue();
      expect(aborted, isTrue);
    });

    group('a response that never comes', () {
      /// An API whose first request's response never comes, and which then
      /// answers with [reply]; records the paths asked for.
      ({HttpTangentApi api, List<String> paths}) hanging(
        http.StreamedResponse Function() reply,
      ) {
        final paths = <String>[];
        final client = MockClient.streaming((request, _) {
          paths.add(request.url.path);
          return paths.length == 1
              ? Completer<http.StreamedResponse>().future
              : Future.value(reply());
        });
        final api = HttpTangentApi(
          baseUri: Uri.parse('https://tangent.test'),
          client: client,
          headersTimeout: const Duration(milliseconds: 50),
        );
        return (api: api, paths: paths);
      }

      test('to an attach, is tried again', () async {
        final f = hanging(
          () => sse([
            {'type': 'snapshot', 'node': node('a1')},
            done,
          ]),
        );
        final outcome = await ReplyStream.attach(
          f.api,
          'a1',
          startTimer: FakeTimers().call,
        ).run((_) {}).timeout(const Duration(seconds: 5));
        expect(outcome, isA<ReplyDone>());
        expect(f.paths, ['/api/nodes/a1/stream', '/api/nodes/a1/stream']);
      });

      test('to a send, loses it before a reply is named', () async {
        final f = hanging(() => sse([done]));
        final outcome = await ReplyStream.send(
          f.api,
          branchId: 'b1',
          content: 'hi',
          startTimer: FakeTimers().call,
        ).run((_) {}).timeout(const Duration(seconds: 5));
        expect(
          outcome,
          isA<ReplyLost>()
              .having((o) => o.replyId, 'replyId', isNull)
              .having((o) => o.error, 'error', apiError(0, 'network')),
        );
        expect(f.paths, ['/api/branches/b1/messages']);
      });
    });
  });

  group('a lesson over the API, when reading it again never answers', () {
    /// A lesson on a fake server whose first read of the lesson answers
    /// and every later one hangs, as on a link that died; [messages]
    /// answers a send, and every attach is refused with a 503.
    ChatController lesson(Future<http.StreamedResponse> Function() messages) {
      var reads = 0;
      final api = HttpTangentApi(
        baseUri: Uri.parse('https://tangent.test'),
        client: MockClient.streaming(
          (request, _) => switch (request.url.path) {
            '/api/trees/t1' when ++reads == 1 => Future.value(json(treeDetail)),
            '/api/trees/t1' => Completer<http.StreamedResponse>().future,
            '/api/branches/b1/messages' => messages(),
            _ => Future.value(empty(503)),
          },
        ),
      );
      final session = SessionController(api);
      return ChatController(
        api: api,
        session: session,
        lessons: LessonsController(api: api, session: session),
        treeId: 't1',
      );
    }

    test('marks a reply whose stream gave up failed in time', () {
      fakeAsync((async) {
        final chat = lesson(() async => sse([start]));
        unawaited(chat.load());
        async.flushMicrotasks();
        unawaited(chat.send('hi'));
        // The stream's four reconnects, refused, then the read of the
        // lesson, which hangs.
        async.elapse(const Duration(seconds: 10));
        expect(chat.streamingNode?.id, 'a1');

        async.elapse(const Duration(seconds: 30));
        expect(chat.streamingNode, isNull);
        expect(chat.thread.last.status, NodeStatus.error);
        expect(chat.thread.last.error, connectionLostText);
        chat.dispose();
      });
    });

    test('refuses a send lost before its reply started, in time', () {
      fakeAsync((async) {
        final chat = lesson(() => Completer<http.StreamedResponse>().future);
        unawaited(chat.load());
        async.flushMicrotasks();
        bool? accepted;
        unawaited(chat.send('hi').then((value) => accepted = value));
        // The send's 30s for an answer, then the read of the lesson.
        async.elapse(const Duration(seconds: 59));
        expect(chat.sending, isTrue);

        async.elapse(const Duration(seconds: 1));
        expect(accepted, isFalse);
        expect(chat.sending, isFalse);
        expect(chat.notice, isNotNull);
        chat.dispose();
      });
    });
  });
}
