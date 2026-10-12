import 'package:flutter/material.dart';

import '../api/models.dart';
import '../state/app_scope.dart';

/// The Normal/Max choice of tutor model. The open pool runs one model, so on
/// the pool there is nothing to choose.
class TierSwitch extends StatelessWidget {
  const TierSwitch({
    super.key,
    required this.tier,
    required this.enabled,
    required this.onChanged,
  });

  /// Null when the branch runs on a model that is neither tier.
  final Tier? tier;
  final bool enabled;
  final ValueChanged<Tier> onChanged;

  @override
  Widget build(BuildContext context) {
    final scope = AppScope.of(context);
    return ListenableBuilder(
      listenable: Listenable.merge([scope.session, scope.lessons]),
      builder: (context, _) {
        if (scope.session.payer == Payer.pool) {
          return Text(
            'The open pool uses one model',
            style: Theme.of(context).textTheme.bodySmall,
          );
        }
        if (!scope.lessons.hasTiers) return const SizedBox.shrink();
        final current = tier;
        return SegmentedButton<Tier>(
          showSelectedIcon: false,
          emptySelectionAllowed: true,
          style: const ButtonStyle(visualDensity: VisualDensity.compact),
          segments: const [
            ButtonSegment(value: Tier.normal, label: Text('Normal')),
            ButtonSegment(value: Tier.max, label: Text('Max')),
          ],
          selected: {?current},
          onSelectionChanged: enabled
              ? (selection) {
                  if (selection.isNotEmpty) onChanged(selection.first);
                }
              : null,
        );
      },
    );
  }
}
