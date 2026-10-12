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

  test('a branch without a model runs on its nearest ancestor’s', () {
    final branches = byId([
      branch('trunk', model: 'max-model'),
      branch('side', parent: 'trunk', fork: 'a1'),
    ]);
    expect(effectiveModel('side', branches), 'max-model');
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
}
