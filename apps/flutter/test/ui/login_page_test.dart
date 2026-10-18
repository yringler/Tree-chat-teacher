import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_sign_in_platform_interface/google_sign_in_platform_interface.dart';
import 'package:tangent/api/models.dart';
import 'package:tangent/api/token_store.dart';
import 'package:tangent/state/app_scope.dart';
import 'package:tangent/state/lessons_controller.dart';
import 'package:tangent/state/session_controller.dart';
import 'package:tangent/state/walkthrough_controller.dart';
import 'package:tangent/ui/google_id_token.dart';
import 'package:tangent/ui/login_page.dart';

import '../fakes.dart';

/// The sign-in page alone, over [api]; returns its session.
Future<SessionController> pumpLogin(
  WidgetTester tester,
  FakeTangentApi api, {
  required bool native,
  bool googleOnDevice = false,
  bool? googleEnabled = true,
  GoogleIdTokenSource? googleIdToken,
  TokenStore? signInStore,
  DateTime Function()? now,
}) async {
  final session = SessionController(api, signInStore: signInStore, now: now);
  final lessons = LessonsController(api: api, session: session);
  await tester.pumpWidget(
    AppScope(
      api: api,
      session: session,
      lessons: lessons,
      walkthrough: WalkthroughController(api: api, session: session),
      child: MaterialApp(
        home: LoginPage(
          captcha: fakeCaptcha,
          native: native,
          googleOnDevice: googleOnDevice,
          googleEnabled: googleEnabled,
          googleIdToken: googleIdToken ?? (_) async => 'id-token',
        ),
      ),
    ),
  );
  await settle(tester);
  return session;
}

/// Fills in the email, passes the captcha and sends the email.
Future<void> requestEmail(WidgetTester tester, {required String button}) async {
  await tester.enterText(find.byType(TextField), 'ada@example.com');
  await tester.pump();
  await tester.tap(find.text('Solve'));
  await tester.pump();
  await tester.tap(find.text(button));
  await settle(tester);
}

