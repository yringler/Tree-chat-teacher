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

/// "· 2 side questions" for a lesson with [branchCount] branches, the trunk
/// among them; empty for a lesson without side questions.
String sideQuestionsLabel(int branchCount) {
  final count = branchCount - 1;
  if (count < 1) return '';
  return ' · $count ${count == 1 ? 'side question' : 'side questions'}';
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
