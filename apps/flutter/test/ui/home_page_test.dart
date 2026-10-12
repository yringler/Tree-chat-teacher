import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/api/models.dart';

import '../fakes.dart';

void main() {
  late FakeTangentApi api;

  setUp(() {
    api = FakeTangentApi()
      ..treesAnswer = [
        TreeSummary(
          id: 't1',
          title: 'Why the sky is blue',
          updatedAt: DateTime.now().subtract(const Duration(minutes: 5)),
          branchCount: 3,
        ),
        TreeSummary(
          id: 't2',
          title: 'New conversation',
          updatedAt: DateTime.now(),
          branchCount: 1,
        ),
      ];
  });

  testWidgets('lists the lessons', (tester) async {
    await pumpApp(tester, api);
    expect(find.text('Why the sky is blue'), findsOneWidget);
    expect(find.text('5 min ago · 2 tangents'), findsOneWidget);
    expect(find.text('New lesson'), findsNWidgets(2), reason: 'card and row');
    expect(api.payerSet, Payer.credit);
  });

  testWidgets('an empty list says so', (tester) async {
    api.treesAnswer = [];
    await pumpApp(tester, api);
    expect(find.text('No lessons yet. Start one above.'), findsOneWidget);
  });

  testWidgets('starts a lesson on the picked tier with its topic', (
    tester,
  ) async {
    await pumpApp(tester, api);
    await tester.enterText(
      find.widgetWithText(TextField, 'Topic or first question'),
      'Tides',
    );
    await tester.tap(find.text('Max'));
    await tester.pump();
    await tester.tap(find.text('Start lesson'));
    await settle(tester);

    expect(api.createdTrees.single.providerId, 'openrouter');
    expect(api.createdTrees.single.model, 'max-model');
    expect(api.sends.single.target, 'trunk');
    expect(api.sends.single.content, 'Tides');
    expect(find.text('Start lesson'), findsNothing, reason: 'on the chat');
  });

  testWidgets('Start lesson sits at the end of its row', (tester) async {
    await pumpApp(tester, api);
    final button = find.ancestor(
      of: find.text('Start lesson'),
      matching: find.byWidgetPredicate((w) => w is ButtonStyleButton),
    );
    final topic = find.widgetWithText(TextField, 'Topic or first question');
    expect(tester.getTopRight(button).dx, tester.getTopRight(topic).dx);
  });

  testWidgets('on the pool there is no tier to pick', (tester) async {
    api.poolStatusAnswer = const PoolStatus(enabled: true, modelLabel: 'M');
    await pumpApp(tester, api);
    expect(api.payerSet, Payer.pool);
    expect(find.text('The open pool uses one model'), findsOneWidget);
    expect(find.text('Max'), findsNothing);
  });

  testWidgets('deletes a lesson after asking', (tester) async {
    await pumpApp(tester, api);
    await tester.tap(find.byTooltip('Delete Why the sky is blue'));
    await settle(tester);
    expect(
      find.text(
        'Delete the lesson “Why the sky is blue” with all its tangents?',
      ),
      findsOneWidget,
    );
    await tester.tap(find.text('Delete'));
    await settle(tester);
    expect(api.deletedTrees, ['t1']);
    expect(find.text('Why the sky is blue'), findsNothing);
  });

  group('how replies are paid for', () {
    Future<void> open(WidgetTester tester) async {
      await tester.tap(find.byTooltip('Account'));
      await settle(tester);
      await tester.tap(find.text('How replies are paid for'));
      await settle(tester);
    }

    testWidgets('saves an OpenRouter key and replies run on it', (
      tester,
    ) async {
      api.poolStatusAnswer = const PoolStatus(enabled: true, modelLabel: 'M');
      await pumpApp(tester, api);
      expect(api.payerSet, Payer.pool);
      await open(tester);
      await tester.tap(find.text('Use my own OpenRouter key'));
      await settle(tester);
      expect(find.text('No key saved.'), findsOneWidget);

      await tester.enterText(
        find.widgetWithText(TextField, 'Your OpenRouter API key'),
        ' sk-or-1 ',
      );
      await tester.ensureVisible(find.text('Save key'));
      await tester.tap(find.text('Save key'));
      await settle(tester);
      expect(api.savedKeys, ['sk-or-1']);
      expect(find.text('Your OpenRouter key is saved.'), findsOneWidget);
      expect(api.payerSet, Payer.ownKey);

      await tester.ensureVisible(find.text('Forget'));
      await tester.tap(find.text('Forget'));
      await settle(tester);
      expect(find.text('No key saved.'), findsOneWidget);
    });

    testWidgets('a rejected key says why', (tester) async {
      api.refuseKey = const ApiException(
        status: 400,
        code: 'bad_request',
        message: 'OpenRouter rejected this API key',
      );
      await pumpApp(tester, api);
      await open(tester);
      await tester.tap(find.text('Use my own OpenRouter key'));
      await settle(tester);
      await tester.enterText(find.byType(TextField).last, 'sk-or-bad');
      await tester.ensureVisible(find.text('Save key'));
      await tester.tap(find.text('Save key'));
      await settle(tester);
      expect(find.text('OpenRouter rejected this API key'), findsOneWidget);
    });

    testWidgets('without the membership it needs, the own key is locked', (
      tester,
    ) async {
      api.meAnswers = [
        const Me(
          userId: 'u1',
          email: 'ada@example.com',
          devMode: false,
          builtInCredit: true,
          membershipMissing: true,
        ),
      ];
      await pumpApp(tester, api);
      await open(tester);
      final own = find.widgetWithText(
        RadioListTile<Payer>,
        'Use my own OpenRouter key',
      );
      expect(tester.widget<RadioListTile<Payer>>(own).enabled, isFalse);
      expect(find.textContaining('Needs a membership'), findsOneWidget);
      expect(find.byType(TextField), findsOneWidget, reason: 'topic only');
    });
  });

  testWidgets('signs out from the account menu', (tester) async {
    await pumpApp(tester, api);
    await tester.tap(find.byTooltip('Account'));
    await settle(tester);
    expect(find.text('ada@example.com'), findsOneWidget);
    await tester.tap(find.text('Sign out'));
    await settle(tester);
    expect(api.signedOut, isTrue);
    expect(find.text('Sign in to Tangent Learn'), findsOneWidget);
  });

  testWidgets(
    'deletes the account from the account menu once the email is typed',
    (tester) async {
      await pumpApp(tester, api);
      await tester.tap(find.byTooltip('Account'));
      await settle(tester);
      await tester.tap(find.text('Delete account'));
      await settle(tester);
      final delete = find.widgetWithText(FilledButton, 'Delete my account');
      expect(tester.widget<FilledButton>(delete).onPressed, isNull);

      await tester.enterText(find.byType(TextField).last, ' Ada@Example.com ');
      await tester.pump();
      await tester.tap(delete);
      await settle(tester);
      expect(api.deletedAccounts, ['Ada@Example.com']);
      expect(find.text('Sign in to Tangent Learn'), findsOneWidget);
    },
  );

  testWidgets('a refused deletion stays open and says why', (tester) async {
    api.refuseDeleteAccount = const ApiException(
      status: 500,
      code: 'internal',
      message: "Couldn't cancel your billing",
    );
    await pumpApp(tester, api);
    await tester.tap(find.byTooltip('Account'));
    await settle(tester);
    await tester.tap(find.text('Delete account'));
    await settle(tester);
    await tester.enterText(find.byType(TextField).last, 'ada@example.com');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Delete my account'));
    await settle(tester);
    expect(find.text("Couldn't cancel your billing"), findsOneWidget);
    expect(find.text('Sign in to Tangent Learn'), findsNothing);
  });
}
