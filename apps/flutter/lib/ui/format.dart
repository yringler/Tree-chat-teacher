const _months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/// When a lesson was last used, as "just now", "5 min ago", "3 h ago",
/// "yesterday", "4 days ago", then the date.
String relativeDate(DateTime time, {DateTime? now}) {
  final local = time.toLocal();
  final current = (now ?? DateTime.now()).toLocal();
  final elapsed = current.difference(local);
  if (elapsed.inMinutes < 1) return 'just now';
  if (elapsed.inHours < 1) return '${elapsed.inMinutes} min ago';
  final today = DateTime.utc(current.year, current.month, current.day);
  final day = DateTime.utc(local.year, local.month, local.day);
  final days = today.difference(day).inDays;
  if (days == 0) return '${elapsed.inHours} h ago';
  if (days == 1) return 'yesterday';
  if (days < 7) return '$days days ago';
  final date = '${local.day} ${_months[local.month - 1]}';
  return local.year == current.year ? date : '$date ${local.year}';
}

/// "· 2 tangents" for a lesson with [branchCount] branches, the trunk among
/// them; empty for a lesson without tangents.
String tangentsLabel(int branchCount) {
  final count = branchCount - 1;
  if (count < 1) return '';
  return ' · $count ${count == 1 ? 'tangent' : 'tangents'}';
}

/// `1234567` → `$1.23`, rounded to the nearest cent, negative balances keep
/// their sign (`formatMicros` in packages/shared/src/money.ts).
String formatMicros(int micros) {
  final cents = (micros.abs() / 10000).round();
  final sign = micros < 0 && cents > 0 ? '-' : '';
  final whole = (cents ~/ 100).toString().replaceAllMapped(
    RegExp(r'\B(?=(\d{3})+(?!\d))'),
    (_) => ',',
  );
  return '$sign\$$whole.${(cents % 100).toString().padLeft(2, '0')}';
}

/// [text] cut to at most [max] characters, ending in `…` when cut. Counts
/// code points, so an emoji is never split in half, and drops the
/// whitespace the cut leaves before the ellipsis (`clip` in
/// packages/shared/src/text.ts).
String clip(String text, int max) {
  final chars = text.runes;
  if (chars.length <= max) return text;
  final kept = String.fromCharCodes(chars.take(max < 1 ? 0 : max - 1));
  return '${kept.trimRight()}…';
}

/// Markdown as single-line plain text: code-fence lines, heading, quote and
/// list markers, emphasis and inline-code characters go (a code block's
/// text stays); links and images become their text, autolinks their URL;
/// whitespace collapses. With [max], clipped ([clip]). The same text as
/// `plainText` in packages/shared/src/text.ts, so a reply is named the same
/// way on the web.
String plainText(String markdown, {int? max}) {
  String group1(Match m) => m[1] ?? '';
  final text = markdown
      .replaceAll(RegExp(r'^[ \t]*(```|~~~)[^\n]*$', multiLine: true), ' ')
      .replaceAllMapped(RegExp(r'!?\[([^\]]*)\]\([^)]*\)'), group1)
      .replaceAllMapped(RegExp(r'<((?:https?|mailto):[^>\s]*)>'), group1)
      .replaceAll(RegExp(r'^[ \t]*>[ \t]?', multiLine: true), '')
      .replaceAll(RegExp(r'^[ \t]{0,3}#{1,6}[ \t]+', multiLine: true), '')
      .replaceAll(
        RegExp(r'^[ \t]*(?:[-+*]|\d+[.)])[ \t]+', multiLine: true),
        '',
      )
      .replaceAll(RegExp(r'[*`]+|~~'), '')
      .replaceAllMapped(RegExp(r'(^|[^\p{L}\p{N}])_+', unicode: true), group1)
      .replaceAll(RegExp(r'_+(?=[^\p{L}\p{N}]|$)', unicode: true), '')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  return max == null ? text : clip(text, max);
}
