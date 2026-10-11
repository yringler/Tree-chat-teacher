import 'dart:async';
import 'dart:js_interop';
import 'dart:ui_web' as ui_web;

import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

const _scriptUrl =
    'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

@JS('turnstile')
external _Turnstile? get _turnstile;

extension type _Turnstile._(JSObject _) implements JSObject {
  external String? render(web.HTMLElement container, _Options options);
  external void remove(String widgetId);
}

extension type _Options._(JSObject _) implements JSObject {
  _Options() : this._(JSObject());
  external set sitekey(String value);
  external set callback(JSFunction value);
  @JS('expired-callback')
  external set expiredCallback(JSFunction value);
  @JS('error-callback')
  external set errorCallback(JSFunction value);
}

Future<void>? _script;

/// Loads Turnstile's script once per page.
Future<void> _loadScript() => _script ??= () {
  final loaded = Completer<void>();
  final script = web.HTMLScriptElement()
    ..src = _scriptUrl
    ..async = true;
  script
    ..addEventListener('load', ((web.Event _) => loaded.complete()).toJS)
    ..addEventListener(
      'error',
      ((web.Event _) {
        _script = null;
        loaded.completeError(StateError('Turnstile did not load'));
      }).toJS,
    );
  web.document.head?.append(script);
  return loaded.future;
}();

/// Cloudflare Turnstile's human check. [onToken] gets its token once solved,
/// and null when the token expires or the check fails.
class TurnstileWidget extends StatefulWidget {
  const TurnstileWidget({
    super.key,
    required this.siteKey,
    required this.onToken,
  });

  final String siteKey;
  final ValueChanged<String?> onToken;

  @override
  State<TurnstileWidget> createState() => _TurnstileWidgetState();
}

class _TurnstileWidgetState extends State<TurnstileWidget> {
  static var _views = 0;

  final _container = web.HTMLDivElement();
  late final String _viewType = 'tangent-turnstile-${_views++}';
  String? _widgetId;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    ui_web.platformViewRegistry.registerViewFactory(
      _viewType,
      (int _) => _container,
    );
  }

  Future<void> _render() async {
    try {
      await _loadScript();
    } on Object {
      if (mounted) setState(() => _failed = true);
      return;
    }
    final turnstile = _turnstile;
    if (!mounted || turnstile == null) return;
    final options = _Options()
      ..sitekey = widget.siteKey
      ..callback = ((String token) => widget.onToken(token)).toJS
      ..expiredCallback = (() => widget.onToken(null)).toJS
      ..errorCallback = (() => widget.onToken(null)).toJS;
    _widgetId = turnstile.render(_container, options);
  }

  @override
  void dispose() {
    final id = _widgetId;
    if (id != null) _turnstile?.remove(id);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_failed) {
      return const Text(
        'The human check didn’t load. Reload the page to try again.',
      );
    }
    // Turnstile's widget is 300 × 65.
    return SizedBox(
      width: 300,
      height: 65,
      child: HtmlElementView(
        viewType: _viewType,
        onPlatformViewCreated: (_) => unawaited(_render()),
      ),
    );
  }
}
