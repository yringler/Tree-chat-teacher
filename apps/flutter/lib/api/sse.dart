// `text/event-stream` parsing for a reply's stream, matching
// packages/web-shared/src/sse/sse-parser.ts.

import 'dart:convert';

import 'models.dart';

/// One dispatched SSE frame.
class SseFrame {
  const SseFrame({required this.event, required this.data});

  /// The `event:` field, or `message` when absent.
  final String event;

  /// The `data:` lines joined with `\n`.
  final String data;
}

/// Incremental parser (the subset of the WHATWG SSE rules the Worker uses).
/// Feed decoded text with [push]; it returns the frames a blank line
/// completed. A trailing unterminated frame is dropped at the end, as the
/// spec requires.
class SseParser {
  String _buffer = '';
  String _eventName = '';
  final List<String> _dataLines = [];

  /// A chunk ended with `\r`: a `\n` starting the next one belongs to the
  /// same line break.
  bool _pendingCr = false;

  static final RegExp _lineBreak = RegExp(r'\r\n|\r|\n');

  List<SseFrame> push(String chunk) {
    var text = chunk;
    if (_pendingCr) {
      _pendingCr = false;
      if (text.startsWith('\n')) text = text.substring(1);
    }
    _buffer += text;
    final frames = <SseFrame>[];
    for (;;) {
      final match = _lineBreak.firstMatch(_buffer);
      if (match == null) break;
      final line = _buffer.substring(0, match.start);
      // A lone `\r` at the very end may be the first half of `\r\n`.
      final crAtEnd = match[0] == '\r' && match.start == _buffer.length - 1;
      _buffer = _buffer.substring(match.end);
      if (crAtEnd) _pendingCr = true;
      final frame = _processLine(line);
      if (frame != null) frames.add(frame);
    }
    return frames;
  }

  /// End of stream: drops any unterminated frame.
  void end() {
    _buffer = '';
    _eventName = '';
    _dataLines.clear();
    _pendingCr = false;
  }

  SseFrame? _processLine(String line) {
    if (line.isEmpty) return _dispatch();
    if (line.startsWith(':')) return null;
    final colon = line.indexOf(':');
    final field = colon == -1 ? line : line.substring(0, colon);
    var value = colon == -1 ? '' : line.substring(colon + 1);
    if (value.startsWith(' ')) value = value.substring(1);
    switch (field) {
      case 'event':
        _eventName = value;
      case 'data':
        _dataLines.add(value);
    }
    return null;
  }

  SseFrame? _dispatch() {
    if (_dataLines.isEmpty) {
      _eventName = '';
      return null;
    }
    final frame = SseFrame(
      event: _eventName.isEmpty ? 'message' : _eventName,
      data: _dataLines.join('\n'),
    );
    _eventName = '';
    _dataLines.clear();
    return frame;
  }
}

/// One frame as a [StreamEvent]. The JSON's own `type` decides, not the
/// `event:` field. Malformed JSON and unknown types (including `usage`,
/// which this app doesn't show) give null. A known type with the wrong
/// shape throws [FormatException]: the server is ours, so that is a bug.
StreamEvent? parseStreamEvent(SseFrame frame) {
  final Object? decoded;
  try {
    decoded = jsonDecode(frame.data);
  } on FormatException {
    return null;
  }
  if (decoded is! Json) return null;
  return switch (decoded['type']) {
    'start' => StartEvent(
      userNode: ChatNode.fromJson(decoded.obj('userNode')),
      assistantNode: ChatNode.fromJson(decoded.obj('assistantNode')),
      branch: Branch.fromJson(decoded.obj('branch')),
    ),
    'snapshot' => SnapshotEvent(ChatNode.fromJson(decoded.obj('node'))),
    'status' => StatusEvent(decoded.str('message')),
    'delta' => DeltaEvent(
      nodeId: decoded.str('nodeId'),
      text: decoded.str('text'),
    ),
    'done' => DoneEvent(
      node: ChatNode.fromJson(decoded.obj('node')),
      branch: Branch.fromJson(decoded.obj('branch')),
    ),
    'error' => ErrorEvent(
      nodeId: decoded.strOrNull('nodeId'),
      message: decoded.str('message'),
      node: switch (decoded.objOrNull('node')) {
        final node? => ChatNode.fromJson(node),
        null => null,
      },
    ),
    _ => null,
  };
}

/// A response body as [StreamEvent]s. UTF-8 is decoded across chunk
/// boundaries; frames [parseStreamEvent] rejects are skipped.
Stream<StreamEvent> readStreamEvents(Stream<List<int>> body) async* {
  final parser = SseParser();
  await for (final text in body.transform(
    const Utf8Decoder(allowMalformed: true),
  )) {
    for (final frame in parser.push(text)) {
      final event = parseStreamEvent(frame);
      if (event != null) yield event;
    }
  }
  parser.end();
}
