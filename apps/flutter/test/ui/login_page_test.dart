import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/api/models.dart';
import 'package:tangent/state/app_scope.dart';
import 'package:tangent/state/lessons_controller.dart';
import 'package:tangent/state/session_controller.dart';
import 'package:tangent/state/walkthrough_controller.dart';
import 'package:tangent/ui/login_page.dart';

import '../fakes.dart';

/// The sign-in page alone, over [api]; returns its session.
Future<SessionController> pumpLogin(
  WidgetTester tester,
  FakeTangentApi api, {
  required bool native,
}) async {
  final session = SessionController(api);
  final lessons = LessonsController(api: api, session: session);
  await tester.pumpWidget(
    AppScope(
      api: api,
      session: session,
      lessons: lessons,
      walkthrough: WalkthroughController(api: api, session: session),
      child: MaterialApp(
        home: LoginPage(captcha: fakeCaptcha, native: native),
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
