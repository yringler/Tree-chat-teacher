import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/api/models.dart';

import '../fakes.dart';

const reply =
    'The **moon** pulls the sea.\n\n'
    '<tangents>\n'
    '- Spring tides — when the sun and moon line up\n'
    '- Tidal locking — why we see one face of the moon\n'
    '</tangents>';

final userNode = node('u1', branch: 'trunk', seq: 0, content: 'Why tides?');
final streamingReply = node(
  'a1',
  branch: 'trunk',
  seq: 1,
  role: Role.assistant,
  status: NodeStatus.streaming,
);
final trunk = branch('trunk', model: 'normal-model');

void main() {
  late FakeTangentApi api;

  setUp(() {
    api = FakeTangentApi()..details['t1'] = treeDetail(title: 'Tides');
  });

  Future<void> type(WidgetTester tester, String text) async {
    await tester.enterText(find.byType(TextField), text);
    await tester.pump();
  }

  Future<void> sendTyped(WidgetTester tester, String text) async {
    await type(tester, text);
    await tester.tap(find.byTooltip('Send'));
    await tester.pump();
  }

  Future<void> emit(WidgetTester tester, StreamEvent event) async {
    api.sends.last.controller.add(event);
    await tester.pump();
    await tester.pump();
  }

  Future<void> start(WidgetTester tester) => emit(
    tester,
    StartEvent(
      userNode: userNode,
      assistantNode: streamingReply,
      branch: trunk,
    ),
  );

  testWidgets('an empty lesson asks what to learn', (tester) async {
    await pumpApp(tester, api, location: '/t/t1');
    expect(find.text('Tides'), findsOneWidget);
    expect(find.text('What would you like to learn?'), findsOneWidget);
  });

  testWidgets('streams a reply, then offers its tangents', (tester) async {
    await pumpApp(tester, api, location: '/t/t1');
    await sendTyped(tester, 'Why tides?');
    expect(api.sends.single.target, 'trunk');
    expect(api.sends.single.content, 'Why tides?');

    await start(tester);
    expect(find.text('Why tides?'), findsOneWidget);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller?.text,
      isEmpty,
    );
    expect(find.byTooltip('Stop'), findsOneWidget);

    await emit(tester, const StatusEvent('Looking it up…'));
    expect(find.text('Looking it up…'), findsOneWidget);

    await emit(
      tester,
      const DeltaEvent(
        nodeId: 'a1',
        text: 'The **moon** pulls the sea.\n\n<tangents>\n- Spr',
      ),
    );
    expect(find.text('Looking it up…'), findsNothing);
    expect(
      find.textContaining('pulls the sea', findRichText: true),
      findsWidgets,
    );
    expect(find.textContaining('tangents', findRichText: true), findsNothing);
    expect(find.text('Where next?'), findsNothing);

    await emit(
      tester,
      DoneEvent(
        node: node(
          'a1',
          branch: 'trunk',
          seq: 1,
          role: Role.assistant,
          content: reply,
        ),
        branch: trunk,
      ),
    );
    await settle(tester);
    expect(find.byTooltip('Send'), findsOneWidget);
    expect(find.text('Where next?'), findsOneWidget);
    expect(find.text('Spring tides'), findsOneWidget);
    expect(find.text('when the sun and moon line up'), findsOneWidget);

    await tester.tap(find.text('Spring tides'));
    await settle(tester);
    expect(api.createdBranches.single.fromNodeId, 'a1');
    expect(api.createdBranches.single.title, 'Spring tides');
    expect(api.sends.last.target, 'side-1');
    expect(api.sends.last.content, 'Spring tides');
    expect(find.text('Main thread'), findsOneWidget);
  });

  testWidgets('a tangent followed before reopens its side question', (
    tester,
  ) async {
    api.details['t1'] = treeDetail(
      title: 'Tides',
      branches: [
        trunk,
        branch('side-9', parent: 'trunk', fork: 'a1', title: 'Spring tides'),
      ],
      nodes: [
        userNode,
        node(
          'a1',
          branch: 'trunk',
          seq: 1,
          role: Role.assistant,
          content: reply,
        ),
        node('s1', branch: 'side-9', seq: 0, content: 'Spring tides'),
      ],
    );
    await pumpApp(tester, api, location: '/t/t1');
    expect(find.text('Main thread'), findsNothing);

    await tester.tap(find.text('Spring tides'));
    await settle(tester);
    expect(api.createdBranches, isEmpty);
    expect(api.sends, isEmpty);
    expect(find.text('Main thread'), findsOneWidget);
    expect(find.text('Side question · Spring tides'), findsOneWidget);

    await tester.tap(find.text('Main thread'));
    await settle(tester);
    expect(find.text('Main thread'), findsNothing);
  });

  testWidgets('a side question asked in its own words is listed and opens', (
    tester,
  ) async {
    api.details['t1'] = treeDetail(
      title: 'Tides',
      branches: [
        trunk,
        branch('side-9', parent: 'trunk', fork: 'a1', title: 'Moon gravity'),
      ],
      nodes: [
        userNode,
        node(
          'a1',
          branch: 'trunk',
          seq: 1,
          role: Role.assistant,
          content: reply,
        ),
        node('s1', branch: 'side-9', seq: 0, content: 'Why does it pull?'),
      ],
    );
    await pumpApp(tester, api, location: '/t/t1');
    expect(find.text('1 side question'), findsOneWidget);

    await tester.tap(find.text('Moon gravity'));
    await settle(tester);
    expect(api.createdBranches, isEmpty);
    expect(find.text('Side question · Moon gravity'), findsOneWidget);
    expect(find.text('Why does it pull?'), findsOneWidget);
  });

  testWidgets('opening a side question shows it from its start', (
    tester,
  ) async {
    final long = List.filled(60, 'The moon pulls the sea.').join('\n\n');
    api.details['t1'] = treeDetail(
      title: 'Tides',
      branches: [
        trunk,
        branch('side-9', parent: 'trunk', fork: 'a1', title: 'Moon gravity'),
      ],
      nodes: [
        userNode,
        node(
          'a1',
          branch: 'trunk',
          seq: 1,
          role: Role.assistant,
          content: long,
        ),
        node('u2', branch: 'trunk', seq: 2, content: 'And the sun?'),
        node(
          'a2',
          branch: 'trunk',
          seq: 3,
          role: Role.assistant,
          content: long,
        ),
        node('s1', branch: 'side-9', seq: 0, content: 'Why does it pull?'),
        node(
          's2',
          branch: 'side-9',
          seq: 1,
          role: Role.assistant,
          content: long,
        ),
      ],
    );
    await pumpApp(tester, api, location: '/t/t1');
    // The chip low on the screen, as after reading down to it.
    final list = find.byType(Scrollable).first;
    await tester.scrollUntilVisible(
      find.text('Moon gravity'),
      -300,
      scrollable: list,
    );
    await tester.ensureVisible(find.text('Moon gravity'));
    final position = tester.state<ScrollableState>(list).position;
    position.jumpTo(position.pixels - 300);
    await tester.pump();
    await tester.tap(find.text('Moon gravity'));
    await settle(tester);

    final top = tester.getRect(list).top;
    expect(
      tester.getTopLeft(find.text('Side question · Moon gravity')).dy,
      inInclusiveRange(top, top + 64),
    );
    expect(find.text('Why does it pull?'), findsOneWidget);
  });

  testWidgets('a long reply is followed until its start reaches the top', (
    tester,
  ) async {
    await pumpApp(tester, api, location: '/t/t1');
    await sendTyped(tester, 'Why tides?');
    await start(tester);
    await emit(tester, const DeltaEvent(nodeId: 'a1', text: 'First line.'));
    for (var i = 0; i < 6; i++) {
      await emit(
        tester,
        DeltaEvent(
          nodeId: 'a1',
          text: List.filled(10, '\n\nThe moon pulls the sea.').join(),
        ),
      );
    }

    final list = tester.getRect(find.byType(Scrollable).first);
    final first = tester.getTopLeft(
      find.textContaining('First line.', findRichText: true).first,
    );
    expect(first.dy, inInclusiveRange(list.top, list.top + 64));
  });

  testWidgets('one tangent shows until the learner asks for more', (
    tester,
  ) async {
    api.details['t1'] = treeDetail(
      title: 'Tides',
      nodes: [
        userNode,
        node(
          'a1',
          branch: 'trunk',
          seq: 1,
          role: Role.assistant,
          content: reply,
        ),
      ],
    );
    await pumpApp(tester, api, location: '/t/t1');
    expect(find.text('Spring tides'), findsOneWidget);
    expect(find.text('Tidal locking'), findsNothing);

    await tester.tap(find.text('1 more'));
    await settle(tester);
    expect(find.text('Tidal locking'), findsOneWidget);
    expect(find.text('1 more'), findsNothing);
  });

  testWidgets('a followed tangent stays in view when the rest are hidden', (
    tester,
  ) async {
    api.details['t1'] = treeDetail(
      title: 'Tides',
      branches: [
        trunk,
        branch('side-9', parent: 'trunk', fork: 'a1', title: 'Tidal locking'),
      ],
      nodes: [
        userNode,
        node(
          'a1',
          branch: 'trunk',
          seq: 1,
          role: Role.assistant,
          content: reply,
        ),
      ],
    );
    await pumpApp(tester, api, location: '/t/t1');
    expect(find.text('Spring tides'), findsOneWidget);
    expect(find.text('Tidal locking'), findsOneWidget);
    expect(find.textContaining('more'), findsNothing);
    expect(find.textContaining('side question'), findsNothing);
  });

  testWidgets('a side question’s divider centres its title in the thread', (
    tester,
  ) async {
    api.details['t1'] = treeDetail(
      title: 'Tides',
      branches: [
        trunk,
        branch('side-9', parent: 'trunk', fork: 'a1', title: 'Spring tides'),
      ],
      nodes: [
        userNode,
        node(
          'a1',
          branch: 'trunk',
          seq: 1,
          role: Role.assistant,
          content: reply,
        ),
        node('s1', branch: 'side-9', seq: 0, content: 'Spring tides'),
      ],
    );
    await pumpApp(tester, api, location: '/t/t1/b/side-9');
    final title = find.text('Side question · Spring tides');
    final thread = tester.getRect(find.byType(Scrollable).first);
    expect(tester.getCenter(title).dx, closeTo(thread.center.dx, 1));
  });

  /// Tides, with Spring tides › Moon gravity › Neap tides under its first
  /// reply and The sun under its second.
  TreeDetail nestedLesson({String trunkReply = 'Tides rise and fall.'}) =>
      treeDetail(
        title: 'Tides',
        branches: [
          trunk,
          branch('tides', parent: 'trunk', fork: 'a1', title: 'Spring tides'),
          branch('moon', parent: 'tides', fork: 's1', title: 'Moon gravity'),
          branch('neap', parent: 'moon', fork: 'm1', title: 'Neap tides'),
          branch('sun', parent: 'trunk', fork: 'a2', title: 'The sun'),
        ],
        nodes: [
          userNode,
          node(
            'a1',
            branch: 'trunk',
            seq: 1,
            role: Role.assistant,
            content: trunkReply,
          ),
          node('u2', branch: 'trunk', seq: 2, content: 'And the sun?'),
          node(
            'a2',
            branch: 'trunk',
            seq: 3,
            role: Role.assistant,
            content: trunkReply,
          ),
          node('s1', branch: 'tides', seq: 0, content: 'Why spring?'),
          node('m1', branch: 'moon', seq: 0, content: 'How strong?'),
          node('n1', branch: 'neap', seq: 0, content: 'And neap?'),
          node('o1', branch: 'sun', seq: 0, content: 'How far?'),
        ],
      );

  Finder crumb(String text) => find.descendant(
    of: find.byKey(const ValueKey('breadcrumb')),
    matching: find.text(text),
  );

  testWidgets('a nested side question’s path shows the main thread and its '
      'parent', (tester) async {
    api.details['t1'] = nestedLesson();
    await pumpApp(tester, api, location: '/t/t1/b/neap');
    expect(crumb('Main thread'), findsOneWidget);
    expect(crumb('…'), findsOneWidget);
    expect(crumb('Spring tides'), findsNothing);
    expect(crumb('Moon gravity'), findsOneWidget);
    expect(crumb('Neap tides'), findsOneWidget);

    await tester.tap(crumb('Moon gravity'));
    await settle(tester);
    expect(crumb('…'), findsNothing);
    expect(crumb('Spring tides'), findsOneWidget);
    expect(crumb('Moon gravity'), findsOneWidget);
    expect(crumb('Neap tides'), findsNothing);
  });

  testWidgets('the outline lists every side question and opens one', (
    tester,
  ) async {
    api.details['t1'] = nestedLesson();
    await pumpApp(tester, api, location: '/t/t1/b/neap');
    await tester.tap(find.byTooltip('Side questions'));
    await settle(tester);
    final drawer = find.byType(Drawer);
    for (final title in [
      'Main thread',
      'Spring tides',
      'Moon gravity',
      'Neap tides',
      'The sun',
    ]) {
      expect(
        find.descendant(of: drawer, matching: find.text(title)),
        findsOneWidget,
      );
    }

    await tester.tap(
      find.descendant(of: drawer, matching: find.text('The sun')),
    );
    await settle(tester);
    expect(drawer, findsNothing);
    expect(crumb('The sun'), findsOneWidget);
    expect(find.text('How far?'), findsOneWidget);
  });

  testWidgets('a lesson without side questions has no outline', (tester) async {
    api.details['t1'] = treeDetail(title: 'Tides', nodes: [userNode]);
    await pumpApp(tester, api, location: '/t/t1');
    expect(find.byTooltip('Side questions'), findsNothing);
  });

  testWidgets('on a wide screen the outline stays beside the thread', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    api.details['t1'] = nestedLesson();
    await pumpApp(tester, api, location: '/t/t1/b/moon');
    expect(find.byTooltip('Side questions'), findsNothing);
    final panel = find.byKey(const ValueKey('outline'));
    expect(
      find.descendant(of: panel, matching: find.text('The sun')),
      findsOneWidget,
    );

    await tester.tap(
      find.descendant(of: panel, matching: find.text('The sun')),
    );
    await settle(tester);
    expect(crumb('The sun'), findsOneWidget);
  });

  testWidgets('the header hides while reading down and returns on the way '
      'up', (tester) async {
    final long = List.filled(60, 'The moon pulls the sea.').join('\n\n');
    api.details['t1'] = nestedLesson(trunkReply: long);
    await pumpApp(tester, api, location: '/t/t1/b/tides');
    final list = find.byType(Scrollable).first;
    final shownTop = tester.getRect(list).top;
    expect(shownTop, greaterThan(0));

    await tester.drag(list, const Offset(0, -200));
    await settle(tester);
    expect(tester.getRect(list).top, 0);

    await tester.drag(list, const Offset(0, 100));
    await settle(tester);
    expect(tester.getRect(list).top, shownTop);
  });

  testWidgets('a refusal from the pool shows why and keeps the text', (
    tester,
  ) async {
    api.refuseSend = const ApiException(
      status: 402,
      code: 'pool_empty',
      message: 'The pool is empty',
      poolReason: 'empty',
    );
    await pumpApp(tester, api, location: '/t/t1');
    await sendTyped(tester, 'Why tides?');
    await settle(tester);
    expect(
      find.text('The open pool is empty until Tangent adds more credit.'),
      findsOneWidget,
    );
    expect(find.text('How the pool works'), findsOneWidget);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller?.text,
      'Why tides?',
    );
  });

  testWidgets('Stop cancels the reply being written', (tester) async {
    await pumpApp(tester, api, location: '/t/t1');
    await sendTyped(tester, 'Why tides?');
    await start(tester);
    await tester.tap(find.byTooltip('Stop'));
    await tester.pump();
    expect(api.cancelled, ['a1']);

    await emit(
      tester,
      ErrorEvent(
        nodeId: 'a1',
        message: 'Stopped',
        node: node(
          'a1',
          branch: 'trunk',
          seq: 1,
          role: Role.assistant,
          status: NodeStatus.error,
          errorKind: 'cancelled',
        ),
      ),
    );
    await settle(tester);
    expect(find.textContaining('Stopped.', findRichText: true), findsOneWidget);
    expect(find.byTooltip('Send'), findsOneWidget);
  });

  testWidgets('a reply still being written is resumed on open', (tester) async {
    api.details['t1'] = treeDetail(
      title: 'Tides',
      nodes: [userNode, streamingReply],
    );
    await pumpApp(tester, api, location: '/t/t1');
    expect(api.resumes.single.target, 'a1');

    api.resumes.single.controller.add(
      SnapshotEvent(streamingReply.copyWith(content: 'The moon')),
    );
    await settle(tester);
    expect(find.textContaining('The moon', findRichText: true), findsWidgets);
  });

  testWidgets('Normal/Max switches the branch’s model', (tester) async {
    await pumpApp(tester, api, location: '/t/t1');
    await tester.tap(find.text('Max'));
    await settle(tester);
    expect(api.modelSwitches.single.branchId, 'trunk');
    expect(api.modelSwitches.single.model, 'max-model');
  });

  testWidgets('a signed-out session goes back to sign-in', (tester) async {
    api.refuseSend = unauthorized;
    await pumpApp(tester, api, location: '/t/t1');
    await sendTyped(tester, 'Why tides?');
    await settle(tester);
    expect(find.text('Sign in to Tangent Learn'), findsOneWidget);
  });

  testWidgets('an unknown lesson can’t be opened', (tester) async {
    await pumpApp(tester, api, location: '/t/nope');
    expect(find.text('Can’t open this lesson'), findsOneWidget);
  });
}
