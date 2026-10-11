import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:tangent/api/http_tangent_api.dart';
import 'package:tangent/api/models.dart';

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

/// An API over a fake server that answers with [reply] and records every
/// request in [seen]; reconnect delays are recorded in [delays], not waited.
({HttpTangentApi api, List<Seen> seen, List<Duration> delays}) fake(
  Reply reply, {
  String base = 'https://tangent.test',
}) {
  final seen = <Seen>[];
  final delays = <Duration>[];
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
    delay: (duration) async => delays.add(duration),
  );
  return (api: api, seen: seen, delays: delays);
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
/// error.
http.StreamedResponse sse(List<Json> events, {bool fail = false}) {
  final controller = StreamController<List<int>>();
  for (final event in events) {
    controller.add(
      utf8.encode('event: ${event['type']}\ndata: ${jsonEncode(event)}\n\n'),
    );
  }
  if (fail) controller.addError(http.ClientException('network reset'));
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
    test('send the mode, payer and accept headers', () async {
      final f = fake((_) => json({'enabled': true, 'model': null}));
      await f.api.poolStatus();
      f.api.payer = Payer.pool;
      await f.api.poolStatus();
      final [first, second] = f.seen;
      expect(first.url.toString(), 'https://tangent.test/api/pool/status');
      expect(first.headers['x-tangent-mode'], 'simple');
      expect(first.headers['x-tangent-payment'], 'own-key');
      expect(first.headers['accept'], 'application/json, text/event-stream');
      expect(first.headers.containsKey('content-type'), isFalse);
      expect(second.headers['x-tangent-payment'], 'pool');
    });

    test('send JSON bodies with their content type', () async {
      final f = fake((_) => json(treeDetail, 201));
      final detail = await f.api.createTree(model: 'm2');
      expect(detail.tree.trunkBranchId, 'b1');
      final request = f.seen.single;
      expect(request.method, 'POST');
      expect(request.url.path, '/api/trees');
      expect(request.headers['content-type'], 'application/json');
      expect(request.json, {'model': 'm2'});
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
            {
              'id': 'p',
              'defaultModel': 'm',
              'models': [
                {'id': 'm', 'tier': 'normal'},
                {'id': 'M', 'label': 'Big', 'tier': 'max'},
              ],
            },
          ]),
          ('POST', '/api/branches') ||
          ('PATCH', '/api/branches/b2') => json({...branch, 'id': 'b2'}),
          _ => empty(),
        },
      );
      expect((await f.api.trees()).single.title, 'Ice');
      expect((await f.api.providers()).single.modelFor(Tier.max)?.label, 'Big');
      await f.api.deleteTree('t1');
      expect(f.seen.last.method, 'DELETE');
      expect(f.seen.last.url.path, '/api/trees/t1');

      final created = await f.api.createBranch(fromNodeId: 'n1', title: 'Why');
      expect(created.id, 'b2');
      expect(f.seen.last.json, {
        'fromNodeId': 'n1',
        'contextMode': 'path',
        'anchorQuote': null,
        'title': 'Why',
      });
      await f.api.setBranchModel('b2', 'M');
      expect(f.seen.last.json, {'model': 'M'});

      await f.api.cancel('a1');
      expect(f.seen.last.method, 'POST');
      expect(f.seen.last.url.path, '/api/nodes/a1/cancel');
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
    test('streams a reply', () async {
      final f = fake((_) => sse([start, delta('Hel'), delta('lo'), done]));
      final events = await f.api.sendMessage('b1', 'hi').toList();
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
      final events = <StreamEvent>[];
      await expectLater(
        f.api.sendMessage('b1', 'hi').forEach(events.add),
        throwsA(apiError(429, 'pool_cap_reached', pool: 'cap_requests')),
      );
      expect(events, isEmpty);
      expect(f.seen, hasLength(1));
    });

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
      final events = await f.api.sendMessage('b1', 'hi').toList();
      expect(types(events), ['start', 'delta', 'snapshot', 'delta', 'done']);
      expect(f.seen.last.method, 'GET');
      expect(f.seen.last.url.path, '/api/nodes/a1/stream');
      expect(f.seen.last.headers['x-tangent-mode'], 'simple');
      expect(f.delays, [const Duration(milliseconds: 500)]);
    });

    test('resumes after a network error mid-body', () async {
      var calls = 0;
      final f = fake((request) {
        calls++;
        return calls == 1
            ? sse([start, delta('Hel')], fail: true)
            : sse([done]);
      });
      final events = await f.api.sendMessage('b1', 'hi').toList();
      expect(types(events), ['start', 'delta', 'done']);
    });

    test('backs off and gives up after four reconnects', () async {
      final f = fake(
        (request) => switch (request.url.path) {
          '/api/branches/b1/messages' => sse([start]),
          _ => json({
            'error': {'code': 'internal', 'message': 'Down'},
          }, 503),
        },
      );
      await expectLater(
        f.api.sendMessage('b1', 'hi').drain<void>(),
        throwsA(apiError(503, 'internal')),
      );
      expect(f.seen, hasLength(5));
      expect(f.delays.map((d) => d.inMilliseconds), [500, 1000, 2000, 4000]);
    });

    test('stops at a permanent error', () async {
      final f = fake(
        (request) => switch (request.url.path) {
          '/api/branches/b1/messages' => sse([start]),
          _ => json({
            'error': {'code': 'not_found', 'message': 'Gone'},
          }, 404),
        },
      );
      await expectLater(
        f.api.sendMessage('b1', 'hi').drain<void>(),
        throwsA(apiError(404, 'not_found')),
      );
      expect(f.seen, hasLength(2));
    });

    test('a body that ends before start is not resumed', () async {
      final f = fake((_) => sse([]));
      await expectLater(
        f.api.sendMessage('b1', 'hi').drain<void>(),
        throwsA(apiError(0, 'network')),
      );
      expect(f.seen, hasLength(1));
    });
  });

  group('resume', () {
    test('attaches at once, then streams to the end', () async {
      final f = fake(
        (_) => sse([
          {'type': 'snapshot', 'node': node('a1', content: 'partial')},
          {
            'type': 'error',
            'nodeId': 'a1',
            'message': 'Cancelled',
            'node': node('a1', content: 'partial', status: 'error'),
          },
        ]),
      );
      final events = await f.api.resume('a1').toList();
      expect(types(events), ['snapshot', 'error']);
      expect(f.seen.single.url.path, '/api/nodes/a1/stream');
      expect(f.delays, isEmpty);
    });
  });
}
