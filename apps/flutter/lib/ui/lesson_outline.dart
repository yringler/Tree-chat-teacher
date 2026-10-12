import 'dart:math';

import 'package:flutter/material.dart';

import '../api/models.dart';
import '../state/thread.dart';
import 'tangent_help_copy.dart';
import 'theme.dart';

/// The server's placeholder title for a tangent started from a whole
/// message, before its first reply names it. Mirrors
/// DEFAULT_BRANCH_TITLE_PREFIX in packages/shared/src/domain.ts, which
/// packages/web-shared/src/tangent-help-parity.spec.ts checks.
const defaultBranchTitlePrefix = 'Tangent: ';

/// A tangent's own title, as Learn web shows it: the placeholder's prefix
/// goes, since the app already labels it a tangent. A title the learner
/// gave is kept whole, even one that starts the same way.
String tangentTitle(Branch branch) {
  final title = branch.title;
  if (branch.titleSource == 'default' &&
      title.startsWith(defaultBranchTitlePrefix)) {
    return title.substring(defaultBranchTitlePrefix.length);
  }
  return title;
}

/// A branch's name in the breadcrumbs and the outline.
String outlineTitle(Branch branch) {
  if (branch.parentBranchId == null) return mainThreadLabel;
  final title = tangentTitle(branch);
  return title.isEmpty ? 'Tangent' : title;
}

/// The lesson's main thread and every tangent in it, each nested under
/// the one it came from, as the web app's sidebar lists them.
class LessonOutline extends StatelessWidget {
  const LessonOutline({
    super.key,
    required this.outline,
    required this.chain,
    required this.onOpen,
  });

  final List<OutlineEntry> outline;

  /// The way down to the branch on screen, the last of them.
  final List<Branch> chain;
  final ValueChanged<Branch> onOpen;

  /// Deeper tangents stop indenting, so their titles keep some room.
  static const _maxIndent = 6;

  @override
  Widget build(BuildContext context) {
    final tokens = TangentColors.of(context);
    final onScreen = chain.isEmpty ? null : chain.last.id;
    final onPath = {for (final b in chain) b.id};
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 8),
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
          child: Text(
            'Tangents',
            style: Theme.of(context).textTheme.labelLarge
                ?.copyWith(color: tokens.fgMuted),
          ),
        ),
        for (final (:branch, :depth) in outline)
          ListTile(
            dense: true,
            selected: branch.id == onScreen,
            selectedTileColor: tokens.accentSoft,
            contentPadding: EdgeInsets.only(
              left: 16.0 + 16 * min(depth, _maxIndent),
              right: 16,
            ),
            minLeadingWidth: 0,
            horizontalTitleGap: 6,
            leading: depth == 0
                ? null
                : Icon(
                    Icons.subdirectory_arrow_right,
                    size: 16,
                    color: tokens.fgMuted,
                  ),
            title: Text(
              outlineTitle(branch),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 14,
                fontWeight: onPath.contains(branch.id)
                    ? FontWeight.w600
                    : FontWeight.normal,
              ),
            ),
            onTap: () => onOpen(branch),
          ),
      ],
    );
  }
}
