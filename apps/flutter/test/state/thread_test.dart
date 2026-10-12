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
}
