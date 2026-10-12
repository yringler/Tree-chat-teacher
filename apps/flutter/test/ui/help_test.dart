import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/api/models.dart';
import 'package:tangent/ui/help.dart';
import 'package:tangent/ui/tangent_help_copy.dart';

import '../fakes.dart';

void main() {
  late FakeTangentApi api;

  setUp(() {
    api = FakeTangentApi()
      ..details['t1'] = treeDetail(
        title: 'Tides',
        nodes: [
          node('u1', branch: 'trunk', seq: 0, content: 'Why tides?'),
          node(
            'a1',
            branch: 'trunk',
            seq: 1,
            role: Role.assistant,
            content: 'The moon pulls the sea.',
          ),
        ],
      );
  });

  void expectHelp() {
    Finder inHelp(String text) => find.descendant(
      of: find.byType(TangentHelp),
      matching: find.text(text),
    );
    for (final text in [
      helpTitle,
      helpRule,
      for (final item in helpItems) ...[item.label, item.text],
      helpDefault.label,
      helpTest,
      helpAnalogy,
    ]) {
      expect(inHelp(text), findsOneWidget, reason: text);
    }
  }

  testWidgets('the "?" on the lessons opens the help', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await pumpApp(tester, api);
    await tester.tap(find.byTooltip(helpTitle));
    await tester.pumpAndSettle();
    expectHelp();
    expect(find.byType(BottomSheet), findsOneWidget, reason: 'a phone');
  });

  testWidgets('the "?" in a lesson opens the help', (tester) async {
    await pumpApp(tester, api, location: '/t/t1');
    await tester.tap(find.byTooltip(helpTitle));
    await settle(tester);
    expectHelp();
  });

  testWidgets('a wide screen shows it as a dialog', (tester) async {
    tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await pumpApp(tester, api);
    await tester.tap(find.byTooltip(helpTitle));
    await tester.pumpAndSettle();
    expect(find.byType(Dialog), findsOneWidget);
    expect(find.text(helpRule), findsOneWidget);
  });

  testWidgets('replay starts the walkthrough over, from step 1', (
    tester,
  ) async {
    await pumpApp(tester, api, location: '/t/t1');
    expect(find.text(walkthroughSteps.tangent), findsNothing, reason: 'done');

    await tester.tap(find.byTooltip(helpTitle));
    await settle(tester);
    await tester.ensureVisible(find.text(helpReplay));
    await tester.tap(find.text(helpReplay));
    await settle(tester);
    expect(find.text(helpTitle), findsNothing, reason: 'closed');
    expect(find.text(walkthroughSteps.tangent), findsOneWidget);
    expect(api.walkthroughDoneMarks, 0);
  });
}
