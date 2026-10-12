import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/ui/format.dart';

void main() {
  final now = DateTime(2026, 10, 11, 15);

  test('relative dates', () {
    String at(DateTime time) => relativeDate(time, now: now);
    expect(at(now.subtract(const Duration(seconds: 20))), 'just now');
    expect(at(now.subtract(const Duration(minutes: 5))), '5 min ago');
    expect(at(now.subtract(const Duration(hours: 3))), '3 h ago');
    expect(at(DateTime(2026, 10, 10, 23)), 'yesterday');
    expect(at(DateTime(2026, 10, 7, 9)), '4 days ago');
    expect(at(DateTime(2026, 3, 2)), '2 Mar');
    expect(at(DateTime(2025, 3, 2)), '2 Mar 2025');
  });

  test('side question counts leave out the trunk', () {
    expect(sideQuestionsLabel(1), '');
    expect(sideQuestionsLabel(2), ' · 1 side question');
    expect(sideQuestionsLabel(3), ' · 2 side questions');
  });

  test('money, as packages/shared formats it', () {
    expect(formatMicros(1234567), r'$1.23');
    expect(formatMicros(0), r'$0.00');
    expect(formatMicros(-400000), r'-$0.40');
    expect(formatMicros(-4000), r'$0.00');
    expect(formatMicros(1234567890000), r'$1,234,567.89');
  });
}
