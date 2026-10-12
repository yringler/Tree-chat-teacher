// The cases of packages/shared/src/tangents.spec.ts for the parts this app
// ports.

import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/api/tangents.dart';

const reply = '''Because water expands when it freezes.

Each molecule locks into a lattice held open by hydrogen bonds.

<tangents>
- Why ice is less dense than water — the lattice has more empty space than the liquid
- **Why lakes freeze from the top down**: the same fact, seen from a fish's point of view
* "Hydrogen bonds" – what they actually are
3. Bare title with no reason
</tangents>''';

void main() {
  group('splitTangents', () {
    test('leaves a reply without a block alone', () {
      final split = splitTangents('Just an answer.\n');
      expect(split.body, 'Just an answer.');
      expect(split.tangents, isEmpty);
      expect(split.partial, isFalse);
    });

    test('separates the block from the body and parses each line', () {
      final split = splitTangents(reply);
      expect(split.partial, isFalse);
      expect(
        split.body,
        'Because water expands when it freezes.\n\n'
        'Each molecule locks into a lattice held open by hydrogen bonds.',
      );
      expect(split.tangents, const [
        Tangent(
          title: 'Why ice is less dense than water',
          why: 'the lattice has more empty space than the liquid',
        ),
        Tangent(
          title: 'Why lakes freeze from the top down',
          why: "the same fact, seen from a fish's point of view",
        ),
        Tangent(title: 'Hydrogen bonds', why: 'what they actually are'),
        Tangent(title: 'Bare title with no reason', why: null),
      ]);
    });

    test('hides an unfinished block while the reply streams', () {
      final split = splitTangents('Answer so far.\n\n<tangents>\n- Half a li');
      expect(split.body, 'Answer so far.');
      expect(split.tangents, isEmpty);
      expect(split.partial, isTrue);
    });

    test('keeps text after the block, drops duplicates and caps the list', () {
      final lines = [for (var i = 0; i < 9; i++) '- T${i % 8} — r'].join('\n');
      final split = splitTangents(
        'A.\n<tangents>\n$lines\n</tangents>\nAfter.',
      );
      expect(split.body, 'A.\n\nAfter.');
      expect(split.tangents.map((t) => t.title), [
        'T0',
        'T1',
        'T2',
        'T3',
        'T4',
        'T5',
      ]);
    });

    test('is case-insensitive about the tag and tolerant of spaces', () {
      expect(splitTangents('<Tangents >\n- One — two\n</TANGENTS>').tangents, [
        const Tangent(title: 'One', why: 'two'),
      ]);
    });

    test('reads the block format the prompt asks for', () {
      final split = splitTangents(
        'Body.\n\n<tangents>\n- One — because\n- Two\n</tangents>',
      );
      expect(split.body, 'Body.');
      expect(split.partial, isFalse);
      expect(split.tangents, const [
        Tangent(title: 'One', why: 'because'),
        Tangent(title: 'Two', why: null),
      ]);
    });
  });

  group('parseTangentLine', () {
    test('returns null for blank or marker-only lines', () {
      expect(parseTangentLine(''), isNull);
      expect(parseTangentLine('- '), isNull);
      expect(parseTangentLine('   '), isNull);
    });

    test('does not split a hyphenated word', () {
      expect(
        parseTangentLine('- Self-organizing maps'),
        const Tangent(title: 'Self-organizing maps', why: null),
      );
    });

    test('splits on an unspaced em dash too', () {
      expect(parseTangentLine('- A—b'), const Tangent(title: 'A', why: 'b'));
    });
  });
}
