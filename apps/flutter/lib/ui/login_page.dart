import 'dart:async';

import 'package:flutter/material.dart';

import '../api/models.dart';
import '../state/app_scope.dart';
import '../state/notice.dart';
import 'links.dart';
import 'remember.dart';
import 'theme.dart';
import 'turnstile/turnstile.dart';
import 'widgets.dart';

/// Why a magic link didn't sign in (`?error=` on the page it lands on).
String? loginErrorMessage(String? code) => switch (code) {
  null || '' => null,
  'unable_to_create_user' || 'not_allowed' =>
    '$brandName needs a verified email address. Sign in with an email link.',
  'INVALID_TOKEN' || 'EXPIRED_TOKEN' || 'ATTEMPTS_EXCEEDED' =>
    'That sign-in link has expired or was already used. Request a new one.',
  'access_denied' => 'Sign-in was cancelled.',
  'signups_closed' =>
    '$brandName is full for now and isn’t taking new accounts. Already '
        'signed up? Sign in the way you did before.',
  _ => 'Sign-in failed. Please try again.',
};

final _emailPattern = RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$');

/// Builds the human check that gives a captcha token.
typedef CaptchaBuilder = Widget Function({
  Key? key,
  required String siteKey,
  required ValueChanged<String?> onToken,
});

/// Sign-in by magic link. Signing in the first time creates the account.
class LoginPage extends StatefulWidget {
  const LoginPage({
    super.key,
    this.errorCode,
    this.captcha = TurnstileWidget.new,
  });

  /// `?error=` from a magic link that failed.
  final String? errorCode;

  /// Turnstile; tests pass a stand-in.
  final CaptchaBuilder captcha;

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _email = TextEditingController();
  LoginOptions? _options;
  late String? _error = loginErrorMessage(widget.errorCode);
  String? _token;
  String? _sentTo;
  bool _busy = false;

  /// A Turnstile token works once, so each attempt gets a fresh widget.
  int _attempt = 0;

  @override
  void initState() {
    super.initState();
    _email.addListener(() => setState(() {}));
    unawaited(_loadOptions());
  }

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  Future<void> _loadOptions() async {
    final scope = AppScope.of(context);
    try {
      final options = await scope.api.loginOptions();
      if (!mounted) return;
      setState(() => _options = options);
      // Under the local no-sign-in bypass every request is signed in already.
      if (options.devMode) await scope.session.start();
    } on Object catch (error) {
      if (mounted) setState(() => _error = noticeFor(error).text);
    }
  }

  bool get _canSend =>
      !_busy && _token != null && _emailPattern.hasMatch(_email.text.trim());

  Future<void> _send() async {
    final token = _token;
    if (!_canSend || token == null) return;
    final email = _email.text.trim();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      rememberSignIn();
      await AppScope.of(context).api.sendMagicLink(
        email: email,
        captchaToken: token,
        callbackPath: '/app/',
        errorCallbackPath: '/app/login',
      );
      if (mounted) setState(() => _sentTo = email);
    } on Object catch (error) {
      if (mounted) setState(() => _error = noticeFor(error).text);
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
          _token = null;
          _attempt++;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final options = _options;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Logo(size: 28),
                      const SizedBox(height: 20),
                      if (_error != null) ...[
                        _ErrorText(_error!),
                        const SizedBox(height: 16),
                      ],
                      if (options == null && _error == null)
                        const Center(child: CircularProgressIndicator())
                      else if (options != null)
                        ..._body(options),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _body(LoginOptions options) {
    final theme = Theme.of(context);
    final sentTo = _sentTo;
    if (!options.configured) {
      return const [Text('Sign-in isn’t set up on this server.')];
    }
    if (sentTo != null) {
      return [
        Text('Check your email', style: theme.textTheme.titleLarge),
        const SizedBox(height: 8),
        Text.rich(
          TextSpan(
            children: [
              const TextSpan(text: 'We sent a sign-in link to '),
              TextSpan(
                text: sentTo,
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
              const TextSpan(
                text: '. It works once and expires in 15 minutes.',
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        OutlinedButton(
          onPressed: () => setState(() => _sentTo = null),
          child: const Text('Use a different email'),
        ),
      ];
    }
    final siteKey = options.turnstileSiteKey;
    return [
      Text('Sign in to $brandName', style: theme.textTheme.titleLarge),
      const SizedBox(height: 4),
      Text(
        'We email you a link. Signing in the first time creates your account.',
        style: theme.textTheme.bodySmall,
      ),
      if (!options.signupsOpen) ...[
        const SizedBox(height: 12),
        const Text(
          '$brandName is full for now: new accounts are closed. Already have '
          'one? Sign in as usual.',
        ),
      ],
      const SizedBox(height: 20),
      TextField(
        controller: _email,
        enabled: !_busy,
        keyboardType: TextInputType.emailAddress,
        autofillHints: const [AutofillHints.email],
        decoration: const InputDecoration(labelText: 'Email'),
        onSubmitted: (_) => unawaited(_send()),
      ),
      const SizedBox(height: 16),
      if (siteKey == null)
        const Text('Email sign-in is unavailable on this server.')
      else
        widget.captcha(
          key: ValueKey(_attempt),
          siteKey: siteKey,
          onToken: (token) => setState(() => _token = token),
        ),
      const SizedBox(height: 16),
      SizedBox(
        width: double.infinity,
        child: FilledButton(
          onPressed: _canSend ? () => unawaited(_send()) : null,
          child: const Text('Email me a link'),
        ),
      ),
      const SizedBox(height: 16),
      Wrap(
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Text(
            'By signing in you confirm you are at least 13 and agree to the',
            style: theme.textTheme.bodySmall,
          ),
          _SmallLink(label: 'Terms of service', path: '/terms'),
          Text('and', style: theme.textTheme.bodySmall),
          _SmallLink(label: 'Privacy policy', path: '/privacy'),
        ],
      ),
    ];
  }
}

class _ErrorText extends StatelessWidget {
  const _ErrorText(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: TangentColors.of(context).dangerSoft,
      borderRadius: BorderRadius.circular(radius),
    ),
    child: Semantics(liveRegion: true, child: Text(text)),
  );
}

class _SmallLink extends StatelessWidget {
  const _SmallLink({required this.label, required this.path});
  final String label;
  final String path;

  @override
  Widget build(BuildContext context) => TextButton(
    style: TextButton.styleFrom(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      minimumSize: Size.zero,
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      textStyle: const TextStyle(fontSize: 14),
    ),
    onPressed: () => openLink(context, path, newTab: true),
    child: Text(label),
  );
}
