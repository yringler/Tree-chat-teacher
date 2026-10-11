import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/api/models.dart';
import 'package:tangent/api/sse.dart';

List<(String, String)> feed(List<String> chunks) {
  final parser = SseParser();
  final frames = [for (final chunk in chunks) ...parser.push(chunk)];
  parser.end();
  return [for (final frame in frames) (frame.event, frame.data)];
}

Json node(String id, {String content = '', String status = 'streaming'}) => {
  'id': id,
  'treeId': 't1',
  'branchId': 'b1',
  'parentId': null,
  'seq': 1,
  'role': 'assistant',
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

String frame(Json event) =>
    'event: ${event['type']}\ndata: ${jsonEncode(event)}\n\n';

/// [text] as UTF-8 bytes in chunks of [size].
Stream<List<int>> chunked(String text, int size) {
  final bytes = utf8.encode(text);
  return Stream.fromIterable([
    for (var i = 0; i < bytes.length; i += size)
      bytes.sublist(i, i + size > bytes.length ? bytes.length : i + size),
  ]);
}

void main() {
  group('SseParser', () {
    test('parses a frame', () {
      expect(feed(['event: delta\ndata: {"a":1}\n\n']), [('delta', '{"a":1}')]);
    });

    test('handles frames split at any point', () {
      const text = 'event: a\ndata: one\n\nevent: b\ndata: two\n\n';
      for (var i = 1; i < text.length; i++) {
        expect(feed([text.substring(0, i), text.substring(i)]), [
          ('a', 'one'),
          ('b', 'two'),
        ], reason: 'split at $i');
      }
    });

    test('supports CRLF and CR, including CRLF split across chunks', () {
      expect(feed(['data: x\r\n\r\n', 'data: y\r\r']), [
        ('message', 'x'),
        ('message', 'y'),
      ]);
      expect(feed(['data: x\r', '\n\r', '\n']), [('message', 'x')]);
    });

    test('joins data lines and skips comments and unknown fields', () {
      expect(
        feed([': keepalive\n', 'retry: 10\nfoo: bar\ndata: a\ndata:b\n\n']),
        [('message', 'a\nb')],
      );
    });

    test('skips frames without data and drops an unterminated one', () {
      expect(feed(['event: ping\n\n', 'data: complete\n\n', 'data: part']), [
        ('message', 'complete'),
      ]);
    });
  });

  group('parseStreamEvent', () {
    test('lets the JSON type win over the event line', () {
      final event = parseStreamEvent(
        const SseFrame(
          event: 'status',
          data: '{"type":"delta","nodeId":"n1","text":"hi"}',
        ),
      );
      expect(event, isA<DeltaEvent>().having((e) => e.text, 'text', 'hi'));
    });

    test('rejects malformed, unknown and usage payloads', () {
      for (final data in [
        '{not json',
        '{"type":"nope"}',
        '42',
        'null',
        '{"type":"usage","nodeId":"a","usage":{"outputTokens":3}}',
      ]) {
        expect(
          parseStreamEvent(SseFrame(event: 'x', data: data)),
          isNull,
          reason: data,
        );
      }
    });

    test('reads every event shape', () {
      final branch = {'id': 'b1', 'treeId': 't1', 'title': 'Trunk'};
      final parsed = [
        for (final json in <Json>[
          {
            'type': 'start',
            'userNode': {...node('u1'), 'role': 'user', 'status': 'complete'},
            'assistantNode': node('a1'),
            'branch': branch,
            'funding': 'pool',
          },
          {'type': 'snapshot', 'node': node('a1', content: 'He')},
          {'type': 'status', 'message': 'Searching…'},
          {
            'type': 'done',
            'node': node('a1', content: 'Hello', status: 'complete'),
            'branch': branch,
          },
          {
            'type': 'error',
            'nodeId': null,
            'message': 'Cancelled',
            'node': null,
          },
        ])
          parseStreamEvent(SseFrame(event: 'message', data: jsonEncode(json))),
      ];
      expect(parsed[0], isA<StartEvent>());
      final start = parsed[0]! as StartEvent;
      expect(start.userNode.role, Role.user);
      expect(start.assistantNode.id, 'a1');
      expect(start.branch.title, 'Trunk');
      expect((parsed[1]! as SnapshotEvent).node.content, 'He');
      expect((parsed[2]! as StatusEvent).message, 'Searching…');
      expect((parsed[3]! as DoneEvent).node.status, NodeStatus.complete);
      final error = parsed[4]! as ErrorEvent;
      expect(error.nodeId, isNull);
      expect(error.node, isNull);
      expect(error.message, 'Cancelled');
    });
  });

  group('readStreamEvents', () {
    test('decodes bytes split mid-character and mid-line', () async {
      final text = [
        frame({'type': 'status', 'message': 'summarizing…'}),
        ': keepalive\n\n',
        frame({'type': 'delta', 'nodeId': 'a', 'text': 'héllo 🌳'}),
        frame({'type': 'delta', 'nodeId': 'a', 'text': ' ünd'}),
      ].join();
      for (final size in [1, 2, 3, 5, 7]) {
        final events = await readStreamEvents(chunked(text, size)).toList();
        expect(
          [
            for (final event in events)
              switch (event) {
                StatusEvent(:final message) => message,
                DeltaEvent(:final text) => text,
                _ => '?',
              },
          ],
          ['summarizing…', 'héllo 🌳', ' ünd'],
          reason: 'chunks of $size',
        );
      }
    });

    test('reads CRLF frames', () async {
      final text = frame({'type': 'delta', 'nodeId': 'a', 'text': 'x'})
          .replaceAll('\n', '\r\n');
      final events = await readStreamEvents(chunked(text, 4)).toList();
      expect(events.single, isA<DeltaEvent>());
    });

    test('skips a malformed frame and keeps going', () async {
      final text =
          'data: nope\n\n'
          'event: delta\ndata: {"type":"delta",\n\n'
          '${frame({'type': 'status', 'message': 'ok'})}';
      final events = await readStreamEvents(chunked(text, 8)).toList();
      expect(events.single, isA<StatusEvent>());
    });
  });
}
