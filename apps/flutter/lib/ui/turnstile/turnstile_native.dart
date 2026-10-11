import 'dart:async';

import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../../config.dart';

/// Cloudflare Turnstile in a native build. Turnstile checks the hostname of
/// the page a token was issued on, so the widget runs in the Worker's
/// `/app-captcha` page, shown in a web view. The page posts each result to
/// the `TangentCaptcha` channel: the token on a pass, an empty message when
/// it expired or failed (the widget then refreshes or retries by itself).
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

class _TurnstileWidgetState extends State<TurnstileWidget> {
  late final Uri _page = apiBaseUri().resolve('/app-captcha');
  final _controller = WebViewController();

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    await _controller.setJavaScriptMode(JavaScriptMode.unrestricted);
    await _controller.addJavaScriptChannel(
      'TangentCaptcha',
      onMessageReceived: (message) {
        if (!mounted) return;
        widget.onToken(message.message.isEmpty ? null : message.message);
      },
    );
    await _controller.setNavigationDelegate(
      NavigationDelegate(onNavigationRequest: _navigation),
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

  @override
  Widget build(BuildContext context) =>
      SizedBox(height: 160, child: WebViewWidget(controller: _controller));
}
