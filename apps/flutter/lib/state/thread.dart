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
