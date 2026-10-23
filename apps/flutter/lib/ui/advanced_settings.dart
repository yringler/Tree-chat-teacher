import 'dart:async';

import 'package:flutter/material.dart';

import '../api/models.dart';
import '../state/app_scope.dart';
import '../state/learn_reply.dart';
import '../state/reply_settings_controller.dart';

/// Opens Advanced settings: a bottom sheet on a phone, a dialog on a wider
/// screen, as "How tangents work" does.
Future<void> showAdvancedSettings(BuildContext context) {
  const sheet = AdvancedSettings();
  if (MediaQuery.sizeOf(context).width < 600) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      useSafeArea: true,
      builder: (context) => const SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: sheet,
      ),
    );
  }
  return showDialog<void>(
    context: context,
    builder: (context) => Dialog(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 480),
        child: const SingleChildScrollView(
          padding: EdgeInsets.all(24),
          child: sheet,
        ),
      ),
    ),
  );
}

/// The model replies run on (Normal or Max) and how long they may run,
/// each saved as it is picked, as on the web. While the open pool pays,
/// neither applies, so both are disabled with why; on an Anthropic key the
/// model is fixed, so its choice is too.
class AdvancedSettings extends StatefulWidget {
  const AdvancedSettings({super.key});

  @override
  State<AdvancedSettings> createState() => _AdvancedSettingsState();
}

class _AdvancedSettingsState extends State<AdvancedSettings> {
  String? _error;

  Future<void> _save(
    ReplySettingsController replies,
    Future<void> Function() save,
  ) async {
    setState(() => _error = null);
    try {
      await save();
    } on Object catch (error) {
      if (mounted) setState(() => _error = 'Couldn’t save: $error');
      debugPrint('Could not save the reply settings: $error');
    }
  }

  @override
  Widget build(BuildContext context) {
    final scope = AppScope.of(context);
    final replies = scope.replySettings;
    final theme = Theme.of(context);
    return ListenableBuilder(
      listenable: Listenable.merge([replies, scope.session]),
      builder: (context, _) {
        final settings = replies.settings;
        final pool = replies.pool;
        final fixed = replies.fixedModel;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Advanced settings', style: theme.textTheme.titleLarge),
            const SizedBox(height: 12),
            if (pool)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(
                  'These aren’t used while the open pool pays for your replies.',
                  style: theme.textTheme.bodyMedium,
                ),
              ),
            Text('Model', style: theme.textTheme.titleSmall),
            if (fixed)
              Text(learnReplyFixedModelNote, style: theme.textTheme.bodySmall),
            RadioGroup<ModelTier>(
              groupValue: settings.tier,
              onChanged: (tier) {
                if (tier == null) return;
                unawaited(_save(replies, () => replies.save(tier: tier)));
              },
              child: Column(
                children: [
                  for (final tier in ModelTier.values)
                    RadioListTile<ModelTier>(
                      value: tier,
                      enabled: !pool && !fixed,
                      contentPadding: EdgeInsets.zero,
                      title: Text(tierLabels[tier]!),
                      subtitle: Text(tierHints[tier]!),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            Text('Reply length', style: theme.textTheme.titleSmall),
            RadioGroup<ReplyLength>(
              groupValue: settings.replyLength,
              onChanged: (length) {
                if (length == null) return;
                unawaited(
                  _save(replies, () => replies.save(replyLength: length)),
                );
              },
              child: Column(
                children: [
                  for (final length in ReplyLength.values)
                    RadioListTile<ReplyLength>(
                      value: length,
                      enabled: !pool,
                      contentPadding: EdgeInsets.zero,
                      title: Text(replyLengthLabels[length]!),
                      subtitle: Text(replyLengthHints[length]!),
                    ),
                ],
              ),
            ),
            Text(replyLengthFootnote, style: theme.textTheme.bodySmall),
            if (_error case final error?)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  error,
                  style: TextStyle(color: theme.colorScheme.error),
                ),
              ),
            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: pool || settings.isDefault
                      ? null
                      : () => unawaited(_save(replies, replies.reset)),
                  child: const Text('Back to defaults'),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('Done'),
                ),
              ],
            ),
          ],
        );
      },
    );
  }
}

/// Above the composer while an Advanced setting isn't the default ("Max ·
/// Very long"), so a learner who changed one sees it each time they write,
/// and nothing while every one is. Muted, with why, while the open pool
/// pays. Opens Advanced settings; it never resets anything itself, and it
/// isn't announced as it appears (no live region).
class AdvancedChip extends StatelessWidget {
  const AdvancedChip({super.key});

  @override
  Widget build(BuildContext context) {
    final scope = AppScope.of(context);
    return ListenableBuilder(
      listenable: Listenable.merge([scope.replySettings, scope.session]),
      builder: (context, _) {
        final chip = scope.replySettings.indicator;
        if (chip == null) return const SizedBox.shrink();
        final theme = Theme.of(context);
        final muted = theme.colorScheme.onSurfaceVariant;
        return Align(
          alignment: Alignment.centerLeft,
          child: Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Semantics(
              button: true,
              label: chip.semanticLabel,
              excludeSemantics: true,
              child: ActionChip(
                key: const ValueKey('advanced-chip'),
                avatar: Icon(
                  Icons.settings_outlined,
                  size: 16,
                  color: chip.off ? muted : null,
                ),
                label: Text(
                  [chip.label, ?chip.note].join(' · '),
                  style: chip.off ? TextStyle(color: muted) : null,
                ),
                side: BorderSide(color: theme.colorScheme.outlineVariant),
                visualDensity: VisualDensity.compact,
                onPressed: () => unawaited(showAdvancedSettings(context)),
              ),
            ),
          ),
        );
      },
    );
  }
}
