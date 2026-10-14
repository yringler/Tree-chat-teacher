import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:tangent/api/models.dart';
import 'package:tangent/ui/math_markdown.dart';
import 'package:tangent/ui/mermaid_markdown.dart';
import 'package:tangent/ui/message_view.dart';
import 'package:tangent/ui/theme.dart';

/// The cases of the web renderer's Mermaid tests
/// (packages/render/test/markdown.test.ts), so both apps find diagrams alike.
String html(String source) => md.markdownToHtml(
  source,
  extensionSet: md.ExtensionSet.gitHubFlavored,
  blockSyntaxes: [...mathBlockSyntaxes, const MermaidFenceSyntax()],
  inlineSyntaxes: mathInlineSyntaxes,
);

/// Dart's renderer breaks lines around tags differently than markdown-it,
/// so newlines between tags don't count.
String flat(String html) => html.replaceAll('>\n', '>');

void expectHtml(String src, String expected) =>
    expect(flat(html(src)), flat(expected));

/// A diagram block as Dart's renderer writes it (its source HTML-escaped).
String diagram(String source) => '<mermaid>$source</mermaid>\n';

const flowchart = 'graph TD\nA[Start] --> B{Done?}\n';
const flowchartHtml = 'graph TD\nA[Start] --&gt; B{Done?}\n';

void main() {
  group('mermaid', () {
    test('a backtick mermaid fence becomes a diagram block', () {
      expectHtml(
        'Look:\n\n```mermaid\n$flowchart```\n\nafter',
        '<p>Look:</p>\n${diagram(flowchartHtml)}<p>after</p>\n',
      );
    });

    test('a tilde mermaid fence becomes a diagram block', () {
      expectHtml('~~~mermaid\n$flowchart~~~', diagram(flowchartHtml));
    });

    test('only the first word of the info string counts', () {
      for (final info in ['mermaid title', 'mermaid\tx', ' mermaid ']) {
        expectHtml('```$info\n$flowchart```', diagram(flowchartHtml));
      }
      for (final info in ['js mermaid', 'mermaidjs', 'mermaid-js', '']) {
        final out = html('```$info\n$flowchart```');
        expect(out, isNot(contains('<mermaid')), reason: info);
        expect(out, contains('<pre'), reason: info);
      }
    });

    test('the language name is case-sensitive', () {
      for (final info in ['Mermaid', 'MERMAID']) {
        final out = html('```$info\n$flowchart```');
        expect(out, isNot(contains('<mermaid')), reason: info);
        expect(out, contains('<pre><code class="language-$info">'));
      }
    });

    test('a mermaid fence inside a list item becomes a diagram block', () {
      expectHtml(
        '- item\n\n  ```mermaid\n  graph TD\n  A --> B\n  ```\n- next',
        '<ul>\n<li>\n<p>item</p>\n${diagram('graph TD\nA --&gt; B\n')}</li>\n'
            '<li>\n<p>next</p>\n</li>\n</ul>\n',
      );
    });

    test('mermaid in inline code stays text', () {
      final out = html('Write `mermaid` or ``` ```mermaid ``` to draw.');
      expect(out, isNot(contains('<mermaid')));
      expect(out, contains('<code>mermaid</code>'));
    });

    test('an unclosed mermaid fence becomes a diagram block', () {
      expectHtml(
        '```mermaid\ngraph TD\nA --> B',
        diagram('graph TD\nA --&gt; B\n'),
      );
    });

    testWidgets('draws a diagram when not streaming', (tester) async {
      final semantics = tester.ensureSemantics();
      await pumpReply(tester, '```mermaid\n$flowchart```', NodeStatus.complete);
      expect(tester.takeException(), isNull);
      expect(find.bySemanticsLabel('Diagram: Start, Done?'), findsOneWidget);
      expect(find.textContaining('graph TD'), findsNothing);
      semantics.dispose();
    });

    testWidgets('shows a code block while streaming', (tester) async {
      await pumpReply(
        tester,
        '```mermaid\n$flowchart```',
        NodeStatus.streaming,
      );
      expect(find.text(flowchart.trimRight()), findsOneWidget);
      expect(find.byType(MermaidBlock), findsNothing);
      expect(find.text('This diagram could not be drawn.'), findsNothing);
    });

    testWidgets('draws the diagram once its reply completes', (tester) async {
      // The last streamed text and the reply's end can arrive apart.
      const content = '```mermaid\n$flowchart```';
      await pumpReply(tester, content, NodeStatus.streaming);
      await pumpReply(tester, content, NodeStatus.complete);
      expect(find.byType(MermaidBlock), findsOneWidget);
      expect(find.textContaining('graph TD'), findsNothing);
    });

    testWidgets('invalid source shows the note and source', (tester) async {
      const source = 'graph TD\nA --> [';
      await pumpReply(tester, '```mermaid\n$source\n```', NodeStatus.complete);
      expect(find.text('This diagram could not be drawn.'), findsOneWidget);
      expect(find.text(source), findsOneWidget);
    });

    testWidgets('over-length source shows the note and source', (tester) async {
      final source = 'graph TD\n${'A --> B\n' * 2500}'.trimRight();
      expect(source.length, greaterThan(maxMermaidSource));
      await pumpReply(tester, '```mermaid\n$source\n```', NodeStatus.complete);
      expect(find.text('This diagram could not be drawn.'), findsOneWidget);
      expect(find.text(source), findsOneWidget);
    });
  });
}

/// A tutor's reply in the app's theme, after the diagram library loads.
Future<void> pumpReply(
  WidgetTester tester,
  String content,
  NodeStatus status,
) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: lightTheme,
      home: Scaffold(
        body: SingleChildScrollView(
          child: MessageView(
            node: ChatNode(
              id: 'n1',
              branchId: 'b1',
              parentId: null,
              seq: 1,
              role: Role.assistant,
              content: content,
              status: status,
              error: null,
              errorKind: null,
            ),
            status: null,
            tangents: const [],
            chainIds: const {},
            onFollow: null,
            onOpenTangent: (_) {},
            onAskAbout: (_) {},
          ),
        ),
      ),
    ),
  );
  // The diagram library's load completes on a timer.
  await tester.pump(const Duration(milliseconds: 1));
}
