import 'dart:async';

import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../../config.dart';

/// Cloudflare Turnstile in a native build. Turnstile checks the hostname of
/// the page a token was issued on, so the widget runs in the Worker's
/// `/app-captcha` page, shown in a web view. The page posts each result to
/// the `TangentCaptcha` channel: the token on a pass, an empty message when
/// it expired or failed (the widget then refreshes or retries by itself).
///
/// The web view shows whatever the server answers at that path, so it stays
/// hidden until the page is the captcha page: a deployment without it answers
/// with its static assets' fallback, the power app, and that must not appear
/// inside the sign-in page.
class TurnstileWidget extends StatefulWidget {
  const TurnstileWidget({
    super.key,
    required this.siteKey,
    required this.onToken,
  });

  /// Unused here: the page carries the Worker's own site key.
  final String siteKey;
  final ValueChanged<String?> onToken;

  @override
  State<TurnstileWidget> createState() => _TurnstileWidgetState();
}

/// The captcha page's script defines this callback
/// (apps/worker/src/http/app-captcha-page.tsx). A number, not a boolean: each
/// platform's web view hands back a number the same way.
const _isCaptchaPage =
    "typeof window.tangentCaptchaPassed === 'function' ? 1 : 0";

enum _Load { loading, shown, failed }

class _TurnstileWidgetState extends State<TurnstileWidget> {
  late final Uri _page = apiBaseUri().resolve('/app-captcha');
  final _controller = WebViewController();
  var _load = _Load.loading;

  @override
  void initState() {
    super.initState();
    unawaited(_start());
  }

  Future<void> _start() async {
    await _controller.setJavaScriptMode(JavaScriptMode.unrestricted);
    await _controller.addJavaScriptChannel(
      'TangentCaptcha',
      onMessageReceived: (message) {
        if (!mounted) return;
        widget.onToken(message.message.isEmpty ? null : message.message);
      },
    );
    await _controller.setNavigationDelegate(
      NavigationDelegate(
        onNavigationRequest: _navigation,
        onPageFinished: (_) => unawaited(_checkPage()),
        onWebResourceError: (error) {
          if (error.isForMainFrame ?? false) _setLoad(_Load.failed);
        },
      ),
    );
    await _controller.loadRequest(_page);
  }

  /// The web view stays on the captcha page: a link in the widget (its
  /// privacy terms) would otherwise replace the page and its channel.
  /// Turnstile's own frame loads freely.
  NavigationDecision _navigation(NavigationRequest request) {
    if (!request.isMainFrame) return NavigationDecision.navigate;
    final url = Uri.parse(request.url);
    return url.origin == _page.origin && url.path == _page.path
        ? NavigationDecision.navigate
        : NavigationDecision.prevent;
  }

  Future<void> _checkPage() async {
    Object answer;
    try {
      answer = await _controller.runJavaScriptReturningResult(_isCaptchaPage);
    } on Object {
      answer = 0;
    }
    _setLoad(answer == 1 ? _Load.shown : _Load.failed);
  }

  void _setLoad(_Load load) {
    if (mounted) setState(() => _load = load);
  }

  Future<void> _retry() async {
    _setLoad(_Load.loading);
    await _controller.loadRequest(_page);
  }

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 160,
    child: Stack(
      fit: StackFit.expand,
      children: [
        // Laid out while hidden, so the page loads at its size, but not
        // painted until it is the captcha page.
        Offstage(
          offstage: _load != _Load.shown,
          child: WebViewWidget(controller: _controller),
        ),
        if (_load == _Load.loading)
          const Center(child: CircularProgressIndicator())
        else if (_load == _Load.failed)
          Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Text('The human check didn’t load.'),
              TextButton(
                onPressed: () => unawaited(_retry()),
                child: const Text('Try again'),
              ),
            ],
          ),
      ],
    ),
  );
}
