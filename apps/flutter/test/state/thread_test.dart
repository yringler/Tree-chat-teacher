import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/api/models.dart';
import 'package:tangent/state/thread.dart';

import '../fakes.dart';

Map<String, Branch> byId(List<Branch> branches) => {
  for (final b in branches) b.id: b,
};

List<String> ids(List<ChatNode> nodes) => [for (final n in nodes) n.id];

void main() {
  final trunkNodes = [
    node('a2', branch: 'trunk', seq: 2),
    node('sys', branch: 'trunk', seq: 0, role: Role.system),
    node('a1', branch: 'trunk', seq: 1, role: Role.assistant),
    node('a3', branch: 'trunk', seq: 3, role: Role.assistant),
  ];

  test('the trunk is its own nodes by seq, without system nodes', () {
    final path = threadPath(
      branchId: 'trunk',
      branches: byId([branch('trunk')]),
      nodes: trunkNodes,
    );
    expect(ids(path), ['a1', 'a2', 'a3']);
  });

  test('a side branch is the parent up to its fork, then its own', () {
    final path = threadPath(
      branchId: 'side',
      branches: byId([
        branch('trunk'),
        branch('side', parent: 'trunk', fork: 'a1'),
      ]),
      nodes: [
        ...trunkNodes,
        node('s2', branch: 'side', seq: 1, role: Role.assistant),
        node('s1', branch: 'side', seq: 0),
      ],
    );
    expect(ids(path), ['a1', 's1', 's2']);
  });

  test('a nested branch follows every fork up to the trunk', () {
    final path = threadPath(
      branchId: 'deep',
      branches: byId([
        branch('trunk'),
        branch('side', parent: 'trunk', fork: 'a3'),
        branch('deep', parent: 'side', fork: 's1'),
      ]),
      nodes: [
        ...trunkNodes,
        node('s1', branch: 'side', seq: 0),
        node('s2', branch: 'side', seq: 1),
        node('d1', branch: 'deep', seq: 0),
      ],
    );
    expect(ids(path), ['a1', 'a2', 'a3', 's1', 'd1']);
  });

  test('an unknown fork keeps the whole parent thread', () {
    final path = threadPath(
      branchId: 'side',
      branches: byId([
        branch('trunk'),
        branch('side', parent: 'trunk', fork: 'gone'),
      ]),
      nodes: [
        ...trunkNodes,
        node('s1', branch: 'side', seq: 0),
      ],
    );
    expect(ids(path), ['a1', 'a2', 'a3', 's1']);
  });

  final tree = byId([
    branch('trunk'),
    branch('tides', parent: 'trunk', fork: 'a1'),
    branch('moon', parent: 'tides', fork: 's1'),
    branch('sun', parent: 'trunk', fork: 'a3'),
  ]);

  test('a branch’s path runs from the trunk down to it', () {
    expect(
      [for (final b in branchChain('moon', tree)) b.id],
      ['trunk', 'tides', 'moon'],
    );
    expect([for (final b in branchChain('trunk', tree)) b.id], ['trunk']);
  });

  test('the outline nests each side question under the one it came from', () {
    expect(
      [
        for (final e in branchOutline('trunk', tree))
          '${e.depth} ${e.branch.id}',
      ],
      ['0 trunk', '1 tides', '2 moon', '1 sun'],
    );
  });

  test('a cycle in malformed data ends the path and the outline', () {
    final looped = byId([
      branch('trunk'),
      branch('a', parent: 'b', fork: 'x'),
      branch('b', parent: 'a', fork: 'y'),
    ]);
    expect([for (final b in branchChain('a', looped)) b.id], ['b', 'a']);
    expect(
      [for (final e in branchOutline('trunk', looped)) e.branch.id],
      ['trunk'],
    );
  });

  group('deleteMessageQuestion', () {
    // The cases of the web's (packages/web-shared/src/core/delete-branch.spec.ts).
    // trunk: u1 a1 u2 a2; early from a1 (e1); side from a2 (s1 s2 s3);
    // deeper from s2 (d1).
    final branches = byId([
      branch('trunk'),
      branch('early', parent: 'trunk', fork: 'a1'),
      branch('side', parent: 'trunk', fork: 'a2', title: 'side'),
      branch('deeper', parent: 'side', fork: 's2', title: 'deeper'),
    ]);
    final nodes = [
      node('u1', branch: 'trunk', seq: 0),
      node('a1', branch: 'trunk', seq: 1, role: Role.assistant),
      node('u2', branch: 'trunk', seq: 2),
      node('a2', branch: 'trunk', seq: 3, role: Role.assistant),
      node('e1', branch: 'early', seq: 0),
      node('s1', branch: 'side', seq: 0),
      node('s2', branch: 'side', seq: 1, role: Role.assistant),
      node('s3', branch: 'side', seq: 2),
      node('d1', branch: 'deeper', seq: 0),
    ];
    String? ask(String id) => deleteMessageQuestion(
      nodes.firstWhere((n) => n.id == id),
      branches: branches,
      nodes: nodes,
      titleOf: (b) => b.title,
    );
    const tail =
        'Replies still being written there are stopped. This cannot be undone.';

    test('names the later messages and the tangents started from them', () {
      expect(
        ask('u2'),
        'Delete this message? Everything after it goes too: '
        '1 later message and 2 tangents (4 messages). $tail',
      );
      expect(
        ask('u1'),
        'Delete this message? Everything after it goes too: '
        '3 later messages and 3 tangents (5 messages). $tail',
      );
      expect(ask('s3'), 'Delete this message? $tail');
    });

    test('says that the first message of a tangent takes the tangent', () {
      expect(
        ask('s1'),
        'Delete this message? It starts the tangent “side”, which goes with '
        'it along with the 1 tangent below it (4 messages). $tail',
      );
      expect(
        ask('d1'),
        'Delete this message? It starts the tangent “deeper”, which goes with '
        'it (1 message). $tail',
      );
    });

    test('is null for a reply', () {
      expect(ask('a1'), isNull);
    });
  });
}
