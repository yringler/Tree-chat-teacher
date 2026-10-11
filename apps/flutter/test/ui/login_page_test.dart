import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/api/models.dart';
import 'package:tangent/state/app_scope.dart';
import 'package:tangent/state/lessons_controller.dart';
import 'package:tangent/state/session_controller.dart';
import 'package:tangent/ui/login_page.dart';

import '../fakes.dart';

/// Turnstile's stand-in: solved by a tap.
Widget fakeCaptcha({
  Key? key,
  required String siteKey,
  required ValueChanged<String?> onToken,
}) => TextButton(
  key: key,
  onPressed: () => onToken('captcha-token'),
  child: const Text('Solve'),
);

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
    final session = SessionController(api);
    final lessons = LessonsController(api: api, session: session);
    await tester.pumpWidget(
      AppScope(
        api: api,
        session: session,
        lessons: lessons,
        child: const MaterialApp(home: LoginPage(captcha: fakeCaptcha)),
      ),
    );
    await settle(tester);

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

    await tester.tap(find.text('Use a different email'));
    await settle(tester);
    expect(find.text('Sign in to Tangent Learn'), findsOneWidget);
    expect(sendButton().onPressed, isNull, reason: 'a token works once');
  });

  test('magic link error codes', () {
    expect(loginErrorMessage(null), isNull);
    expect(loginErrorMessage('INVALID_TOKEN'), contains('expired'));
    expect(loginErrorMessage('signups_closed'), contains('full for now'));
    expect(loginErrorMessage('not_allowed'), contains('verified email'));
  });
}
