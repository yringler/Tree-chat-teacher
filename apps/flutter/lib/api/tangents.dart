// Suggested follow-ups: the offers a reply ends with, each either a next
// step in the thread's topic ("continue") or a side trip ("tangent"), in a
// block with a kind tag on each line
//
//   <tangents>
//   - [continue] Title — why it's the next step
//   - [tangent] Title — why it's worth following
//   </tangents>
//
// This mirrors packages/shared/src/tangents.ts (splitTangents,
// parseTangentLine and groupTangents), which the server's prompt and the web
// apps use; the two must change together.

/// What following a suggestion does. [continueOn] advances the thread's main
/// topic to its next step, so it is sent as a reply ("continue" is a Dart
/// keyword); [tangent] clarifies something in the reply or explores a side
/// topic, so it opens a tangent.
enum TangentKind { continueOn, tangent }

class Tangent {
  const Tangent({required this.title, required this.why, required this.kind});

  /// Short and specific; also the message sent when it is followed.
  final String title;

  /// Why it is worth following, or null when the line had no reason.
  final String? why;

  final TangentKind kind;

  @override
  bool operator ==(Object other) =>
      other is Tangent &&
      other.title == title &&
      other.why == why &&
      other.kind == kind;

  @override
  int get hashCode => Object.hash(title, why, kind);

  @override
  String toString() => 'Tangent(${kind.name}, $title, $why)';
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

/// Kind tag; [next] and [reply] are taken as continue because models
/// paraphrase the tag.
final _kindRe = RegExp(
  r'^\[(continue|next|reply|tangent)\]\s*',
  caseSensitive: false,
);
const _maxContinue = 3;
const _maxTangents = 6;
const _maxTitleChars = 200;

String _unwrap(String text) => text
    .trim()
    .replaceFirstMapped(_boldStars, (m) => m[1]!)
    .replaceFirstMapped(_boldUnderscores, (m) => m[1]!)
    .replaceAll(_quotes, '')
    .replaceAll(_spaces, ' ')
    .trim();

/// Strips a leading kind tag; null when there is none.
({TangentKind kind, String rest})? _takeKind(String text) {
  final m = _kindRe.firstMatch(text);
  if (m == null) return null;
  final tag = m[1]!.toLowerCase();
  return (
    kind: tag == 'tangent' ? TangentKind.tangent : TangentKind.continueOn,
    rest: text.substring(m.end),
  );
}

/// One line of the block as a suggestion, or null for blank or marker-only
/// lines. The tag may sit outside or inside bold (`[continue] **X**`,
/// `**[continue] X**`). A line without a tag is a tangent: operators'
/// LEARN_SYSTEM_PROMPT and POOL_SYSTEM_PROMPT, saved custom prompts and
/// power trees on the prompt they began with may not ask for tags, and
/// models sometimes drop them; a side trip is the safe reading of an unknown
/// offer.
Tangent? parseTangentLine(String line) {
  var text = line.replaceFirst(_markerRe, '').trim();
  final outer = _takeKind(text);
  if (outer != null) text = outer.rest.trim();
  if (text.isEmpty) return null;
  final sep = _separatorRe.firstMatch(text);
  final rawTitle = sep == null ? text : text.substring(0, sep.start);
  final rawWhy = sep == null ? '' : text.substring(sep.end);
  var title = _unwrap(rawTitle);
  final inner = outer == null ? _takeKind(title) : null;
  if (inner != null) title = _unwrap(inner.rest);
  title = title.replaceFirst(_trailingPunctuation, '');
  if (title.isEmpty) return null;
  final why = _unwrap(rawWhy);
  return Tangent(
    title: title.length > _maxTitleChars
        ? title.substring(0, _maxTitleChars)
        : title,
    why: why.isEmpty ? null : why,
    kind: outer?.kind ?? inner?.kind ?? TangentKind.tangent,
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
  // Keyed across both kinds: a title offered twice keeps its first kind.
  final seen = <String>{};
  final count = {TangentKind.continueOn: 0, TangentKind.tangent: 0};
  for (final line in inside.split(_newline)) {
    final tangent = parseTangentLine(line);
    if (tangent == null) continue;
    if (!seen.add(tangent.title.toLowerCase())) continue;
    final cap = tangent.kind == TangentKind.continueOn
        ? _maxContinue
        : _maxTangents;
    if (count[tangent.kind]! >= cap) continue;
    count[tangent.kind] = count[tangent.kind]! + 1;
    tangents.add(tangent);
  }
  final body = after.trim().isEmpty
      ? before.trimRight()
      : '${before.trimRight()}\n\n${after.trim()}';
  return SplitTangents(body: body, tangents: tangents, partial: false);
}

/// The suggestions split by kind, each group in its original order.
({List<Tangent> continueOn, List<Tangent> tangent}) groupTangents(
  List<Tangent> tangents,
) => (
  continueOn: [
    for (final t in tangents)
      if (t.kind == TangentKind.continueOn) t,
  ],
  tangent: [
    for (final t in tangents)
      if (t.kind == TangentKind.tangent) t,
  ],
);
