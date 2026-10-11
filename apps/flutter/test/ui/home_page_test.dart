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
    expect(find.text('5 min ago · 2 side questions'), findsOneWidget);
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
        'Delete the lesson “Why the sky is blue” with all its side questions?',
      ),
      findsOneWidget,
    );
    await tester.tap(find.text('Delete'));
    await settle(tester);
    expect(api.deletedTrees, ['t1']);
    expect(find.text('Why the sky is blue'), findsNothing);
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
}
