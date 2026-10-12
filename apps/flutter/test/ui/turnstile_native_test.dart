import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/ui/turnstile/turnstile_native.dart';
import 'package:webview_flutter_platform_interface/webview_flutter_platform_interface.dart';

import '../fakes.dart';

/// What the server answers at `/app-captcha`: the page's text, and whether it
/// is the Worker's captcha page, whose script defines the callback Turnstile
/// passes the token to. [unreachable] fails to load at all.
class FakePage {
  const FakePage(this.text, {this.isCaptcha = false, this.unreachable = false});
  final List<String> text;
  final bool isCaptcha;
  final bool unreachable;
}

/// A deployment without the captcha page: the static assets' single-page
/// fallback answers with the power app.
const powerApp = FakePage([
  'New conversation',
  'Ask anything. Later, branch from any message to explore a tangent.',
]);
const captchaPage = FakePage(['Turnstile widget'], isCaptcha: true);
const offline = FakePage([], unreachable: true);

/// Web views that load [pages] in turn (the last repeats) and show their
/// text.
class FakeWebViews extends WebViewPlatform {
  FakeWebViews(this.pages);

  final List<FakePage> pages;
  final loaded = <Uri>[];
  late FakeWebViewController controller;

  @override
  PlatformWebViewController createPlatformWebViewController(
    PlatformWebViewControllerCreationParams params,
  ) => controller = FakeWebViewController(this, params);

  @override
  PlatformNavigationDelegate createPlatformNavigationDelegate(
    PlatformNavigationDelegateCreationParams params,
  ) => FakeNavigationDelegate(params);

  @override
  PlatformWebViewWidget createPlatformWebViewWidget(
    PlatformWebViewWidgetCreationParams params,
  ) => FakeWebViewWidget(params);
}

class FakeWebViewController extends PlatformWebViewController {
  FakeWebViewController(this.views, super.params) : super.implementation();

  final FakeWebViews views;
  final page = ValueNotifier<FakePage?>(null);
  FakeNavigationDelegate? _delegate;
  final _channels = <String, JavaScriptChannelParams>{};

  /// The page posts [message] to the app's channel.
  void post(String message) => _channels['TangentCaptcha']!.onMessageReceived(
    JavaScriptMessage(message: message),
  );

  @override
  Future<void> setJavaScriptMode(JavaScriptMode javaScriptMode) async {}

  @override
  Future<void> addJavaScriptChannel(JavaScriptChannelParams params) async =>
      _channels[params.name] = params;

  @override
  Future<void> setPlatformNavigationDelegate(
    PlatformNavigationDelegate handler,
  ) async => _delegate = handler as FakeNavigationDelegate;

  @override
  Future<void> loadRequest(LoadRequestParams params) async {
    views.loaded.add(params.uri);
    final next =
        views.pages[(views.loaded.length - 1).clamp(0, views.pages.length - 1)];
    if (next.unreachable) {
      page.value = null;
      _delegate?.onWebResourceError?.call(
        const WebResourceError(
          errorCode: -2,
          description: 'net::ERR_NAME_NOT_RESOLVED',
          isForMainFrame: true,
        ),
      );
      return;
    }
    page.value = next;
    _delegate?.onPageFinished?.call(params.uri.toString());
  }

  @override
  Future<Object> runJavaScriptReturningResult(String javaScript) async =>
      javaScript.contains('tangentCaptchaPassed') &&
          (page.value?.isCaptcha ?? false)
      ? 1
      : 0;
}

class FakeNavigationDelegate extends PlatformNavigationDelegate {
  FakeNavigationDelegate(super.params) : super.implementation();

  PageEventCallback? onPageFinished;
  WebResourceErrorCallback? onWebResourceError;

  @override
  Future<void> setOnNavigationRequest(
    NavigationRequestCallback onNavigationRequest,
  ) async {}

  @override
  Future<void> setOnPageFinished(PageEventCallback onPageFinished) async =>
      this.onPageFinished = onPageFinished;

  @override
  Future<void> setOnWebResourceError(
    WebResourceErrorCallback onWebResourceError,
  ) async => this.onWebResourceError = onWebResourceError;
}

class FakeWebViewWidget extends PlatformWebViewWidget {
  FakeWebViewWidget(super.params) : super.implementation();

  @override
  Widget build(BuildContext context) {
    final controller = params.controller as FakeWebViewController;
    return ValueListenableBuilder(
      valueListenable: controller.page,
      builder: (context, page, _) => Column(
        children: [
          for (final line in page?.text ?? const <String>[]) Text(line),
        ],
      ),
    );
  }
}

/// The app, signed out, with the native captcha over web views that load
/// [pages].
Future<FakeWebViews> pumpSignIn(
  WidgetTester tester,
  List<FakePage> pages, {
  FakeTangentApi? api,
}) async {
  final views = FakeWebViews(pages);
  WebViewPlatform.instance = views;
  await pumpApp(
    tester,
    api ?? (FakeTangentApi()..meAnswers = [unauthorized]),
    captcha: TurnstileWidget.new,
  );
  return views;
}

void main() {
  testWidgets(
    'signed out, a server without the captcha page shows sign-in alone',
    (tester) async {
      final views = await pumpSignIn(tester, [powerApp]);

      expect(views.loaded.single.path, '/app-captcha');
      expect(find.text('Sign in to Tangent Learn'), findsOneWidget);
      expect(find.text('New conversation'), findsNothing);
      expect(find.textContaining('Ask anything.'), findsNothing);
      expect(find.text('The human check didn’t load.'), findsOneWidget);
    },
  );

  testWidgets('the captcha page shows, and its token sends the email', (
    tester,
  ) async {
    final api = FakeTangentApi()..meAnswers = [unauthorized];
    final views = await pumpSignIn(tester, [captchaPage], api: api);
    expect(find.text('Turnstile widget'), findsOneWidget);
    expect(find.text('The human check didn’t load.'), findsNothing);

    views.controller.post('turnstile-token');
    await tester.enterText(find.byType(TextField), 'ada@example.com');
    await tester.pump();
    await tester.tap(find.text('Email me a code'));
    await settle(tester);

    expect(api.magicLinks.single.captchaToken, 'turnstile-token');
    expect(find.text('Check your email'), findsOneWidget);
  });

  testWidgets('a page that does not load can be tried again', (tester) async {
    final views = await pumpSignIn(tester, [offline, captchaPage]);
    expect(find.text('The human check didn’t load.'), findsOneWidget);

    await tester.tap(find.text('Try again'));
    await settle(tester);

    expect(views.loaded, hasLength(2));
    expect(find.text('Turnstile widget'), findsOneWidget);
    expect(find.text('The human check didn’t load.'), findsNothing);
  });
}
