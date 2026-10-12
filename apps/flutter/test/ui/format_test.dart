import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/api/models.dart';
import 'package:tangent/ui/format.dart';
import 'package:tangent/ui/lesson_outline.dart';

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

  test('tangent counts leave out the trunk', () {
    expect(tangentsLabel(1), '');
    expect(tangentsLabel(2), ' · 1 tangent');
    expect(tangentsLabel(3), ' · 2 tangents');
  });

  group('tangent titles', () {
    Branch titled(String title, String titleSource, {String? parent = 'm'}) =>
        Branch(
          id: 'b',
          treeId: 't',
          parentBranchId: parent,
          branchPointNodeId: parent == null ? null : 'n',
          title: title,
          titleSource: titleSource,
          model: null,
        );

    test('the placeholder prefix goes, as on Learn web', () {
      expect(
        tangentTitle(titled('Tangent: Why the moon', 'default')),
        'Why the moon',
      );
      expect(
        outlineTitle(titled('Tangent: Why the moon', 'default')),
        'Why the moon',
      );
    });

    test('a title the learner or tutor gave keeps the prefix', () {
      expect(
        tangentTitle(titled('Tangent: my own words', 'user')),
        'Tangent: my own words',
      );
      expect(tangentTitle(titled('Tangent: named', 'auto')), 'Tangent: named');
    });

    test('an untitled tangent and the trunk get their names', () {
      expect(outlineTitle(titled('', 'default')), 'Tangent');
      expect(
        outlineTitle(titled('Tangent: x', 'default', parent: null)),
        'Main thread',
      );
    });
  });

  test('money, as packages/shared formats it', () {
    expect(formatMicros(1234567), r'$1.23');
    expect(formatMicros(0), r'$0.00');
    expect(formatMicros(-400000), r'-$0.40');
    expect(formatMicros(-4000), r'$0.00');
    expect(formatMicros(1234567890000), r'$1,234,567.89');
  });
}
