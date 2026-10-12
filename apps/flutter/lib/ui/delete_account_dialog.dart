import 'package:flutter/material.dart';

import '../state/app_scope.dart';
import '../state/notice.dart';
import 'links.dart';

/// Permanent account deletion, from the account menu: the learner retypes
/// [email] to confirm (the server checks it too). Once the account is gone
/// the session is too, and the router shows the sign-in page.
class DeleteAccountDialog extends StatefulWidget {
  const DeleteAccountDialog({super.key, required this.email});

  /// The signed-in account's email.
  final String email;

  @override
  State<DeleteAccountDialog> createState() => _DeleteAccountDialogState();
}

class _DeleteAccountDialogState extends State<DeleteAccountDialog> {
  final _typed = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _typed.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _typed.dispose();
    super.dispose();
  }

  bool get _confirmed =>
      _typed.text.trim().toLowerCase() == widget.email.toLowerCase();

  Future<void> _delete() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final navigator = Navigator.of(context);
    try {
      await AppScope.of(context).session.deleteAccount(_typed.text.trim());
      navigator.pop();
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = noticeFor(error).text;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AlertDialog(
      title: const Text('Delete account'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Permanently deletes your Tangent account, here and on the web: '
              'every lesson, share link and setting, your sign-in, and your '
              'customer record with our payment provider, which cancels your '
              'membership. Unused credit is lost. This can’t be undone.',
            ),
            TextButton(
              style: TextButton.styleFrom(padding: EdgeInsets.zero),
              onPressed: () => openLink(context, '/delete-account'),
              child: const Text('What is kept, and for how long'),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _typed,
              enabled: !_busy,
              keyboardType: TextInputType.emailAddress,
              autocorrect: false,
              decoration: InputDecoration(
                labelText: 'To confirm, type ${widget.email}',
              ),
            ),
            if (_error case final error?) ...[
              const SizedBox(height: 12),
              Text(error, style: TextStyle(color: theme.colorScheme.error)),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          style: FilledButton.styleFrom(
            backgroundColor: theme.colorScheme.error,
            foregroundColor: theme.colorScheme.onError,
          ),
          onPressed: _confirmed && !_busy ? _delete : null,
          child: Text(_busy ? 'Deleting…' : 'Delete my account'),
        ),
      ],
    );
  }
}
