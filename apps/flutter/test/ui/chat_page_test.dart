import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/api/models.dart';
import 'package:tangent/ui/message_view.dart';
import 'package:tangent/ui/tangent_help_copy.dart';
import 'package:tangent/ui/theme.dart';

import '../fakes.dart';

const reply =
    'The **moon** pulls the sea.\n\n'
    '<tangents>\n'
    '- Spring tides — when the sun and moon line up\n'
    '- Tidal locking — why we see one face of the moon\n'
    '</tangents>';

/// A reply whose suggestions carry their kind.
const taggedReply =
    'The **moon** pulls the sea.\n\n'
    '<tangents>\n'
    '- [deeper] Neap tides — the other half of the month\n'
    '- [tangent] Tidal locking — why we see one face of the moon\n'
    '</tangents>';

/// A reply with four suggested tangents.
const longReply =
    'The **moon** pulls the sea.\n\n'
    '<tangents>\n'
    '- Spring tides — when the sun and moon line up\n'
    '- Tidal locking — why we see one face of the moon\n'
    '- Neap tides — the weak ones between\n'
    '- Tidal bulges — the shape the pull makes\n'
    '</tangents>';

final userNode = node('u1', branch: 'trunk', seq: 0, content: 'Why tides?');

/// The finished first reply, saying [content].
ChatNode answer(String content) =>
    node('a1', branch: 'trunk', seq: 1, role: Role.assistant, content: content);

