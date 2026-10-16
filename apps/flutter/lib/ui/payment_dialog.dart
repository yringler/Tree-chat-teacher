import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../api/models.dart';
import '../state/app_scope.dart';
import '../state/notice.dart';
import '../state/session_controller.dart';
import 'format.dart';
import 'links.dart';

/// Opens [PaymentDialog].
Future<void> showPaymentDialog(BuildContext context, {bool refused = false}) =>
    showDialog<void>(
      context: context,
      builder: (_) => PaymentDialog(refused: refused),
    );

/// How replies are paid for, as in the web app's Learn: the learner's own
/// key, OpenRouter's or (where the server offers it) Anthropic's, on which
/// Learn runs a fixed pair of models (they pay that provider directly; where
/// the membership is required it needs one, which the web app sells),
/// Tangent credit, or the open pool while it is on. The key is posted once
/// and the field cleared: the server seals it into a cookie the app can't
/// read.
class PaymentDialog extends StatefulWidget {
  const PaymentDialog({super.key, this.refused = false});

  /// Opened by a message refused for want of a way to pay.
  final bool refused;

  @override
  State<PaymentDialog> createState() => _PaymentDialogState();
}

class _PaymentDialogState extends State<PaymentDialog> {
  final _key = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _key.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
      _key.clear();
    } on Object catch (error) {
      if (mounted) setState(() => _error = noticeFor(error).text);
    }
    if (mounted) setState(() => _busy = false);
  }

  void _save(SessionController session) {
    final key = _key.text.trim();
    if (key.isEmpty || _busy) return;
    unawaited(_run(() => session.saveKey(key)));
  }

  @override
  Widget build(BuildContext context) {
    final session = AppScope.of(context).session;
    return ListenableBuilder(
      listenable: session,
      builder: (context, _) {
        final theme = Theme.of(context);
        final picked = session.picked;
        return AlertDialog(
          title: const Text('How replies are paid for'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (widget.refused && session.ownKeyBlocked) ...[
                  Text(
                    session.ownKeyAllowed
                        ? 'Your message wasn’t sent: replies run on your own '
                              '${session.ownKey.label} key, and none is saved. '
                              'Save your key, or pick another way to pay, then '
                              'send it again.'
                        : 'Your message wasn’t sent: replies on your own key '
                              'need a membership. Pick another way to pay, '
                              'then send it again.',
                  ),
                  const SizedBox(height: 12),
                ],
                if (session.creditOffered || session.poolOn)
                  _choices(context, session, picked)
                else
                  Text(_ownKeyText(session), style: theme.textTheme.bodySmall),
                const SizedBox(height: 12),
                ...switch (picked) {
                  Payer.ownKey => _ownKey(context, session),
                  Payer.credit => _credit(context, session),
                  Payer.pool => [_link(context, 'How the pool works', '/pool')],
                },
                if (_error case final error?) ...[
                  const SizedBox(height: 12),
                  Text(error, style: TextStyle(color: theme.colorScheme.error)),
                ],
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Done'),
            ),
          ],
        );
      },
    );
  }

  Widget _choices(
    BuildContext context,
    SessionController session,
    Payer picked,
  ) => RadioGroup<Payer>(
    groupValue: picked,
    onChanged: (payer) {
      if (payer == null || _busy) return;
      setState(() => _error = null);
      unawaited(session.choose(payer));
    },
    child: Column(
      children: [
        RadioListTile<Payer>(
          value: Payer.ownKey,
          enabled: session.ownKeyAllowed,
          contentPadding: EdgeInsets.zero,
          title: const Text('Use my own API key'),
          subtitle: Text(_ownKeyText(session)),
        ),
        if (session.creditOffered)
          RadioListTile<Payer>(
            value: Payer.credit,
            enabled: session.creditUsable,
            contentPadding: EdgeInsets.zero,
            title: const Text('Use Tangent credit'),
            subtitle: Text(
              session.creditUsable
                  ? 'Prepaid credit, paid per reply.'
                  : 'No credit left, and top-ups aren’t available right now.',
            ),
          ),
        if (session.poolOn)
          RadioListTile<Payer>(
            value: Payer.pool,
            contentPadding: EdgeInsets.zero,
            title: const Text('Use the open pool'),
            subtitle: Text(
              'Free to you, within daily limits, on '
              '${session.pool?.modelLabel ?? 'one economical model'}. Free '
              'credit Tangent provides.',
            ),
          ),
      ],
    ),
  );

  static String _ownKeyText(SessionController session) {
    final provider = session.ownKey.label;
    if (!session.ownKeyAllowed) {
      return 'Needs a membership: it covers Tangent while $provider bills '
          'you directly. Become a member in Tangent Learn on the web.';
    }
    return 'You pay $provider directly.';
  }

  /// What each own key gets Learn, so the learner picks knowing it.
  static String _keyHint(LearnKey key) => switch (key) {
    LearnKey.openRouter => 'Replies use the model Learn picks for tutoring.',
    LearnKey.anthropic =>
      'Replies use Claude Sonnet; titles and summaries use Claude Haiku. To '
          'pick other models, use power mode.',
  };

  /// Where to create each key, and what one looks like.
  static (String, String) _keyPage(LearnKey key) => switch (key) {
    LearnKey.openRouter => ('https://openrouter.ai/settings/keys', 'sk-or-…'),
    LearnKey.anthropic => (
      'https://console.anthropic.com/settings/keys',
      'sk-ant-…',
    ),
  };

  Widget _keyChoice(SessionController session) => RadioGroup<LearnKey>(
    groupValue: session.ownKey,
    onChanged: (key) {
      if (key == null || _busy) return;
      setState(() => _error = null);
      unawaited(session.chooseKey(key));
    },
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('Which key'),
        for (final key in session.ownKeyOptions)
          RadioListTile<LearnKey>(
            value: key,
            contentPadding: EdgeInsets.zero,
            title: Text(key.label),
            subtitle: Text(_keyHint(key)),
          ),
      ],
    ),
  );

  List<Widget> _ownKey(BuildContext context, SessionController session) {
    if (!session.ownKeyAllowed) {
      return [_link(context, 'Become a member', '/learn/billing')];
    }
    final status = session.keyStatus;
    if (status == null) {
      return [
        Text(
          'Your key can’t be checked right now.',
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ];
    }
    if (!status.enabled) {
      return [const Text('This server can’t store your own key.')];
    }
    final key = session.ownKey;
    final saved = status.has(key);
    final (keyPage, keyShape) = _keyPage(key);
    return [
      if (session.ownKeyOptions.length > 1) ...[
        _keyChoice(session),
        const SizedBox(height: 8),
      ],
      Row(
        children: [
          Expanded(
            child: Text(
              saved ? 'Your ${key.label} key is saved.' : 'No key saved.',
            ),
          ),
          if (saved)
            TextButton(
              onPressed: _busy
                  ? null
                  : () => unawaited(_run(session.forgetKey)),
              child: const Text('Forget'),
            ),
        ],
      ),
      const SizedBox(height: 8),
      TextField(
        controller: _key,
        enabled: !_busy,
        obscureText: true,
        autocorrect: false,
        enableSuggestions: false,
        decoration: InputDecoration(
          labelText: saved ? 'Replace your key' : 'Your ${key.label} API key',
          hintText: keyShape,
        ),
        onSubmitted: (_) => _save(session),
      ),
      const SizedBox(height: 8),
      Text(
        'Create one with ${key.label}. It is stored encrypted '
        '${kIsWeb ? 'in this browser' : 'on this device'} until it goes 7 '
        'days unused.',
        style: Theme.of(context).textTheme.bodySmall,
      ),
      const SizedBox(height: 8),
      Wrap(
        spacing: 8,
        children: [
          FilledButton.icon(
            onPressed: _busy ? null : () => _save(session),
            icon: const Icon(Icons.key, size: 16),
            label: Text(_busy ? 'Saving…' : 'Save key'),
          ),
          TextButton(
            onPressed: () => openLink(context, keyPage, newTab: true),
            child: const Text('Get a key'),
          ),
        ],
      ),
    ];
  }

  List<Widget> _credit(BuildContext context, SessionController session) => [
    if (session.creditWaiting)
      const Text(
        'Your credit is used up, so replies use the open pool until you add '
        'credit.',
      ),
    if (session.billing case final billing?)
      Text('${formatMicros(billing.availableMicros)} available'),
    _link(context, 'Add credit', '/learn/billing'),
  ];

  static Widget _link(BuildContext context, String label, String path) => Align(
    alignment: Alignment.centerLeft,
    child: TextButton(
      style: TextButton.styleFrom(padding: EdgeInsets.zero),
      onPressed: () => openLink(context, path),
      child: Text(label),
    ),
  );
}