void main() {
  testWidgets('signed out, the app opens the sign-in page', (tester) async {
    final api = FakeTangentApi()..meAnswers = [unauthorized];
    await pumpApp(tester, api);
    expect(find.text('Sign in to Tangent Learn'), findsOneWidget);
  });

  testWidgets('dev mode goes straight in', (tester) async {
    final api = FakeTangentApi()
      ..meAnswers = [
        unauthorized,
        const Me(
          userId: null,
          email: null,
          devMode: true,
          builtInCredit: false,
        ),
      ]
      ..loginOptionsAnswer = const LoginOptions(
        configured: false,
        devMode: true,
        turnstileSiteKey: null,
        signupsOpen: true,
      );
    await pumpApp(tester, api);
    expect(find.text('Sign in to Tangent Learn'), findsNothing);
    expect(find.text('Start lesson'), findsOneWidget);
  });

  testWidgets('a failed magic link says why', (tester) async {
    final api = FakeTangentApi()..meAnswers = [unauthorized];
    await pumpApp(tester, api, location: '/login?error=EXPIRED_TOKEN');
    expect(
      find.text(
        'That sign-in link has expired or was already used. Request a new one.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('an email and a captcha token send a link', (tester) async {
    final api = FakeTangentApi()..meAnswers = [unauthorized];
    await pumpLogin(tester, api, native: false);

    FilledButton sendButton() => tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, 'Email me a link'),
    );
    await tester.enterText(find.byType(TextField), 'ada@example.com');
    await tester.pump();
    expect(sendButton().onPressed, isNull, reason: 'no captcha token yet');

    await tester.tap(find.text('Solve'));
    await tester.pump();
    await tester.tap(find.text('Email me a link'));
    await settle(tester);

    expect(api.magicLinks.single.email, 'ada@example.com');
    expect(api.magicLinks.single.captchaToken, 'captcha-token');
    expect(find.text('Check your email'), findsOneWidget);
    expect(
      find.textContaining('ada@example.com', findRichText: true),
      findsOneWidget,
    );
    expect(
      find.textContaining(
        'Open the link, or enter the code',
        findRichText: true,
      ),
      findsOneWidget,
    );

    await tester.tap(find.text('Use a different email'));
    await settle(tester);
    expect(find.text('Sign in to Tangent Learn'), findsOneWidget);
    expect(sendButton().onPressed, isNull, reason: 'a token works once');
  });

  testWidgets('the code from the email signs in, pasted with its words', (
    tester,
  ) async {
    final api = FakeTangentApi()..meAnswers = [unauthorized];
    final session = await pumpLogin(tester, api, native: true);
    await requestEmail(tester, button: 'Email me a code');
    expect(api.magicLinks.single.email, 'ada@example.com');
    expect(
      find.textContaining('We sent a sign-in code to', findRichText: true),
      findsOneWidget,
    );

    final field = tester.widget<TextField>(find.byType(TextField));
    expect(field.keyboardType, TextInputType.number);
    // Six digits are all it takes: no button press.
    await tester.enterText(find.byType(TextField), 'Code: 042917');
    await settle(tester);
    expect(api.codes.single, (email: 'ada@example.com', code: '042917'));
    expect(session.status, SessionStatus.signedIn);
  });

  testWidgets('a code sent before the app closed is asked for on reopening', (
    tester,
  ) async {
    final store = MemoryStore();
    var now = DateTime.utc(2026, 10, 13, 9);
    final api = FakeTangentApi()..meAnswers = [unauthorized];
    await pumpLogin(
      tester,
      api,
      native: true,
      signInStore: store,
      now: () => now,
    );
    await requestEmail(tester, button: 'Email me a code');

    // The phone closes the app while the learner reads the email.
    await tester.pumpWidget(const SizedBox());
    now = now.add(const Duration(minutes: 4));
    final session = await pumpLogin(
      tester,
      api,
      native: true,
      signInStore: store,
      now: () => now,
    );
    expect(find.text('Check your email'), findsOneWidget);
    expect(
      find.textContaining('ada@example.com', findRichText: true),
      findsOneWidget,
    );
    expect(api.magicLinks, hasLength(1), reason: 'no second email');

    await tester.enterText(find.byType(TextField), '042917');
    await settle(tester);
    expect(api.codes.single, (email: 'ada@example.com', code: '042917'));
    expect(session.status, SessionStatus.signedIn);
    expect(store.value, isNull);
  });

  testWidgets('an expired or abandoned code opens on the email form', (
    tester,
  ) async {
    final store = MemoryStore();
    var now = DateTime.utc(2026, 10, 13, 9);
    final api = FakeTangentApi()..meAnswers = [unauthorized];
    Future<void> reopen() async {
      await tester.pumpWidget(const SizedBox());
      await pumpLogin(
        tester,
        api,
        native: true,
        signInStore: store,
        now: () => now,
      );
    }

    await reopen();
    await requestEmail(tester, button: 'Email me a code');
    now = now.add(signInCodeLifetime);
    await reopen();
    expect(find.text('Sign in to Tangent Learn'), findsOneWidget);

    expect(store.value, isNull);

    await requestEmail(tester, button: 'Email me a code');
    await tester.tap(find.text('Use a different email'));
    await settle(tester);
    await reopen();
    expect(find.text('Sign in to Tangent Learn'), findsOneWidget);
  });

  testWidgets('a wrong code says so, and another can be typed', (tester) async {
    final api = FakeTangentApi()
      ..meAnswers = [unauthorized]
      ..refuseCode = const ApiException(
        status: 400,
        code: 'INVALID_OTP',
        message: 'Invalid OTP',
      );
    final session = await pumpLogin(tester, api, native: true);
    await requestEmail(tester, button: 'Email me a code');
    await tester.enterText(find.byType(TextField), '000000');
    await settle(tester);
    expect(
      find.text('That code isn’t right. Check the email and try again.'),
      findsOneWidget,
    );
    expect(session.status, isNot(SessionStatus.signedIn));
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      '',
    );

    api.refuseCode = null;
    await tester.enterText(find.byType(TextField), '042917');
    await settle(tester);
    expect(api.codes.map((c) => c.code), ['000000', '042917']);
    expect(session.status, SessionStatus.signedIn);
  });

  testWidgets('a spent code offers a new email', (tester) async {
    final api = FakeTangentApi()
      ..meAnswers = [unauthorized]
      ..refuseCode = const ApiException(
        status: 403,
        code: 'TOO_MANY_ATTEMPTS',
        message: 'Too many attempts',
      );
    await pumpLogin(tester, api, native: true);
    await requestEmail(tester, button: 'Email me a code');
    await tester.enterText(find.byType(TextField), '042917');
    await settle(tester);
    expect(find.text('Too many wrong tries for that code.'), findsOneWidget);
    expect(tester.widget<TextField>(find.byType(TextField)).enabled, isFalse);

    await tester.tap(find.text('Send a new code'));
    await settle(tester);
    expect(find.text('Sign in to Tangent Learn'), findsOneWidget);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      'ada@example.com',
    );
  });

  const withProviders = LoginOptions(
    configured: true,
    devMode: false,
    turnstileSiteKey: 'site-key',
    signupsOpen: true,
    google: true,
    github: true,
    googleClientId: 'google-client',
  );

  testWidgets('the web build offers the configured providers', (tester) async {
    final api = FakeTangentApi()
      ..meAnswers = [unauthorized]
      ..loginOptionsAnswer = withProviders;
    await pumpLogin(tester, api, native: false);
    expect(find.text('Continue with GitHub'), findsOneWidget);

    await tester.tap(find.text('Continue with Google'));
    await settle(tester);
    expect(api.socialStarts.single, (
      provider: 'google',
      callbackPath: '/app/',
    ));
  });

  testWidgets('no provider buttons when none is configured', (tester) async {
    final api = FakeTangentApi()..meAnswers = [unauthorized];
    await pumpLogin(tester, api, native: false);
    expect(find.text('Continue with Google'), findsNothing);
    expect(find.text('Continue with GitHub'), findsNothing);
  });

  testWidgets('Android signs in with Google on the device, after the captcha', (
    tester,
  ) async {
    final asked = <String>[];
    final api = FakeTangentApi()
      ..meAnswers = [unauthorized]
      ..loginOptionsAnswer = withProviders;
    final session = await pumpLogin(
      tester,
      api,
      native: true,
      googleOnDevice: true,
      googleIdToken: (clientId) async {
        asked.add(clientId);
        return 'id-token';
      },
    );
    // A provider's browser callback can't sign the app in.
    expect(find.text('Continue with GitHub'), findsNothing);
    OutlinedButton google() => tester.widget<OutlinedButton>(
      find.widgetWithText(OutlinedButton, 'Continue with Google'),
    );
    expect(google().onPressed, isNull, reason: 'no captcha token yet');

    await tester.tap(find.text('Solve'));
    await tester.pump();
    await tester.tap(find.text('Continue with Google'));
    await settle(tester);
    expect(asked, ['google-client']);
    expect(api.googleSignIns.single, (
      idToken: 'id-token',
      captchaToken: 'captcha-token',
    ));
    expect(session.status, SessionStatus.signedIn);
  });

  /// Taps the device's Google button after the captcha, with Google's
  /// account picker failing with [error], and returns the texts shown.
  Future<String> googleFails(WidgetTester tester, Object error) async {
    final api = FakeTangentApi()
      ..meAnswers = [unauthorized]
      ..loginOptionsAnswer = withProviders;
    await pumpLogin(
      tester,
      api,
      native: true,
      googleOnDevice: true,
      googleIdToken: (_) async => throw error,
    );
    await tester.tap(find.text('Solve'));
    await tester.pump();
    await tester.tap(find.text('Continue with Google'));
    await settle(tester);
    expect(api.googleSignIns, isEmpty);
    expect(find.byType(LoginPage), findsOneWidget);
    return tester
        .widgetList<Text>(find.byType(Text))
        .map((text) => text.data ?? '')
        .join('\n');
  }

  testWidgets(
    'backing out of Google\'s picker says so, with Google\'s reason',
    (tester) async {
      // Credential Manager reports a misconfigured build (an unregistered
      // SHA-1, the wrong client id) as cancelled too, so the reason shows.
      final shown = await googleFails(
        tester,
        const GoogleSignInException(
          code: GoogleSignInExceptionCode.canceled,
          description: '[16] Account reauth failed.',
        ),
      );
      expect(shown, contains('Google sign-in was cancelled'));
      expect(shown, contains('Details: canceled: [16] Account reauth failed.'));
      OutlinedButton google() => tester.widget<OutlinedButton>(
        find.widgetWithText(OutlinedButton, 'Continue with Google'),
      );
      expect(google().onPressed, isNull, reason: 'a new captcha first');
      await tester.tap(find.text('Solve'));
      await tester.pump();
      expect(google().onPressed, isNotNull);
    },
  );

  testWidgets(
    'a build Google sign-in isn\'t set up for says so, with the code',
    (tester) async {
      final shown = await googleFails(
        tester,
        const GoogleSignInException(
          code: GoogleSignInExceptionCode.clientConfigurationError,
          description: 'serverClientId must be provided on Android',
        ),
      );
      expect(shown, contains('isn’t set up correctly'));
      expect(
        shown,
        contains(
          'Details: clientConfigurationError: serverClientId must be provided '
          'on Android',
        ),
      );
    },
  );

  testWidgets('a phone without a Google account says to add one', (
    tester,
  ) async {
    final shown = await googleFails(
      tester,
      const GoogleSignInException(
        code: GoogleSignInExceptionCode.unknownError,
        description: 'No credential available: no credentials',
      ),
    );
    expect(shown, contains('no Google account on this phone'));
  });

  testWidgets('any other Google failure shows its code', (tester) async {
    final shown = await googleFails(
      tester,
      PlatformException(code: 'channel-error', message: 'Unable to connect'),
    );
    expect(shown, contains('Signing in with Google didn’t work'));
    expect(shown, contains('Details: channel-error'));
  });

  testWidgets('a refused Google sign-in says why', (tester) async {
    final api = FakeTangentApi()
      ..meAnswers = [unauthorized]
      ..loginOptionsAnswer = withProviders
      ..refuseGoogle = const ApiException(
        status: 403,
        code: 'signups_closed',
        message: '',
      );
    await pumpLogin(tester, api, native: true, googleOnDevice: true);
    await tester.tap(find.text('Solve'));
    await tester.pump();
    await tester.tap(find.text('Continue with Google'));
    await settle(tester);
    expect(find.textContaining('full for now'), findsOneWidget);
  });

  for (final (refusal, says) in [
    (
      const ApiException(
        status: 401,
        code: 'INVALID_TOKEN',
        message: 'Invalid token',
      ),
      'didn’t accept Google’s sign-in',
    ),
    (
      const ApiException(
        status: 400,
        code: 'CAPTCHA_FAILED',
        message: 'Captcha verification failed',
      ),
      'human check didn’t go through',
    ),
    (
      const ApiException(
        status: 401,
        code: 'OAUTH_LINK_ERROR',
        message: 'unable to create user',
      ),
      'verified email address',
    ),
  ]) {
    testWidgets('a Google sign-in the server refuses with ${refusal.code} '
        'says why, with its code', (tester) async {
      final api = FakeTangentApi()
        ..meAnswers = [unauthorized]
        ..loginOptionsAnswer = withProviders
        ..refuseGoogle = refusal;
      await pumpLogin(tester, api, native: true, googleOnDevice: true);
      await tester.tap(find.text('Solve'));
      await tester.pump();
      await tester.tap(find.text('Continue with Google'));
      await settle(tester);
      expect(find.textContaining(says), findsOneWidget);
      expect(
        find.textContaining(
          'Details: ${refusal.code} (HTTP ${refusal.status})',
        ),
        findsOneWidget,
      );
    });
  }

  testWidgets('no device Google sign-in where it isn\'t offered', (
    tester,
  ) async {
    final api = FakeTangentApi()
      ..meAnswers = [unauthorized]
      ..loginOptionsAnswer = withProviders;
    await pumpLogin(tester, api, native: true);
    expect(find.text('Continue with Google'), findsNothing);
  });

  testWidgets('Google sign-in is hidden everywhere while it is switched off', (
    tester,
  ) async {
    final api = FakeTangentApi()
      ..meAnswers = [unauthorized]
      ..loginOptionsAnswer = withProviders;
    await pumpLogin(tester, api, native: false, googleEnabled: false);
    expect(find.text('Continue with Google'), findsNothing);
    expect(find.text('Continue with GitHub'), findsOneWidget);
  });

  testWidgets('the device offers no Google button while it is switched off', (
    tester,
  ) async {
    final api = FakeTangentApi()
      ..meAnswers = [unauthorized]
      ..loginOptionsAnswer = withProviders;
    await pumpLogin(
      tester,
      api,
      native: true,
      googleOnDevice: true,
      googleEnabled: false,
    );
    expect(find.text('Continue with Google'), findsNothing);
  });

  testWidgets('an iOS build offers no Google sign-in', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    final api = FakeTangentApi()
      ..meAnswers = [unauthorized]
      ..loginOptionsAnswer = withProviders;
    await pumpLogin(
      tester,
      api,
      native: true,
      googleOnDevice: true,
      googleEnabled: null,
    );
    expect(find.text('Continue with Google'), findsNothing);
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('Android offers Google sign-in by default', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    final api = FakeTangentApi()
      ..meAnswers = [unauthorized]
      ..loginOptionsAnswer = withProviders;
    await pumpLogin(
      tester,
      api,
      native: true,
      googleOnDevice: true,
      googleEnabled: null,
    );
    expect(find.text('Continue with Google'), findsOneWidget);
    debugDefaultTargetPlatformOverride = null;
  });

  test('code error messages', () {
    ({String text, bool spent}) of(String code, [int status = 400]) =>
        codeErrorMessage(ApiException(status: status, code: code, message: ''));
    expect(of('INVALID_OTP').spent, isFalse);
    expect(of('OTP_EXPIRED'), (text: 'That code has expired.', spent: true));
    expect(of('TOO_MANY_ATTEMPTS').spent, isTrue);
    expect(of('http_429', 429).text, contains('Wait a minute'));
    expect(of('signups_closed', 403).text, contains('full for now'));
  });

  test('magic link error codes', () {
    expect(loginErrorMessage(null), isNull);
    expect(loginErrorMessage('INVALID_TOKEN'), contains('expired'));
    expect(loginErrorMessage('signups_closed'), contains('full for now'));
    expect(loginErrorMessage('not_allowed'), contains('verified email'));
  });
}