final streamingReply = node(
  'a1',
  branch: 'trunk',
  seq: 1,
  role: Role.assistant,
  status: NodeStatus.streaming,
);
final trunk = branch('trunk');

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

  /// The message box's button labelled [label], not a reply's own
  /// Tangent ↳.
  Finder action(String label) => find.descendant(
    of: find.byKey(const ValueKey('composer-actions')),
    matching: find.text(label),
  );

  /// Message [id] of the thread.
  Finder message(String id) =>
      find.byWidgetPredicate((w) => w is MessageView && w.node.id == id);

  /// A reply's own Tangent ↳, in its header.
  Finder replyTangent(String id) => find.descendant(
    of: message(id),
    matching: find.byTooltip('Go on a tangent about this message'),
  );

  /// Types [text] and sends it with the action labelled [label].
  Future<void> sendAs(WidgetTester tester, String label, String text) async {
    await type(tester, text);
    await tester.tap(action(label));
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
    expect(find.text(suggestedTangentsLabel), findsNothing);
    // Its own Tangent ↳ waits for the whole reply.
    expect(replyTangent('a1').hitTestable(), findsNothing);
    expect(find.bySemanticsLabel(tangentAction.label), findsNothing);

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
    expect(replyTangent('a1').hitTestable(), findsOneWidget);
    expect(find.bySemanticsLabel(tangentAction.label), findsOneWidget);
    expect(action(tangentAction.label), findsOneWidget);
    expect(action(replyAction.label), findsOneWidget);
    expect(find.text(suggestedTangentsLabel), findsOneWidget);
    expect(find.text('Spring tides'), findsOneWidget);
    expect(find.text('when the sun and moon line up'), findsOneWidget);
    expect(
      find.bySemanticsLabel(RegExp('^Start a tangent: Spring tides')),
      findsOne,
    );

    await tester.tap(find.text('Spring tides'));
    await settle(tester);
    expect(api.createdBranches.single.fromNodeId, 'a1');
    expect(api.createdBranches.single.title, 'Spring tides');
    expect(api.sends.last.target, 'side-1');
    expect(api.sends.last.content, 'Spring tides');
    expect(find.text('Main thread'), findsOneWidget);
  });

  testWidgets(
    'a reply’s text stays put as the reply finishes and gains its Tangent ↳',
    (tester) async {
      await pumpApp(tester, api, location: '/t/t1');
      await sendTyped(tester, 'Why tides?');
      await start(tester);
      await emit(
        tester,
        const DeltaEvent(nodeId: 'a1', text: 'The **moon** pulls the sea.'),
      );
      final text = find
          .descendant(
            of: message('a1'),
            matching: find.textContaining('pulls the sea', findRichText: true),
          )
          .first;
      double below() =>
          tester.getTopLeft(text).dy - tester.getTopLeft(message('a1')).dy;
      final streaming = below();

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
      expect(replyTangent('a1'), findsOneWidget);
      expect(below(), streaming);
    },
    variant: const TargetPlatformVariant({
      TargetPlatform.android,
      TargetPlatform.linux,
    }),
  );

  testWidgets('a tangent asked in its own words is listed and opens', (
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
    expect(find.text(yourTangentsLabel), findsOneWidget);
    // The heading is a node of its own: merged into the reply's, it would
    // make the whole reply a header.
    expect(
      tester.getSemantics(find.text(yourTangentsLabel)),
      isSemantics(isHeader: true, label: yourTangentsLabel),
    );
    expect(find.bySemanticsLabel('Open tangent: Moon gravity'), findsOne);
    // Its tip is only its title, which the label already says.
    expect(
      tester.getSemantics(find.bySemanticsLabel('Open tangent: Moon gravity')),
      isSemantics(tooltip: ''),
    );

    await tester.tap(find.text('Moon gravity'));
    await settle(tester);
    expect(api.createdBranches, isEmpty);
    expect(find.text('Tangent · Moon gravity'), findsOneWidget);
    expect(find.text('Why does it pull?'), findsOneWidget);
  });

  testWidgets('opening a tangent shows it from its start', (tester) async {
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
    // The row low on the screen, as after reading down to it.
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
      tester.getTopLeft(find.text('Tangent · Moon gravity')).dy,
      inInclusiveRange(top, top + 64),
    );
    expect(find.text('Why does it pull?'), findsOneWidget);
  });

  testWidgets('a message is deleted once the learner says so; a deleted '
      'tangent leaves the screen', (tester) async {
    api.details['t1'] = treeDetail(
      title: 'Tides',
      branches: [
        trunk,
        branch('side', parent: 'trunk', fork: 'a1', title: 'Moon gravity'),
      ],
      nodes: [
        userNode,
        answer('The moon pulls the sea.'),
        node('s1', branch: 'side', seq: 0, content: 'Why does it pull?'),
      ],
    );
    api.deleteAnswer = const DeletedMessages(
      branchIds: ['side'],
      nodeIds: ['s1'],
    );
    await pumpApp(tester, api, location: '/t/t1/b/side');

    await tester.tap(find.byTooltip('Delete message').last);
    await settle(tester);
    expect(
      find.text(
        'Delete this message? It starts the tangent “Moon gravity”, which '
        'goes with it (1 message). Replies still being written there are '
        'stopped. This cannot be undone.',
      ),
      findsOneWidget,
    );
    await tester.tap(find.text('Cancel'));
    await settle(tester);
    expect(api.deletedMessages, isEmpty);

    await tester.tap(find.byTooltip('Delete message').last);
    await settle(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
    await settle(tester);
    expect(api.deletedMessages, ['s1']);
    expect(find.text('Why does it pull?'), findsNothing);
    expect(find.text('Tangent · Moon gravity'), findsNothing);
    expect(find.text('Why tides?'), findsOneWidget);
  });

  testWidgets('every tangent from a reply opens at its start', (tester) async {
    final long = List.filled(60, 'The moon pulls the sea.').join('\n\n');
    ChatNode answer(String id, String branchId) => node(
      id,
      branch: branchId,
      seq: 1,
      role: Role.assistant,
      content: '$long\n\n$reply',
    );
    api.details['t1'] = treeDetail(
      title: 'Tides',
      branches: [
        trunk,
        branch('spring', parent: 'trunk', fork: 'a1', title: 'Spring tides'),
        branch('locking', parent: 'trunk', fork: 'a1', title: 'Tidal locking'),
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
        node('s1', branch: 'spring', seq: 0, content: 'Spring tides'),
        answer('s2', 'spring'),
        node('l1', branch: 'locking', seq: 0, content: 'Tidal locking'),
        answer('l2', 'locking'),
      ],
    );
    await pumpApp(tester, api, location: '/t/t1');
    final list = find.byType(Scrollable).first;

    for (final title in ['Spring tides', 'Tidal locking']) {
      await tester.tap(find.text(title));
      await settle(tester);
      final top = tester.getRect(list).top;
      expect(
        tester.getTopLeft(find.text('Tangent · $title')).dy,
        inInclusiveRange(top, top + 64),
        reason: title,
      );
      await tester.tap(find.text('Main thread'));
      await settle(tester);
    }
  });

  group('the composer', () {
    final answered = node(
      'a1',
      branch: 'trunk',
      seq: 1,
      role: Role.assistant,
      content: reply,
    );

    String? hint(WidgetTester tester) =>
        tester.widget<TextField>(find.byType(TextField)).decoration?.hintText;

    final long = List.filled(60, 'The moon pulls the sea.').join('\n\n');

    /// The tangent Moon from a1, with two questions and their long replies:
    /// the second is out of view as the tangent opens, and at the end the
    /// first is far above.
    TreeDetail twoStepTangent() => treeDetail(
      title: 'Tides',
      branches: [
        trunk,
        branch('side-9', parent: 'trunk', fork: 'a1', title: 'Moon'),
      ],
      nodes: [
        userNode,
        answered,
        node('s1', branch: 'side-9', seq: 0, content: 'Why the moon?'),
        node(
          's2',
          branch: 'side-9',
          seq: 1,
          role: Role.assistant,
          content: 'Gravity pulls the near side.\n\n$long',
        ),
        node('s3', branch: 'side-9', seq: 2, content: 'And the far side?'),
        node(
          's4',
          branch: 'side-9',
          seq: 3,
          role: Role.assistant,
          content: 'Inertia.\n\n$long',
        ),
      ],
    );

    ScrollPosition thread(WidgetTester tester) =>
        tester.state<ScrollableState>(find.byType(Scrollable).first).position;

    /// The box naming the reply its tangent starts from.
    final named = find.byKey(const ValueKey('composer-target'));

    testWidgets('offers Tangent and Next after a reply, not Send', (
      tester,
    ) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        nodes: [userNode, answered],
      );
      await pumpApp(tester, api, location: '/t/t1');
      expect(action(tangentAction.label), findsOneWidget);
      expect(action(replyAction.label), findsOneWidget);
      expect(find.bySemanticsLabel('Send as tangent'), findsOneWidget);
      expect(find.bySemanticsLabel('Send as next message'), findsOneWidget);
      expect(find.byTooltip('Send'), findsNothing);
      // Equally wide, the tangent first.
      final tangent = tester.getRect(find.byType(FilledButton));
      final next = tester.getRect(find.byType(OutlinedButton));
      expect(tangent.width, closeTo(next.width, 0.5));
      expect(tangent.left, lessThan(next.left));
    });

    testWidgets('an empty lesson offers only Send', (tester) async {
      await pumpApp(tester, api, location: '/t/t1');
      expect(find.byTooltip('Send'), findsOneWidget);
      expect(find.text(tangentAction.label), findsNothing);
      expect(find.text(replyAction.label), findsNothing);
    });

    testWidgets('the actions say when to pick each', (tester) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        nodes: [userNode, answered],
      );
      await pumpApp(tester, api, location: '/t/t1');
      expect(find.byTooltip(tangentAction.hint), findsOneWidget);
      expect(find.byTooltip(replyAction.hint), findsOneWidget);
    });

    testWidgets('in a tangent, Next is filled and keeps the tangent moving', (
      tester,
    ) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        branches: [
          trunk,
          branch('side-9', parent: 'trunk', fork: 'a1', title: 'Moon'),
        ],
        nodes: [
          userNode,
          answered,
          node('s1', branch: 'side-9', seq: 0, content: 'Why the moon?'),
          node(
            's2',
            branch: 'side-9',
            seq: 1,
            role: Role.assistant,
            content: 'Gravity.',
          ),
        ],
      );
      await pumpApp(tester, api, location: '/t/t1/b/side-9');
      expect(find.byTooltip(replyAction.hintInTangent), findsOneWidget);
      expect(find.byTooltip(replyAction.hint), findsNothing);
      // Only the fill moves: the tangent stays first.
      final next = find.widgetWithText(FilledButton, replyAction.label);
      final tangent = find.widgetWithText(OutlinedButton, tangentAction.label);
      expect(next, findsOneWidget);
      expect(tangent, findsOneWidget);
      expect(tester.getRect(tangent).left, lessThan(tester.getRect(next).left));

      await sendAs(tester, replyAction.label, 'And the sun?');
      expect(api.createdBranches, isEmpty);
      expect(api.sends.single.target, 'side-9');
    });

    testWidgets('in a tangent with a reply, the hint names the tangent', (
      tester,
    ) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        branches: [
          trunk,
          branch('side-9', parent: 'trunk', fork: 'a1', title: 'Moon'),
        ],
        nodes: [
          userNode,
          answered,
          node('s1', branch: 'side-9', seq: 0, content: 'Why the moon?'),
          node(
            's2',
            branch: 'side-9',
            seq: 1,
            role: Role.assistant,
            content: 'Gravity.',
          ),
        ],
      );
      await pumpApp(tester, api, location: '/t/t1/b/side-9');
      expect(hint(tester), 'Ask anything in this tangent…');
    });

    testWidgets('Tangent goes on a tangent from the last reply', (
      tester,
    ) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        nodes: [userNode, answered],
      );
      await pumpApp(tester, api, location: '/t/t1');
      expect(hint(tester), 'Ask anything…');

      await sendAs(tester, tangentAction.label, 'Why the moon?');
      await settle(tester);
      expect(api.createdBranches.single.fromNodeId, 'a1');
      expect(api.createdBranches.single.title, isNull);
      expect(api.createdBranches.single.anchorQuote, isNull);
      expect(api.sends.single.target, 'side-1');
      expect(api.sends.single.content, 'Why the moon?');
      expect(find.text('Main thread'), findsOneWidget);
    });

    testWidgets('a tangent opened at its start goes on a tangent from its '
        'first reply', (tester) async {
      api.details['t1'] = twoStepTangent();
      await pumpApp(tester, api, location: '/t/t1/b/side-9');
      await sendAs(tester, tangentAction.label, 'Why the near side?');
      await settle(tester);
      expect(api.createdBranches.single.fromNodeId, 's2');
    });

    testWidgets('after a jump to the end, it goes on a tangent from the last '
        'reply', (tester) async {
      api.details['t1'] = twoStepTangent();
      await pumpApp(tester, api, location: '/t/t1/b/side-9');
      await tester.tap(find.byTooltip(jumpToEnd));
      await settle(tester);
      await sendAs(tester, tangentAction.label, 'Why inertia?');
      await settle(tester);
      expect(api.createdBranches.single.fromNodeId, 's4');
    });

    testWidgets('the open box names the reply its tangent starts from when it '
        'isn’t the last, and a tap shows it', (tester) async {
      api.details['t1'] = twoStepTangent();
      await pumpApp(tester, api, location: '/t/t1/b/side-9');
      expect(named, findsNothing);
      // Read down to the end, past the first reply.
      final position = thread(tester);
      position.jumpTo(position.maxScrollExtent);
      await settle(tester);

      await tester.tap(find.byType(TextField));
      await tester.pump();
      expect(named, findsOneWidget);
      // Its opening words, as many as the web shows.
      expect(
        find.text(
          'from “Gravity pulls the near side. The moon pulls the sea. The mo…”',
        ),
        findsOneWidget,
      );

      await tester.tap(named);
      await settle(tester);
      final top = tester.getRect(find.byType(Scrollable).first).top;
      final start = find.descendant(
        of: find.byType(MessageView),
        matching: find.textContaining(
          'Gravity pulls the near side.',
          findRichText: true,
        ),
      );
      expect(tester.getTopLeft(start).dy, inInclusiveRange(top, top + 64));
      // The box keeps the focus, and with it a phone's keyboard.
      expect(
        tester.widget<TextField>(find.byType(TextField)).focusNode?.hasFocus,
        isTrue,
      );
    });

    testWidgets('the box names the last reply only while the end is out of '
        'view, deciding as it takes the focus', (tester) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        nodes: [userNode, answer(long)],
      );
      await pumpApp(tester, api, location: '/t/t1');
      await tester.tap(find.byType(TextField));
      await tester.pump();
      expect(named, findsNothing);

      // Read back up while the box keeps the focus: it stays as it was.
      thread(tester).jumpTo(0);
      await settle(tester);
      expect(named, findsNothing);

      // Back in the box after reading up.
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pump();
      await tester.tap(find.byType(TextField));
      await tester.pump();
      expect(named, findsOneWidget);
    });

    testWidgets('a reply put on the open box and taken off again leaves '
        'nothing named until the box opens again', (tester) async {
      api.details['t1'] = twoStepTangent();
      await pumpApp(tester, api, location: '/t/t1/b/side-9');
      await tester.tap(find.byType(TextField));
      await tester.pump();
      expect(named, findsOneWidget);

      await tester.tap(replyTangent('s2'));
      await tester.pump();
      expect(find.byKey(const ValueKey('composer-quote')), findsOneWidget);
      expect(named, findsNothing);
      await tester.tap(find.byTooltip('Don’t go on this tangent'));
      await tester.pump();
      expect(
        tester.widget<TextField>(find.byType(TextField)).focusNode?.hasFocus,
        isTrue,
      );
      expect(named, findsNothing);

      // Opened again, it names the reply Tangent ↳ goes from.
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pump();
      await tester.tap(find.byType(TextField));
      await tester.pump();
      expect(named, findsOneWidget);
    });

    testWidgets('Next replies on the branch on screen', (tester) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        nodes: [userNode, answered],
      );
      await pumpApp(tester, api, location: '/t/t1');
      await sendAs(tester, replyAction.label, 'And the sun?');
      expect(api.createdBranches, isEmpty);
      expect(api.sends.single.target, 'trunk');
      expect(api.sends.single.content, 'And the sun?');
    });

    testWidgets('after a failed reply, continues with nothing to choose', (
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
            status: NodeStatus.error,
          ),
        ],
      );
      await pumpApp(tester, api, location: '/t/t1');
      expect(find.bySemanticsLabel(RegExp('Send as')), findsNothing);
      expect(find.byTooltip('Send'), findsOneWidget);
      expect(hint(tester), 'Ask anything…');
    });

    testWidgets('"Ask about this" on selected words asks about them', (
      tester,
    ) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        nodes: [userNode, answered],
      );
      await pumpApp(tester, api, location: '/t/t1');
      await tester.longPress(
        find.textContaining('pulls the sea', findRichText: true).first,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Ask about this'));
      await tester.pumpAndSettle();
      expect(api.createdBranches, isEmpty);
      expect(hint(tester), 'Ask about this…');
      final quote = find.byKey(const ValueKey('composer-quote'));
      expect(quote, findsOneWidget);
      // A quote is asked about on a tangent, so that is the only action.
      expect(action(tangentAction.label), findsOneWidget);
      expect(action(replyAction.label), findsNothing);
      expect(find.byTooltip('Send'), findsNothing);

      await sendAs(tester, tangentAction.label, 'What does?');
      await settle(tester);
      expect(api.createdBranches.single.fromNodeId, 'a1');
      expect(api.createdBranches.single.anchorQuote, isNotEmpty);
      expect(api.sends.single.target, 'side-1');
      expect(quote, findsNothing);
    });

    testWidgets('a quote can be taken off the composer', (tester) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        nodes: [userNode, answered],
      );
      await pumpApp(tester, api, location: '/t/t1');
      await tester.longPress(
        find.textContaining('pulls the sea', findRichText: true).first,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Ask about this'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Don’t ask about these words'));
      await tester.pump();
      expect(find.byKey(const ValueKey('composer-quote')), findsNothing);
      expect(hint(tester), 'Ask anything…');
    });

    testWidgets('a reply’s own Tangent ↳ puts the whole reply on the box, '
        'even a reply of an earlier thread', (tester) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        branches: [
          trunk,
          branch('side-9', parent: 'trunk', fork: 'a1', title: 'Moon'),
        ],
        nodes: [
          userNode,
          answered,
          node('s1', branch: 'side-9', seq: 0, content: 'Why the moon?'),
          node(
            's2',
            branch: 'side-9',
            seq: 1,
            role: Role.assistant,
            content: 'Gravity.',
          ),
        ],
      );
      await pumpApp(tester, api, location: '/t/t1/b/side-9');
      // A finished reply has one; the learner's messages don't.
      expect(message('s1'), findsOneWidget);
      expect(replyTangent('s1'), findsNothing);
      expect(replyTangent('s2'), findsOneWidget);
      // Read back up to the main thread's reply.
      final position = thread(tester);
      position.jumpTo(position.minScrollExtent);
      await settle(tester);

      await tester.tap(replyTangent('a1'));
      await tester.pump();
      expect(api.createdBranches, isEmpty);
      expect(hint(tester), 'Ask about this…');
      expect(find.byKey(const ValueKey('composer-quote')), findsOneWidget);
      expect(
        find.text('Tangent from “The moon pulls the sea.”'),
        findsOneWidget,
      );
      // The learner asked for the box, so it takes the focus.
      expect(
        tester.widget<TextField>(find.byType(TextField)).focusNode?.hasFocus,
        isTrue,
      );
      // A message to ask about goes on a tangent, so that is the only action.
      expect(action(tangentAction.label), findsOneWidget);
      expect(action(replyAction.label), findsNothing);

      await sendAs(tester, tangentAction.label, 'What else does it pull?');
      await settle(tester);
      expect(api.createdBranches.single.fromNodeId, 'a1');
      expect(api.createdBranches.single.anchorQuote, isNull);
      expect(api.sends.single.content, 'What else does it pull?');
      expect(find.byKey(const ValueKey('composer-quote')), findsNothing);
    });

    testWidgets('a whole reply can be taken off the composer', (tester) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        nodes: [userNode, answered],
      );
      await pumpApp(tester, api, location: '/t/t1');
      await tester.tap(replyTangent('a1'));
      await tester.pump();
      await tester.tap(find.byTooltip('Don’t go on this tangent'));
      await tester.pump();
      expect(find.byKey(const ValueKey('composer-quote')), findsNothing);
      expect(hint(tester), 'Ask anything…');
      expect(action(replyAction.label), findsOneWidget);
    });

    testWidgets('a reply deleted from under the box goes off it, and Tangent ↳ '
        'never lands on the main thread', (tester) async {
      api
        ..details['t1'] = treeDetail(
          title: 'Tides',
          nodes: [
            userNode,
            answered,
            node('u2', branch: 'trunk', seq: 2, content: 'And the sun?'),
            node(
              'a2',
              branch: 'trunk',
              seq: 3,
              role: Role.assistant,
              content: 'It pulls too.',
            ),
          ],
        )
        ..deleteAnswer = const DeletedMessages(
          branchIds: [],
          nodeIds: ['u2', 'a2'],
        );
      await pumpApp(tester, api, location: '/t/t1');
      await tester.tap(replyTangent('a2'));
      await tester.pump();
      expect(find.text('Tangent from “It pulls too.”'), findsOneWidget);

      await tester.tap(find.byTooltip('Delete message').last);
      await settle(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
      await settle(tester);
      expect(api.deletedMessages, ['u2']);
      expect(find.byKey(const ValueKey('composer-quote')), findsNothing);
      expect(hint(tester), 'Ask anything…');

      await sendAs(tester, tangentAction.label, 'Why the moon?');
      await settle(tester);
      expect(api.createdBranches.single.fromNodeId, 'a1');
      expect(api.sends.single.target, 'side-1');
    });

    testWidgets('a tangent shows the words it asks about', (tester) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        branches: [
          trunk,
          branch(
            'side-9',
            parent: 'trunk',
            fork: 'a1',
            title: 'Moon gravity',
            anchorQuote: 'pulls the sea',
          ),
        ],
        nodes: [
          userNode,
          answered,
          node('s1', branch: 'side-9', seq: 0, content: 'How?'),
        ],
      );
      await pumpApp(tester, api, location: '/t/t1/b/side-9');
      expect(find.text('pulls the sea'), findsOneWidget);
    });
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

  testWidgets('before the learner takes a tangent, one suggestion shows '
      'until they ask for more', (tester) async {
    api.details['t1'] = treeDetail(
      title: 'Tides',
      nodes: [userNode, answer(longReply)],
    );
    await pumpApp(tester, api, location: '/t/t1');
    expect(find.text(yourTangentsLabel), findsNothing);
    expect(find.text(suggestedTangentsLabel), findsOneWidget);
    expect(find.text('Spring tides'), findsOneWidget);
    expect(find.text('Tidal locking'), findsNothing);
    expect(find.text('4 suggested tangents'), findsNothing);

    await tester.tap(find.text('3 more suggested'));
    await settle(tester);
    expect(find.text('Tidal locking'), findsOneWidget);
    expect(find.text('Neap tides'), findsOneWidget);
    expect(find.text('Tidal bulges'), findsOneWidget);
    expect(find.text('3 more suggested'), findsNothing);
  });

  group('the tangents footer', () {
    Finder inThread(String text) => find.descendant(
      of: find.byType(MessageView),
      matching: find.text(text),
    );

    /// The fill of the row titled [title] in the thread.
    Color? fill(WidgetTester tester, String title) => tester
        .widget<Material>(
          find
              .ancestor(of: inThread(title), matching: find.byType(Material))
              .first,
        )
        .color;

    Color accentSoft(WidgetTester tester) =>
        TangentColors.of(tester.element(find.byType(MessageView).first))
            .accentSoft;

    /// The Your tangents row titled [title], as a screen reader has it.
    Finder yours(String title) =>
        find.bySemanticsLabel(RegExp('^Open tangent: $title'));

    testWidgets('lists the learner’s tangents first, then folds both kinds '
        'of suggestion behind one row', (tester) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        branches: [
          trunk,
          branch('own', parent: 'trunk', fork: 'a1', title: 'Moon gravity'),
        ],
        nodes: [userNode, answer(taggedReply)],
      );
      await pumpApp(tester, api, location: '/t/t1');
      final yours = tester.getTopLeft(find.text(yourTangentsLabel)).dy;
      final fold = find.text('2 suggested tangents');
      expect(yours, lessThan(tester.getTopLeft(fold).dy));
      expect(find.text('Moon gravity'), findsOneWidget);
      expect(find.text(digDeeperLabel), findsNothing);
      expect(find.text('Neap tides'), findsNothing);
      expect(find.text(suggestedTangentsLabel), findsNothing);
      expect(find.text('Tidal locking'), findsNothing);

      await tester.tap(fold);
      await settle(tester);
      final deeper = tester.getTopLeft(find.text(digDeeperLabel)).dy;
      final neap = tester.getTopLeft(find.text('Neap tides')).dy;
      final offers = tester.getTopLeft(find.text(suggestedTangentsLabel)).dy;
      final locking = tester.getTopLeft(find.text('Tidal locking')).dy;
      expect(deeper, lessThan(neap));
      expect(neap, lessThan(offers));
      expect(offers, lessThan(locking));
    });

    testWidgets('a followed suggestion shows once, under Your tangents, and '
        'opens its tangent', (tester) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        branches: [
          trunk,
          branch('side-9', parent: 'trunk', fork: 'a1', title: 'Spring tides'),
        ],
        nodes: [
          userNode,
          answer(reply),
          node('s1', branch: 'side-9', seq: 0, content: 'Spring tides'),
        ],
      );
      await pumpApp(tester, api, location: '/t/t1');
      expect(find.text('Main thread'), findsNothing);
      expect(find.text(yourTangentsLabel), findsOneWidget);
      expect(find.text('Spring tides'), findsOneWidget);
      expect(find.bySemanticsLabel('Open tangent: Spring tides'), findsOne);
      expect(
        tester.getSemantics(yours('Spring tides')),
        isSemantics(tooltip: 'when the sun and moon line up'),
      );
      expect(find.text('1 more suggested'), findsOneWidget);
      expect(find.text('Tidal locking'), findsNothing);

      await tester.tap(find.text('Spring tides'));
      await settle(tester);
      expect(api.createdBranches, isEmpty);
      expect(api.sends, isEmpty);
      expect(find.text('Main thread'), findsOneWidget);
      expect(find.text('Tangent · Spring tides'), findsOneWidget);

      await tester.tap(find.text('Main thread'));
      await settle(tester);
      expect(find.text('Main thread'), findsNothing);
    });

    testWidgets('a tangent in the learner’s own words folds the suggestions '
        'behind one row, which opens and closes them', (tester) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        branches: [
          trunk,
          branch('side-9', parent: 'trunk', fork: 'a1', title: 'Moon gravity'),
        ],
        nodes: [userNode, answer(reply)],
      );
      await pumpApp(tester, api, location: '/t/t1');
      final fold = find.text('2 suggested tangents');
      expect(find.text(suggestedTangentsLabel), findsNothing);
      expect(find.text('Spring tides'), findsNothing);
      expect(
        tester.getSemantics(fold),
        isSemantics(isButton: true, isExpanded: false),
      );
      expect(
        tester.getSemantics(fold).getSemanticsData().controlsNodes,
        isNull,
      );

      await tester.tap(fold);
      await settle(tester);
      expect(find.text(suggestedTangentsLabel), findsOneWidget);
      expect(find.text('Spring tides'), findsOneWidget);
      expect(find.text('Tidal locking'), findsOneWidget);
      expect(
        tester.getSemantics(fold),
        isSemantics(isButton: true, isExpanded: true),
      );
      expect(tester.getSemantics(fold).getSemanticsData().controlsNodes, {
        'suggested-tangents-a1',
      });

      await tester.tap(fold);
      await settle(tester);
      expect(find.text(suggestedTangentsLabel), findsNothing);
      expect(find.text('Spring tides'), findsNothing);

      await tester.tap(fold);
      await settle(tester);
      await tester.ensureVisible(find.text('Tidal locking'));
      await tester.pump();
      await tester.tap(find.text('Tidal locking'));
      await settle(tester);
      expect(api.createdBranches.single.title, 'Tidal locking');
      expect(api.sends.single.content, 'Tidal locking');
    });

    testWidgets('after following one suggestion, the rest are "more '
        'suggested"', (tester) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        branches: [
          trunk,
          branch('side-9', parent: 'trunk', fork: 'a1', title: 'Tidal locking'),
        ],
        nodes: [userNode, answer(longReply)],
      );
      await pumpApp(tester, api, location: '/t/t1');
      expect(find.text('Tidal locking'), findsOneWidget);
      expect(find.text('Spring tides'), findsNothing);

      await tester.tap(find.text('3 more suggested'));
      await settle(tester);
      expect(find.text('Spring tides'), findsOneWidget);
      expect(find.text('Neap tides'), findsOneWidget);
      expect(find.text('Tidal bulges'), findsOneWidget);
      expect(find.text('Tidal locking'), findsOneWidget);
    });

    testWidgets('lights the tangent on the way to the one on screen', (
      tester,
    ) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        branches: [
          trunk,
          branch('moon', parent: 'trunk', fork: 'a1', title: 'Moon gravity'),
          branch('sun', parent: 'trunk', fork: 'a1', title: 'The sun'),
        ],
        nodes: [
          userNode,
          answer('Tides rise and fall.'),
          node('m1', branch: 'moon', seq: 0, content: 'How strong?'),
        ],
      );
      await pumpApp(tester, api, location: '/t/t1');
      expect(fill(tester, 'Moon gravity'), isNot(accentSoft(tester)));
      expect(fill(tester, 'The sun'), isNot(accentSoft(tester)));
      expect(
        tester.getSemantics(yours('Moon gravity')),
        isSemantics(isSelected: false),
      );

      await tester.tap(inThread('Moon gravity'));
      await settle(tester);
      // The reply it forks from, above the tangent's start.
      await tester.scrollUntilVisible(
        inThread('Moon gravity'),
        -100,
        scrollable: find.byType(Scrollable).first,
      );
      expect(fill(tester, 'Moon gravity'), accentSoft(tester));
      expect(fill(tester, 'The sun'), isNot(accentSoft(tester)));
      expect(
        tester.getSemantics(yours('Moon gravity')),
        isSemantics(isButton: true, isSelected: true),
      );
      expect(
        tester.getSemantics(yours('The sun')),
        isSemantics(isButton: true, isSelected: false),
      );
    });

    testWidgets('lights the tangent the learner just came back from', (
      tester,
    ) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        branches: [
          trunk,
          branch('moon', parent: 'trunk', fork: 'a1', title: 'Moon gravity'),
          branch('sun', parent: 'trunk', fork: 'a1', title: 'The sun'),
        ],
        nodes: [
          userNode,
          answer('Tides rise and fall.'),
          node('m1', branch: 'moon', seq: 0, content: 'How strong?'),
        ],
      );
      await pumpApp(tester, api, location: '/t/t1');
      expect(find.bySemanticsLabel(RegExp('just here')), findsNothing);

      await tester.tap(inThread('Moon gravity'));
      await settle(tester);
      await tester.tap(find.text('Main thread'));
      await settle(tester);
      expect(find.text('Main thread'), findsNothing);
      expect(fill(tester, 'Moon gravity'), accentSoft(tester));
      expect(fill(tester, 'The sun'), isNot(accentSoft(tester)));
      expect(
        find.bySemanticsLabel(
          'Open tangent: Moon gravity (you were just here)',
        ),
        findsOne,
      );
      // Lit, but not on the way to the branch on screen.
      expect(
        tester.getSemantics(yours('Moon gravity')),
        isSemantics(isButton: true, isSelected: false),
      );
    });
  });

  group('suggestions', () {
    ChatNode tagged(String id, int seq, String next) => node(
      id,
      branch: 'trunk',
      seq: seq,
      role: Role.assistant,
      content: taggedReply.replaceFirst('Neap tides', next),
    );

    testWidgets('every reply shows its Dig deeper suggestions before its '
        'suggested tangents', (tester) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        nodes: [
          userNode,
          tagged('a1', 1, 'Neap tides'),
          node('u2', branch: 'trunk', seq: 2, content: 'And the sun?'),
          tagged('a2', 3, 'Solar tides'),
        ],
      );
      await pumpApp(tester, api, location: '/t/t1');
      expect(find.text(digDeeperLabel), findsNWidgets(2));
      expect(find.text(suggestedTangentsLabel), findsNWidgets(2));
      expect(find.text('Neap tides'), findsOneWidget);
      expect(find.text('Solar tides'), findsOneWidget);
      expect(
        tester.getTopLeft(find.text('Solar tides')).dy,
        lessThan(tester.getTopLeft(find.text('Tidal locking').last).dy),
      );
    });

    testWidgets('a Dig deeper suggestion on an earlier reply opens a tangent '
        'instead of sending in the thread', (tester) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        nodes: [
          userNode,
          tagged('a1', 1, 'Neap tides'),
          node('u2', branch: 'trunk', seq: 2, content: 'And the sun?'),
          tagged('a2', 3, 'Solar tides'),
        ],
      );
      await pumpApp(tester, api, location: '/t/t1');
      await tester.ensureVisible(find.text('Neap tides'));
      await tester.pump();
      await tester.tap(find.text('Neap tides'));
      await settle(tester);
      expect(api.createdBranches.single.title, 'Neap tides');
      expect(api.sends.single.target, 'side-1');
      expect(api.sends.single.content, 'Neap tides');
      expect(find.text('Main thread'), findsOneWidget);
    });

    testWidgets('a Dig deeper suggestion on the newest reply opens a tangent '
        'too', (tester) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        nodes: [userNode, tagged('a1', 1, 'Neap tides')],
      );
      await pumpApp(tester, api, location: '/t/t1');
      await tester.tap(find.text('Neap tides'));
      await settle(tester);
      expect(api.createdBranches.single.title, 'Neap tides');
      expect(api.sends.single.target, 'side-1');
    });

    testWidgets('while a send is in flight, the suggestions are disabled', (
      tester,
    ) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        nodes: [userNode, tagged('a1', 1, 'Neap tides')],
      );
      await pumpApp(tester, api, location: '/t/t1');
      final rows = [
        find.bySemanticsLabel(RegExp('^Start a tangent: Neap tides')),
        find.bySemanticsLabel(RegExp('^Start a tangent: Tidal locking')),
      ];
      for (final row in rows) {
        expect(
          tester.getSemantics(row),
          isSemantics(isButton: true, hasEnabledState: true, isEnabled: true),
        );
      }

      await sendAs(tester, replyAction.label, 'And the sun?');
      for (final row in rows) {
        expect(
          tester.getSemantics(row),
          isSemantics(isButton: true, hasEnabledState: true, isEnabled: false),
        );
      }
    });

    testWidgets('a tangent suggestion opens a tangent', (tester) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        nodes: [userNode, tagged('a1', 1, 'Neap tides')],
      );
      await pumpApp(tester, api, location: '/t/t1');
      await tester.tap(find.text('Tidal locking'));
      await settle(tester);
      expect(api.createdBranches.single.title, 'Tidal locking');
      expect(api.sends.single.target, 'side-1');
    });

    testWidgets('an untagged suggestion is a tangent', (tester) async {
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
      expect(find.text(digDeeperLabel), findsNothing);
      expect(find.text(suggestedTangentsLabel), findsOneWidget);
      expect(find.text('Spring tides'), findsOneWidget);
    });
  });

  group('the walkthrough', () {
    final answered = node(
      'a1',
      branch: 'trunk',
      seq: 1,
      role: Role.assistant,
      content: reply,
    );

    setUp(() {
      api.settingsAnswer = const Settings(walkthroughDoneAt: null);
    });

    testWidgets('points at Tangent once the first reply is in', (tester) async {
      await pumpApp(tester, api, location: '/t/t1');
      expect(find.text(walkthroughSteps.tangent), findsNothing);

      await sendTyped(tester, 'Why tides?');
      await start(tester);
      expect(find.text(walkthroughSteps.tangent), findsNothing, reason: 'yet');
      await emit(tester, DoneEvent(node: answered, branch: trunk));
      await settle(tester);
      expect(find.text(walkthroughSteps.tangent), findsOneWidget);
      // The message box stays clear, to type what to ask.
      expect(
        tester.getRect(find.byKey(const ValueKey('coach-mark'))).bottom,
        lessThanOrEqualTo(tester.getRect(find.byType(TextField)).top),
      );
    });

    testWidgets('never shows for an account that has had it', (tester) async {
      api.settingsAnswer = const Settings(walkthroughDoneAt: '2026-01-01');
      api.details['t1'] = treeDetail(
        title: 'Tides',
        nodes: [userNode, answered],
      );
      await pumpApp(tester, api, location: '/t/t1');
      expect(find.text(walkthroughSteps.tangent), findsNothing);
    });

    testWidgets('leaves the control it points at usable, and walks the loop', (
      tester,
    ) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        nodes: [userNode, answered],
      );
      await pumpApp(tester, api, location: '/t/t1');
      expect(find.text(walkthroughSteps.tangent), findsOneWidget);

      await sendAs(tester, tangentAction.label, 'Why the moon?');
      await settle(tester);
      expect(api.createdBranches.single.fromNodeId, 'a1');
      expect(find.text(walkthroughSteps.back), findsOneWidget);

      await tester.tap(find.text('Main thread'));
      await settle(tester);
      expect(find.text(walkthroughSteps.next), findsOneWidget);

      await tester.tap(find.text(walkthroughButtons.done));
      await settle(tester);
      expect(find.text(walkthroughSteps.next), findsNothing);
      expect(api.walkthroughDoneMarks, 1);
    });

    testWidgets('a reply sent with Next ➜ on the main thread ends it at step '
        '3', (tester) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        nodes: [userNode, answered],
      );
      await pumpApp(tester, api, location: '/t/t1');
      await sendAs(tester, tangentAction.label, 'Why the moon?');
      await settle(tester);
      final side = branch('side-1', parent: 'trunk', fork: 'a1');
      final sideReply = node(
        's2',
        branch: 'side-1',
        seq: 1,
        role: Role.assistant,
        content: 'Gravity.',
      );
      await emit(
        tester,
        StartEvent(
          userNode: node('s1', branch: 'side-1', seq: 0, content: 'Why?'),
          assistantNode: sideReply,
          branch: side,
        ),
      );
      await emit(tester, DoneEvent(node: sideReply, branch: side));
      await tester.tap(find.text('Main thread'));
      await settle(tester);
      expect(find.text(walkthroughSteps.next), findsOneWidget);

      await sendAs(tester, replyAction.label, 'And then?');
      await settle(tester);
      expect(api.sends.last.target, 'trunk');
      expect(find.text(walkthroughSteps.next), findsNothing);
      expect(api.walkthroughDoneMarks, 1);
    });

    testWidgets('Skip tour ends it and says so to the server', (tester) async {
      api.details['t1'] = treeDetail(
        title: 'Tides',
        nodes: [userNode, answered],
      );
      await pumpApp(tester, api, location: '/t/t1');
      await tester.tap(find.text(walkthroughButtons.skip));
      await settle(tester);
      expect(find.text(walkthroughSteps.tangent), findsNothing);
      expect(api.walkthroughDoneMarks, 1);
    });
  });

  testWidgets('a tangent’s divider centres its title in the thread', (
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
    final title = find.text('Tangent · Spring tides');
    final thread = tester.getRect(find.byType(Scrollable).first);
    expect(tester.getCenter(title).dx, closeTo(thread.center.dx, 1));
  });

  testWidgets('a tangent with the placeholder title shows its words alone, '
      'and the main thread step leads back', (tester) async {
    api.details['t1'] = treeDetail(
      title: 'Tides',
      branches: [
        trunk,
        const Branch(
          id: 'side-9',
          treeId: 't1',
          parentBranchId: 'trunk',
          branchPointNodeId: 'a1',
          title: 'Tangent: The moon pulls',
          titleSource: 'default',
        ),
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
        node('s1', branch: 'side-9', seq: 0, content: 'Why?'),
      ],
    );
    await pumpApp(tester, api, location: '/t/t1/b/side-9');
    expect(find.text('Tangent · The moon pulls'), findsOneWidget);
    expect(find.textContaining('Tangent: '), findsNothing);
    expect(find.byTooltip('Back to main thread'), findsOneWidget);
    expect(find.bySemanticsLabel('Back to main thread'), findsOneWidget);

    await tester.tap(find.text('Main thread'));
    await settle(tester);
    expect(find.byKey(const ValueKey('breadcrumb')), findsNothing);
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

  testWidgets('a nested tangent’s path shows the main thread and its '
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

  testWidgets('the outline lists every tangent and opens one', (tester) async {
    api.details['t1'] = nestedLesson();
    await pumpApp(tester, api, location: '/t/t1/b/neap');
    await tester.tap(find.byTooltip('Tangents'));
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

  testWidgets('a lesson without tangents has no outline', (tester) async {
    api.details['t1'] = treeDetail(title: 'Tides', nodes: [userNode]);
    await pumpApp(tester, api, location: '/t/t1');
    expect(find.byTooltip('Tangents'), findsNothing);
  });

  testWidgets('on a wide screen the outline stays beside the thread', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    api.details['t1'] = nestedLesson();
    await pumpApp(tester, api, location: '/t/t1/b/moon');
    expect(find.byTooltip('Tangents'), findsNothing);
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

  testWidgets('a send refused for want of a key offers to save one', (
    tester,
  ) async {
    api.refuseSend = const ApiException(
      status: 401,
      code: 'key_required',
      message: 'Add your OpenRouter API key to continue this conversation.',
    );
    await pumpApp(tester, api, location: '/t/t1');
    await sendTyped(tester, 'Why tides?');
    await settle(tester);
    expect(find.textContaining('save your own key'), findsOneWidget);
    await tester.tap(find.text('How you pay'));
    await settle(tester);
    expect(find.text('How replies are paid for'), findsOneWidget);
    expect(
      tester.widget<TextField>(find.byType(TextField).first).controller?.text,
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

  group('the ends of the thread', () {
    final long = List.filled(60, 'The moon pulls the sea.').join('\n\n');

    /// Tides, with a long reply on the main thread and a long tangent,
    /// Moon gravity, from it.
    TreeDetail longLesson() => treeDetail(
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

    ScrollPosition thread(WidgetTester tester) =>
        tester.state<ScrollableState>(find.byType(Scrollable).first).position;

    bool jumpShown(WidgetTester tester) => !tester
        .widget<IgnorePointer>(find.byKey(const ValueKey('jump-to-end')))
        .ignoring;

    /// The button as read out: its tooltip names it.
    final jumpButton = find.semantics.byPredicate(
      (node) => node.tooltip == jumpToEnd,
    );

    Future<void> press(WidgetTester tester, LogicalKeyboardKey key) async {
      await tester.sendKeyEvent(key);
      await settle(tester);
    }

    testWidgets('no jump to the end where the main thread opens, at its '
        'end', (tester) async {
      api.details['t1'] = longLesson();
      await pumpApp(tester, api, location: '/t/t1');
      expect(jumpShown(tester), isFalse);
    });

    testWidgets('no jump to the end of a thread that fits', (tester) async {
      api.details['t1'] = treeDetail(
        title: 'Short',
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
      thread(tester).jumpTo(0);
      await settle(tester);
      expect(jumpShown(tester), isFalse);
    });

    testWidgets('a long tangent offers the jump to its end, which goes '
        'there', (tester) async {
      api.details['t1'] = longLesson();
      await pumpApp(tester, api, location: '/t/t1/b/side-9');
      expect(thread(tester).pixels, 0);
      expect(jumpShown(tester), isTrue);
      expect(jumpButton, findsOne);

      await tester.tap(find.byTooltip(jumpToEnd));
      await settle(tester);
      final position = thread(tester);
      expect(position.pixels, position.maxScrollExtent);
      expect(jumpShown(tester), isFalse);
      expect(jumpButton, findsNothing);
    });

    testWidgets('a reply growing below its start offers the jump, which then '
        'follows it', (tester) async {
      await pumpApp(tester, api, location: '/t/t1');
      await sendTyped(tester, 'Why tides?');
      await start(tester);
      await emit(tester, const DeltaEvent(nodeId: 'a1', text: 'First line.'));
      Future<void> grow() => emit(
        tester,
        const DeltaEvent(nodeId: 'a1', text: '\n\nThe moon pulls the sea.'),
      );
      // A line at a time until the reply's start reaches the top and the
      // view stops there, with the end still close below.
      var parked = thread(tester).pixels;
      for (var i = 0; i < 80; i++) {
        await grow();
        final now = thread(tester).pixels;
        if (now > 0 && now == parked) break;
        parked = now;
      }
      expect(thread(tester).pixels, greaterThan(0));
      expect(jumpShown(tester), isFalse);
      for (var i = 0; i < 30; i++) {
        await grow();
      }
      // The end moved away under a view that didn't scroll.
      expect(thread(tester).pixels, parked);
      expect(jumpShown(tester), isTrue);

      await tester.tap(find.byTooltip(jumpToEnd));
      await tester.pump();
      await tester.pump();
      await grow();
      final position = thread(tester);
      expect(position.pixels, position.maxScrollExtent);
      expect(jumpShown(tester), isFalse);
    });

    testWidgets('no jump while a coach mark shows', (tester) async {
      api.settingsAnswer = const Settings(walkthroughDoneAt: null);
      api.details['t1'] = treeDetail(
        title: 'Tides',
        nodes: [
          userNode,
          node(
            'a1',
            branch: 'trunk',
            seq: 1,
            role: Role.assistant,
            content: '$long\n\n$reply',
          ),
        ],
      );
      await pumpApp(tester, api, location: '/t/t1');
      expect(find.text(walkthroughSteps.tangent), findsOneWidget);
      thread(tester).jumpTo(0);
      await settle(tester);
      expect(jumpShown(tester), isFalse);

      await tester.tap(find.text(walkthroughButtons.skip));
      await settle(tester);
      expect(jumpShown(tester), isTrue);
    });

    testWidgets('the tangent’s step in its path goes back to its start', (
      tester,
    ) async {
      api.details['t1'] = longLesson();
      await pumpApp(tester, api, location: '/t/t1/b/side-9');
      thread(tester).jumpTo(1500);
      await settle(tester);

      await tester.tap(crumb('Moon gravity'));
      await settle(tester);
      final position = thread(tester);
      expect(position.pixels, 0);
      // What it came from is still above.
      expect(position.minScrollExtent, lessThan(0));
      final top = tester.getRect(find.byType(Scrollable).first).top;
      expect(
        tester.getTopLeft(find.text('Tangent · Moon gravity')).dy,
        inInclusiveRange(top, top + 64),
      );
    });

    testWidgets('the lesson title goes back to the start', (tester) async {
      api.details['t1'] = longLesson();
      await pumpApp(tester, api, location: '/t/t1');
      expect(thread(tester).pixels, greaterThan(0));

      await tester.tap(find.byTooltip(backToStart));
      await settle(tester);
      expect(thread(tester).pixels, 0);
    });

    testWidgets('without animations, the jumps land at once', (tester) async {
      tester.platformDispatcher.accessibilityFeaturesTestValue =
          const FakeAccessibilityFeatures(disableAnimations: true);
      addTearDown(
        tester.platformDispatcher.clearAccessibilityFeaturesTestValue,
      );
      api.details['t1'] = longLesson();
      await pumpApp(tester, api, location: '/t/t1/b/side-9');
      // Short of the end, where the way there would be animated.
      final position = thread(tester);
      position.jumpTo(position.maxScrollExtent - 600);
      await settle(tester);
      expect(jumpShown(tester), isTrue);

      await tester.tap(find.byTooltip(jumpToEnd));
      await tester.pump();
      expect(position.pixels, position.maxScrollExtent);
      expect(jumpShown(tester), isFalse);

      position.jumpTo(600);
      await tester.pump();
      await tester.tap(crumb('Moon gravity'));
      await tester.pump();
      expect(position.pixels, 0);
    });

    testWidgets('Home and End scroll the thread, but not from the message '
        'box', (tester) async {
      api.details['t1'] = longLesson();
      await pumpApp(tester, api, location: '/t/t1');
      final position = thread(tester);
      final end = position.pixels;
      expect(end, greaterThan(0));

      // Brought back with the header after reading down.
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -200));
      await settle(tester);
      expect(find.byTooltip(backToStart).hitTestable(), findsNothing);
      await press(tester, LogicalKeyboardKey.home);
      expect(position.pixels, 0);
      expect(find.byTooltip(backToStart).hitTestable(), findsOneWidget);

      await press(tester, LogicalKeyboardKey.end);
      expect(position.pixels, position.maxScrollExtent);
      await press(tester, LogicalKeyboardKey.home);
      expect(position.pixels, 0);
      // Page Down reaches the thread through the same primary controller.
      await press(tester, LogicalKeyboardKey.pageDown);
      expect(position.pixels, greaterThan(0));
      await press(tester, LogicalKeyboardKey.home);

      await type(tester, 'Why tides?');
      final field = tester.widget<TextField>(find.byType(TextField));
      field.controller!.selection = const TextSelection.collapsed(offset: 0);
      await tester.pump();
      await press(tester, LogicalKeyboardKey.end);
      expect(position.pixels, 0);
      expect(field.controller!.selection.baseOffset, 'Why tides?'.length);
    });

    testWidgets('the ways to the ends say where they go', (tester) async {
      api.details['t1'] = longLesson();
      await pumpApp(tester, api, location: '/t/t1/b/side-9');
      expect(
        tester.getSemantics(find.bySemanticsLabel('Tides, back to the start')),
        isSemantics(isButton: true, hasTapAction: true),
      );
      expect(
        tester.getSemantics(
          find.bySemanticsLabel(
            'Moon gravity, back to the start of this tangent',
          ),
        ),
        isSemantics(isButton: true, hasTapAction: true),
      );
      expect(
        jumpButton.evaluate().single,
        isSemantics(isButton: true, hasTapAction: true),
      );
    });

    // On iOS a tap on the status bar scrolls the page's primary controller
    // to its start. The app's theme is made once per test run, on the
    // platform of the first test, so the tap itself can't be simulated here.
    testWidgets('the thread is the page’s primary scroll view, and the '
        'outline’s list leaves it alone', (tester) async {
      api.details['t1'] = nestedLesson();
      await pumpApp(tester, api, location: '/t/t1/b/neap');
      await tester.tap(find.byTooltip('Tangents'));
      await settle(tester);
      expect(find.byType(Drawer), findsOneWidget);
      final controller = PrimaryScrollController.of(
        tester.element(find.byKey(const ValueKey('breadcrumb'))),
      );
      expect(controller.positions.single, same(thread(tester)));
    });
  });
}
