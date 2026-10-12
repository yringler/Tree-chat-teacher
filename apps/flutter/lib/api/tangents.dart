// Tangents: the "where next?" offers a reply ends with, in a block
//
//   <tangents>
//   - Title — why it's worth following
//   </tangents>
//
// This mirrors packages/shared/src/tangents.ts (splitTangents and
// parseTangentLine), which the server's prompt and the web apps use; the two
// must change together.

class Tangent {
  const Tangent({required this.title, required this.why});

  /// Short and specific; also the first message of the branch that follows it.
  final String title;

  /// Why it is worth following, or null when the line had no reason.
  final String? why;

  @override
  bool operator ==(Object other) =>
      other is Tangent && other.title == title && other.why == why;

  @override
  int get hashCode => Object.hash(title, why);

  @override
  String toString() => 'Tangent($title, $why)';
}

class SplitTangents {
  const SplitTangents({
    required this.body,
    required this.tangents,
    required this.partial,
  });

  /// The reply without its tangents block (trailing whitespace trimmed).
  final String body;
  final List<Tangent> tangents;

  /// A block is open but not yet closed: the reply is still streaming.
  final bool partial;
}

final _openRe = RegExp(r'<tangents\s*>', caseSensitive: false);
final _closeRe = RegExp(r'</tangents\s*>', caseSensitive: false);

/// List marker: "- ", "* ", "• ", "1. ", "1) ".
final _markerRe = RegExp(r'^\s*(?:[-*•]|\d+[.)])\s+');

/// Title / reason separator: a spaced em or en dash, a spaced hyphen, an
/// unspaced em dash, or a colon followed by a space.
final _separatorRe = RegExp(r'\s+[—–-]\s+|\s*—\s*|:\s+');
final _boldStars = RegExp(r'^\*\*(.+)\*\*$', dotAll: true);
final _boldUnderscores = RegExp(r'^__(.+)__$', dotAll: true);
final _quotes = RegExp('^["\'“”‘’«»]+|["\'“”‘’«»]+\$');
final _spaces = RegExp(r'\s+');
final _trailingPunctuation = RegExp(r'[.;,]+$');
final _newline = RegExp(r'\r?\n');
const _maxTangents = 6;
const _maxTitleChars = 200;

String _unwrap(String text) => text
    .trim()
    .replaceFirstMapped(_boldStars, (m) => m[1]!)
    .replaceFirstMapped(_boldUnderscores, (m) => m[1]!)
    .replaceAll(_quotes, '')
    .replaceAll(_spaces, ' ')
    .trim();

/// One line of the block as a tangent, or null for blank or marker-only lines.
Tangent? parseTangentLine(String line) {
  final text = line.replaceFirst(_markerRe, '').trim();
  if (text.isEmpty) return null;
  final sep = _separatorRe.firstMatch(text);
  final rawTitle = sep == null ? text : text.substring(0, sep.start);
  final rawWhy = sep == null ? '' : text.substring(sep.end);
  final title = _unwrap(rawTitle).replaceFirst(_trailingPunctuation, '');
  if (title.isEmpty) return null;
  final why = _unwrap(rawWhy);
  return Tangent(
    title: title.length > _maxTitleChars
        ? title.substring(0, _maxTitleChars)
        : title,
    why: why.isEmpty ? null : why,
  );
}

/// Separates a reply from its tangents block. A reply without one comes back
/// unchanged with no tangents. While the block is still open (streaming), the
/// body stops at the opening tag so the raw block never shows. Text after the
/// closing tag stays in the body.
SplitTangents splitTangents(String content) {
  final open = _openRe.firstMatch(content);
  if (open == null) {
    return SplitTangents(
      body: content.trimRight(),
      tangents: const [],
      partial: false,
    );
  }
  final before = content.substring(0, open.start);
  final rest = content.substring(open.end);
  final close = _closeRe.firstMatch(rest);
  if (close == null) {
    return SplitTangents(
      body: before.trimRight(),
      tangents: const [],
      partial: true,
    );
  }
  final inside = rest.substring(0, close.start);
  final after = rest.substring(close.end);
  final tangents = <Tangent>[];
  final seen = <String>{};
  for (final line in inside.split(_newline)) {
    final tangent = parseTangentLine(line);
    if (tangent == null) continue;
    if (!seen.add(tangent.title.toLowerCase())) continue;
    tangents.add(tangent);
    if (tangents.length >= _maxTangents) break;
  }
  final body = after.trim().isEmpty
      ? before.trimRight()
      : '${before.trimRight()}\n\n${after.trim()}';
  return SplitTangents(body: body, tangents: tangents, partial: false);
}
