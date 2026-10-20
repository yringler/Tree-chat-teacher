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

  // The cases of packages/shared/src/text.spec.ts.
  group('clip', () {
    test('keeps text within the limit and cuts longer text to the limit, '
        'ellipsis included', () {
      expect(clip('short', 5), 'short');
      expect(clip('a longer text', 8), 'a longe…');
      expect(clip('x' * 50, 10).runes, hasLength(10));
    });

    test('never splits a surrogate pair, and counts one as one character', () {
      expect(clip('ab😀cd', 4), 'ab😀…');
      expect(clip('😀😀😀', 3), '😀😀😀');
      expect(clip('😀😀😀😀', 3), '😀😀…');
    });

    test('drops the space the cut leaves before the ellipsis', () {
      expect(clip('word word word', 6), 'word…');
    });
  });

  group('plainText', () {
    test('drops Markdown markup, keeps a code block’s text and collapses '
        'whitespace', () {
      expect(
        plainText(
          "Good question! Let's start with **a confident kitten**.\n\n"
          '## Habits\n\n'
          '- **Listening**: an `owl` hums\n'
          '1. _second_ item\n'
          '> quoted [link](https://x.test) ![alt](i.png) <https://a.test/b>\n'
          '> ## Quoted heading\n\n'
          '```js\ncode();\n```\n'
          '~~gone~~ about ~5 end',
        ),
        "Good question! Let's start with a confident kitten. Habits "
        'Listening: an owl hums second item quoted link alt https://a.test/b '
        'Quoted heading code(); gone about ~5 end',
      );
    });

    test('keeps underscores inside identifiers', () {
      expect(
        plainText('use snake_case names, _not_ emphasis'),
        'use snake_case names, not emphasis',
      );
    });

    test('clips to `max` with an ellipsis', () {
      expect(plainText('**word** ' * 50, max: 11), 'word word…');
      expect(plainText('short', max: 12), 'short');
    });
  });
}
