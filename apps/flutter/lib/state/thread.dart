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

/// The question asked before deleting [node], one of the learner's
/// messages, which takes everything after it on its thread: the later
/// messages, and the tangents started from them with everything below. The
/// first message of a tangent takes the tangent (named by [titleOf]). Null
/// for a reply. The web apps ask the same (`deleteMessageQuestion` in
/// packages/web-shared/src/core/delete-branch.ts).
String? deleteMessageQuestion(
  ChatNode node, {
  required Map<String, Branch> branches,
  required Iterable<ChatNode> nodes,
  required String Function(Branch) titleOf,
}) {
  final branch = branches[node.branchId];
  if (branch == null || node.role != Role.user) return null;
  const tail =
      'Replies still being written there are stopped. This cannot be undone.';
  final children = <String, List<Branch>>{};
  final atNode = <String, List<Branch>>{};
  for (final b in branches.values) {
    final parent = b.parentBranchId;
    if (parent != null) (children[parent] ??= []).add(b);
    final fork = b.branchPointNodeId;
    if (fork != null) (atNode[fork] ??= []).add(b);
  }
  final counts = <String, int>{};
  for (final n in nodes) {
    counts[n.branchId] = (counts[n.branchId] ?? 0) + 1;
  }
  ({int branches, int messages}) subtree(Branch root) {
    var count = 0;
    var messages = 0;
    final seen = <String>{};
    final stack = [root];
    while (stack.isNotEmpty) {
      final b = stack.removeLast();
      if (!seen.add(b.id)) continue;
      count++;
      messages += counts[b.id] ?? 0;
      stack.addAll(children[b.id] ?? const []);
    }
    return (branches: count, messages: messages);
  }

  String messagesCount(int n) => '$n message${n == 1 ? '' : 's'}';
  String tangents(int n) => '$n tangent${n == 1 ? '' : 's'}';

  if (node.seq == 0 && branch.parentBranchId != null) {
    final size = subtree(branch);
    final below = size.branches - 1;
    final along = below > 0
        ? ' along with the ${tangents(below)} below it'
        : '';
    return 'Delete this message? It starts the tangent “${titleOf(branch)}”, '
        'which goes with it$along (${messagesCount(size.messages)}). $tail';
  }
  final cut = [
    for (final n in nodes)
      if (n.branchId == branch.id && n.seq >= node.seq) n,
  ];
  var branchCount = 0;
  var branchMessages = 0;
  for (final n in cut) {
    for (final b in atNode[n.id] ?? const <Branch>[]) {
      final size = subtree(b);
      branchCount += size.branches;
      branchMessages += size.messages;
    }
  }
  final later = cut.length - 1;
  final parts = [
    if (later > 0) '$later later message${later == 1 ? '' : 's'}',
    if (branchCount > 0)
      tangents(branchCount) +
          (branchMessages > 0 ? ' (${messagesCount(branchMessages)})' : ''),
  ];
  return parts.isEmpty
      ? 'Delete this message? $tail'
      : 'Delete this message? Everything after it goes too: '
            '${parts.join(' and ')}. $tail';
}
