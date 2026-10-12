import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'api/tangent_api.dart';
import 'state/app_scope.dart';
import 'state/lessons_controller.dart';
import 'state/session_controller.dart';
import 'state/walkthrough_controller.dart';
import 'ui/chat_page.dart';
import 'ui/home_page.dart';
import 'ui/login_page.dart';
import 'ui/theme.dart';
import 'ui/turnstile/turnstile.dart';
import 'ui/widgets.dart';

/// The app: sign-in, lessons, and a lesson's chat. On the web it is served
/// under the base href `/app/`, which the routes below are relative to.
class TangentApp extends StatefulWidget {
  const TangentApp({
    super.key,
    required this.api,
    this.initialLocation,
    this.captcha = TurnstileWidget.new,
  });

  final TangentApi api;

  /// The sign-in page's human check; tests pass a stand-in.
  final CaptchaBuilder captcha;

  /// Where to start; on the web the browser's URL decides.
  final String? initialLocation;

  @override
  State<TangentApp> createState() => _TangentAppState();
}

class _TangentAppState extends State<TangentApp> {
  late final _session = SessionController(widget.api);
  late final _lessons = LessonsController(api: widget.api, session: _session);
  late final _walkthrough = WalkthroughController(
    api: widget.api,
    session: _session,
  );
  late final _router = GoRouter(
    initialLocation: widget.initialLocation,
    refreshListenable: _session,
    redirect: _redirect,
    routes: [
      GoRoute(
        path: '/login',
        builder: (context, state) => LoginPage(
          errorCode: state.uri.queryParameters['error'],
          captcha: widget.captcha,
        ),
      ),
      GoRoute(path: '/', builder: (context, state) => const HomePage()),
      GoRoute(path: '/t/:treeId', pageBuilder: _lessonPage),
      GoRoute(path: '/t/:treeId/b/:branchId', pageBuilder: _lessonPage),
    ],
  );

  @override
  void initState() {
    super.initState();
    unawaited(_session.start());
  }

  @override
  void dispose() {
    _router.dispose();
    _lessons.dispose();
    _walkthrough.dispose();
    _session.dispose();
    super.dispose();
  }

  String? _redirect(BuildContext context, GoRouterState state) {
    final atLogin = state.matchedLocation == '/login';
    return switch (_session.status) {
      SessionStatus.signedOut => atLogin ? null : '/login',
      SessionStatus.signedIn => atLogin ? '/' : null,
      SessionStatus.loading || SessionStatus.failed => null,
    };
  }

  /// A lesson's trunk and side branches share one page (same key), so
  /// moving between them updates it rather than replacing it.
  static Page<void> _lessonPage(BuildContext context, GoRouterState state) {
    final treeId = state.pathParameters['treeId']!;
    return MaterialPage<void>(
      key: ValueKey('lesson-$treeId'),
      child: ChatPage(
        treeId: treeId,
        branchId: state.pathParameters['branchId'],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AppScope(
      api: widget.api,
      session: _session,
      lessons: _lessons,
      walkthrough: _walkthrough,
      child: MaterialApp.router(
        title: brandName,
        debugShowCheckedModeBanner: false,
        theme: lightTheme,
        darkTheme: darkTheme,
        routerConfig: _router,
        builder: (context, child) => ListenableBuilder(
          listenable: _session,
          builder: (context, _) => switch (_session.status) {
            SessionStatus.loading => const _Splash(),
            SessionStatus.failed => _Unreachable(onRetry: _session.start),
            _ => child ?? const SizedBox.shrink(),
          },
        ),
      ),
    );
  }
}

class _Splash extends StatelessWidget {
  const _Splash();

  @override
  Widget build(BuildContext context) =>
      const Scaffold(body: Center(child: Logo(size: 40, showName: false)));
}

class _Unreachable extends StatelessWidget {
  const _Unreachable({required this.onRetry});

  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: ContentColumn(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Logo(size: 28),
            const SizedBox(height: 16),
            const Text(
              'Tangent Learn can’t be reached. Check your connection.',
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: () => unawaited(onRetry()),
              child: const Text('Try again'),
            ),
          ],
        ),
      ),
    ),
  );
}
