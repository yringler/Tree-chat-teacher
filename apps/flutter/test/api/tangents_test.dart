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

const _t = TangentKind.tangent;
const _c = TangentKind.continueOn;

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
          kind: _t,
        ),
        Tangent(
          title: 'Why lakes freeze from the top down',
          why: "the same fact, seen from a fish's point of view",
          kind: _t,
        ),
        Tangent(
          title: 'Hydrogen bonds',
          why: 'what they actually are',
          kind: _t,
        ),
        Tangent(title: 'Bare title with no reason', why: null, kind: _t),
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
        const Tangent(title: 'One', why: 'two', kind: _t),
      ]);
    });

    test('reads each line\'s kind tag', () {
      final split = splitTangents(
        [
          '<tangents>',
          '- [continue] Where the number comes from — the next step',
          '- [tangent] What a limit is — the idea the answer leans on',
          '- Untagged side trip — a model that dropped the tag',
          '- [tangent] Compound interest — where e first showed up',
          '</tangents>',
        ].join('\n'),
      );
      expect(split.tangents, const [
        Tangent(
          title: 'Where the number comes from',
          why: 'the next step',
          kind: _c,
        ),
        Tangent(
          title: 'What a limit is',
          why: 'the idea the answer leans on',
          kind: _t,
        ),
        Tangent(
          title: 'Untagged side trip',
          why: 'a model that dropped the tag',
          kind: _t,
        ),
        Tangent(
          title: 'Compound interest',
          why: 'where e first showed up',
          kind: _t,
        ),
      ]);
    });

    test('caps each kind on its own: 3 continue, 6 tangent', () {
      final lines = [
        for (var i = 0; i < 5; i++) '- [continue] C$i — r',
        for (var i = 0; i < 8; i++) '- [tangent] T$i — r',
      ].join('\n');
      final groups = groupTangents(
        splitTangents('<tangents>\n$lines\n</tangents>').tangents,
      );
      expect(groups.continueOn.map((t) => t.title), ['C0', 'C1', 'C2']);
      expect(groups.tangent.map((t) => t.title), [
        'T0',
        'T1',
        'T2',
        'T3',
        'T4',
        'T5',
      ]);
    });

    test('drops a title repeated under the other kind: the first wins', () {
      final split = splitTangents(
        '<tangents>\n- [tangent] Limits — a\n- [continue] limits — b\n'
        '- [continue] Series — c\n</tangents>',
      );
      expect(split.tangents, const [
        Tangent(title: 'Limits', why: 'a', kind: _t),
        Tangent(title: 'Series', why: 'c', kind: _c),
      ]);
    });

    test('hides an unfinished tagged block while the reply streams', () {
      final split = splitTangents('A.\n<tangents>\n- [continue] Next — wh');
      expect(split.body, 'A.');
      expect(split.tangents, isEmpty);
      expect(split.partial, isTrue);
    });

    test('reads the block format the prompt asks for', () {
      final split = splitTangents(
        'Body.\n\n<tangents>\n- [continue] One — because\n- [tangent] Two\n'
        '</tangents>',
      );
      expect(split.body, 'Body.');
      expect(split.partial, isFalse);
      expect(split.tangents, const [
        Tangent(title: 'One', why: 'because', kind: _c),
        Tangent(title: 'Two', why: null, kind: _t),
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
        const Tangent(title: 'Self-organizing maps', why: null, kind: _t),
      );
    });

    test('reads the [continue] and [tangent] tags', () {
      expect(
        parseTangentLine('- [continue] Next — why'),
        const Tangent(title: 'Next', why: 'why', kind: _c),
      );
      expect(
        parseTangentLine('- [tangent] Side — why'),
        const Tangent(title: 'Side', why: 'why', kind: _t),
      );
    });

    test('takes [next] and [reply] as continue, in any case', () {
      expect(parseTangentLine('- [next] A')?.kind, _c);
      expect(parseTangentLine('- [Reply] A')?.kind, _c);
      expect(parseTangentLine('- [CONTINUE] A')?.kind, _c);
      expect(
        parseTangentLine('- [Tangent] A'),
        const Tangent(title: 'A', why: null, kind: _t),
      );
    });

    test('finds a tag inside or outside bold', () {
      const expected = Tangent(
        title: 'Where e comes from',
        why: 'next',
        kind: _c,
      );
      expect(
        parseTangentLine('- **[continue] Where e comes from** — next'),
        expected,
      );
      expect(
        parseTangentLine('- [continue] **Where e comes from** — next'),
        expected,
      );
    });

    test('treats an untagged line as a tangent', () {
      expect(parseTangentLine('- Plain title — why')?.kind, _t);
    });

    test('returns null for a tag with no title', () {
      expect(parseTangentLine('- [continue]'), isNull);
      expect(parseTangentLine('- [tangent]   '), isNull);
    });

    test('splits on an unspaced em dash too', () {
      expect(
        parseTangentLine('- A—b'),
        const Tangent(title: 'A', why: 'b', kind: _t),
      );
    });
  });

  group('groupTangents', () {
    test('splits the list by kind, keeping the order', () {
      const a = Tangent(title: 'A', why: null, kind: _t);
      const b = Tangent(title: 'B', why: null, kind: _c);
      const c = Tangent(title: 'C', why: null, kind: _t);
      final groups = groupTangents(const [a, b, c]);
      expect(groups.continueOn, const [b]);
      expect(groups.tangent, const [a, c]);
    });
  });
}
