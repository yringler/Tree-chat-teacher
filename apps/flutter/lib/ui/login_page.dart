import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

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

/// Why a code didn't sign in, and whether it is spent, so only a new email
/// brings one that works.
({String text, bool spent}) codeErrorMessage(Object error) => switch (error) {
  ApiException(code: 'INVALID_OTP') => (
    text: 'That code isn’t right. Check the email and try again.',
    spent: false,
  ),
  ApiException(code: 'OTP_EXPIRED') => (
    text: 'That code has expired.',
    spent: true,
  ),
  ApiException(code: 'TOO_MANY_ATTEMPTS') => (
    text: 'Too many wrong tries for that code.',
    spent: true,
  ),
  ApiException(status: 429) => (
    text: 'Too many tries. Wait a minute and try again.',
    spent: false,
  ),
  ApiException(code: 'signups_closed') => (
    text: loginErrorMessage('signups_closed')!,
    spent: false,
  ),
  _ => (text: noticeFor(error).text, spent: false),
};

final _emailPattern = RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$');

const _codeLength = 6;

/// Builds the human check that gives a captcha token.
typedef CaptchaBuilder = Widget Function({
  Key? key,
  required String siteKey,
  required ValueChanged<String?> onToken,
});

/// Sign-in by email: the email has a link and a code. Signing in the first
/// time creates the account. On the web either works; a native build has no
/// browser session for the link to sign in, so it asks for the code.
class LoginPage extends StatefulWidget {
  const LoginPage({
    super.key,
    this.errorCode,
    this.captcha = TurnstileWidget.new,
    this.native = !kIsWeb,
  });

  /// `?error=` from a magic link that failed.
  final String? errorCode;

  /// Turnstile; tests pass a stand-in.
  final CaptchaBuilder captcha;

  /// A native build: the page speaks of the code only.
  final bool native;

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _email = TextEditingController();
  final _code = TextEditingController();
  LoginOptions? _options;
  late String? _error = loginErrorMessage(widget.errorCode);
  String? _token;
  String? _sentTo;
  bool _busy = false;

  /// Why the last code didn't sign in; [_codeSpent] when it no longer can.
  String? _codeError;
  bool _codeSpent = false;

  /// A Turnstile token works once, so each attempt gets a fresh widget.
  int _attempt = 0;

  @override
  void initState() {
    super.initState();
    _email.addListener(() => setState(() {}));
    _code.addListener(() => setState(() {}));
    unawaited(_loadOptions());
  }

  @override
  void dispose() {
    _email.dispose();
    _code.dispose();
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
      if (mounted) {
        setState(() {
          _sentTo = email;
          _code.clear();
          _codeError = null;
          _codeSpent = false;
        });
      }
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

  bool get _canSubmitCode =>
      !_busy && !_codeSpent && _code.text.length == _codeLength;

  Future<void> _submitCode() async {
    final email = _sentTo;
    if (!_canSubmitCode || email == null) return;
    final scope = AppScope.of(context);
    setState(() {
      _busy = true;
      _codeError = null;
    });
    try {
      await scope.api.signInWithCode(email: email, code: _code.text);
      // Signed in: the router leaves this page once the session knows.
      await scope.session.start();
    } on Object catch (error) {
      if (!mounted) return;
      final message = codeErrorMessage(error);
      setState(() {
        _codeError = message.text;
        _codeSpent = message.spent;
        _code.clear();
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Back to the email form, the address kept, for a new email.
  void _startOver() => setState(() {
    _sentTo = null;
    _codeError = null;
    _codeSpent = false;
  });

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
    final sentTo = _sentTo;
    if (!options.configured) {
      return const [Text('Sign-in isn’t set up on this server.')];
    }
    if (sentTo != null) return _checkEmail(sentTo);
    final theme = Theme.of(context);
    final siteKey = options.turnstileSiteKey;
    return [
      Text('Sign in to $brandName', style: theme.textTheme.titleLarge),
      const SizedBox(height: 4),
      Text(
        widget.native
            ? 'We email you a code. Signing in the first time creates your '
                  'account.'
            : 'We email you a link and a code. Signing in the first time '
                  'creates your account.',
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
          child: Text(widget.native ? 'Email me a code' : 'Email me a link'),
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
          const _SmallLink(label: 'Terms of service', path: '/terms'),
          Text('and', style: theme.textTheme.bodySmall),
          const _SmallLink(label: 'Privacy policy', path: '/privacy'),
        ],
      ),
    ];
  }

  /// After the email went out: the code field, and on the web the link.
  List<Widget> _checkEmail(String sentTo) {
    final theme = Theme.of(context);
    final codeError = _codeError;
    return [
      Text('Check your email', style: theme.textTheme.titleLarge),
      const SizedBox(height: 8),
      Text.rich(
        TextSpan(
          children: [
            TextSpan(
              text: widget.native
                  ? 'We sent a sign-in code to '
                  : 'We sent a sign-in link and code to ',
            ),
            TextSpan(
              text: sentTo,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            TextSpan(
              text: widget.native
                  ? '. Enter it here. It works once and expires in 15 minutes.'
                  : '. Open the link, or enter the code here. Each works once '
                        'and expires in 15 minutes.',
            ),
          ],
        ),
      ),
      const SizedBox(height: 20),
      TextField(
        controller: _code,
        enabled: !_busy && !_codeSpent,
        autofocus: true,
        keyboardType: TextInputType.number,
        autofillHints: const [AutofillHints.oneTimeCode],
        // Pasting the email's line keeps its digits; six fill the field.
        inputFormatters: [
          FilteringTextInputFormatter.digitsOnly,
          LengthLimitingTextInputFormatter(_codeLength),
        ],
        style: const TextStyle(fontSize: 22, letterSpacing: 6),
        decoration: const InputDecoration(
          labelText: 'Code from the email',
          counterText: '',
        ),
        onChanged: (value) {
          if (value.length == _codeLength) unawaited(_submitCode());
        },
        onSubmitted: (_) => unawaited(_submitCode()),
      ),
      if (codeError != null) ...[
        const SizedBox(height: 12),
        _ErrorText(codeError),
      ],
      const SizedBox(height: 16),
      SizedBox(
        width: double.infinity,
        child: _codeSpent
            ? FilledButton(
                onPressed: _startOver,
                child: const Text('Send a new code'),
              )
            : FilledButton(
                onPressed: _canSubmitCode
                    ? () => unawaited(_submitCode())
                    : null,
                child: const Text('Sign in'),
              ),
      ),
      const SizedBox(height: 8),
      TextButton(
        onPressed: _busy ? null : _startOver,
        child: const Text('Use a different email'),
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
