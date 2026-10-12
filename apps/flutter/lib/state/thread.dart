import '../api/models.dart';

/// The messages a branch shows, oldest first: for a side branch, its parent's
/// thread up to and including the node it forks from, then its own nodes;
/// for the trunk, its own nodes. System nodes are never shown.
List<ChatNode> threadPath({
  required String branchId,
  required Map<String, Branch> branches,
  required Iterable<ChatNode> nodes,
}) {
  final byBranch = <String, List<ChatNode>>{};
  for (final node in nodes) {
    (byBranch[node.branchId] ??= []).add(node);
  }
  final path = _path(branchId, branches, byBranch, <String>{});
  return [
    for (final node in path)
      if (node.role != Role.system) node,
  ];
}

List<ChatNode> _path(
  String branchId,
  Map<String, Branch> branches,
  Map<String, List<ChatNode>> byBranch,
  Set<String> seen,
) {
  final own = [...?byBranch[branchId]]..sort((a, b) => a.seq.compareTo(b.seq));
  final branch = branches[branchId];
  final parentId = branch?.parentBranchId;
  // `seen` guards against a cycle in malformed data.
  if (parentId == null || !seen.add(branchId)) return own;
  final parent = _path(parentId, branches, byBranch, seen);
  final fork = parent.indexWhere((n) => n.id == branch?.branchPointNodeId);
  return [...(fork < 0 ? parent : parent.sublist(0, fork + 1)), ...own];
}

/// The model a branch runs on: its own, else the nearest ancestor's.
String? effectiveModel(String branchId, Map<String, Branch> branches) {
  final seen = <String>{};
  String? id = branchId;
  while (id != null && seen.add(id)) {
    final branch = branches[id];
    if (branch == null) return null;
    if (branch.model != null) return branch.model;
    id = branch.parentBranchId;
  }
  return null;
}

/// The branches from the trunk down to [branchId], trunk first.
List<Branch> branchChain(String branchId, Map<String, Branch> branches) {
  final chain = <Branch>[];
  final seen = <String>{};
  String? id = branchId;
  while (id != null && seen.add(id)) {
    final branch = branches[id];
    if (branch == null) break;
    chain.add(branch);
    id = branch.parentBranchId;
  }
  return chain.reversed.toList();
}

/// One branch in a lesson's outline, [depth] levels below the trunk.
typedef OutlineEntry = ({Branch branch, int depth});

/// Every branch reachable from the trunk, depth first: each tangent under
/// the thread it came from, siblings in the server's order.
List<OutlineEntry> branchOutline(String trunkId, Map<String, Branch> branches) {
  final children = <String, List<Branch>>{};
  for (final b in branches.values) {
    final parent = b.parentBranchId;
    if (parent != null) (children[parent] ??= []).add(b);
  }
  final outline = <OutlineEntry>[];
  void visit(Branch branch, int depth) {
    outline.add((branch: branch, depth: depth));
    for (final child in children[branch.id] ?? const <Branch>[]) {
      visit(child, depth + 1);
    }
  }

  final trunk = branches[trunkId];
  if (trunk != null) visit(trunk, 0);
  return outline;
}
