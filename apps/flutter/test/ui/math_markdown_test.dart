import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:tangent/ui/math_markdown.dart';

/// The cases of the web renderer's math tests
/// (packages/render/test/markdown.test.ts), so both apps read TeX alike.
String html(String source) => md.markdownToHtml(
  source,
  extensionSet: md.ExtensionSet.gitHubFlavored,
  blockSyntaxes: mathBlockSyntaxes,
  inlineSyntaxes: mathInlineSyntaxes,
);

/// Dart's renderer breaks lines around tags differently than markdown-it,
/// so newlines between tags don't count.
String flat(String html) => html.replaceAll('>\n', '>');

void expectHtml(String src, String expected) =>
    expect(flat(html(src)), flat(expected));

String inline(String tex) => '<math>$tex</math>';
String display(String tex) => '<math-display>$tex</math-display>\n';

void main() {
  test('keeps TeX backslashes that Markdown escapes would eat', () {
    const src = r'''\[
\begin{aligned}
z_{1,1} &= 0.41 \\[4pt]
z_{1,2} &= 0.55
\end{aligned}
\]''';
    expectHtml(
      src,
      display(r'''\begin{aligned}
z_{1,1} &= 0.41 \\[4pt]
z_{1,2} &= 0.55
\end{aligned}'''),
    );
  });

  test('parses inline math in both delimiters', () {
    expectHtml(
      r'a \(x_1\) b $w^2$ e',
      '<p>a ${inline('x_1')} b ${inline('w^2')} e</p>\n',
    );
  });

  test('parses display math on its own lines in both delimiters', () {
    expectHtml(
      'Text:\n\\[y\\]\n\$\$z\$\$\nafter',
      '<p>Text:</p>\n${display('y')}${display('z')}<p>after</p>\n',
    );
  });

  test('does not let emphasis or escapes touch math', () {
    expectHtml(
      r'\(a_i * b_j * c\_k \{x\}\)',
      '<p>${inline(r'a_i * b_j * c\_k \{x\}')}</p>\n',
    );
  });

  test('takes display blocks whose lines look like Markdown', () {
    expectHtml(
      'Text:\n\$\$\n- a\n= b\n1. c\n\$\$\nafter',
      '<p>Text:</p>\n${display('- a\n= b\n1. c')}<p>after</p>\n',
    );
  });

  test('finds display blocks inside list items', () {
    expectHtml(
      '- item\n  \\[\n  x\n  \\]\n- next',
      '<ul>\n<li>item${display('x')}</li>\n<li>next</li>\n</ul>\n',
    );
  });

  test('leaves math in code alone', () {
    expectHtml(
      r'`\(x\)` and `$y$`',
      '<p><code>\\(x\\)</code> and <code>\$y\$</code></p>\n',
    );
    expectHtml('```\n\$\$x\$\$\n```', '<pre><code>\$\$x\$\$\n</code></pre>\n');
  });

  test('does not treat prices as math', () {
    for (final src in [
      r'costs $5 and $10',
      r'between $5-$10',
      r'US$5 or $ 5$',
      r'a $10/year fee, $20/year',
      r'escaped \$x\$',
    ]) {
      expect(html(src), isNot(contains('<math')), reason: src);
    }
    expectHtml(
      r'costs $5 and $10, so $x$ is',
      '<p>costs \$5 and \$10, so ${inline('x')} is</p>\n',
    );
  });

  test('renders unclosed math (still streaming) as text', () {
    expect(html('\\[\n\\frac{a}{b}'), isNot(contains('<math')));
    expect(html(r'see \(x'), '<p>see (x</p>\n');
  });

  test('does not end inline math at an escaped closer', () {
    expectHtml(
      r'\(a \\ b\) and \(\$5\)',
      '<p>${inline(r'a \\ b')} and ${inline(r'\$5')}</p>\n',
    );
  });

  testWidgets('typesets math in selectable Markdown', (tester) async {
    await pumpMarkdown(
      tester,
      'where \\(f(z)=\\max(0,z)\\) is ReLU\n\n\\[\\frac{1}{1+e^{-z}}\\]',
    );
    expect(tester.takeException(), isNull);
    expect(find.byType(Math), findsNWidgets(2));
    expect(find.textContaining('frac'), findsNothing);
  });

  testWidgets('typesets multi-line display math', (tester) async {
    await pumpMarkdown(tester, r'''\[
\begin{aligned}
a &= 1 \\
b &= 2
\end{aligned}
\]''');
    expect(find.byType(Math), findsOneWidget);
    expect(find.textContaining('aligned'), findsNothing);
  });

  testWidgets('shows invalid TeX as its source', (tester) async {
    await pumpMarkdown(tester, r'\[\frac{a\]');
    expect(find.textContaining(r'\frac{a'), findsOneWidget);
  });
}

Future<void> pumpMarkdown(WidgetTester tester, String data) =>
    tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MarkdownBody(
            data: data,
            selectable: true,
            blockSyntaxes: mathBlockSyntaxes,
            inlineSyntaxes: mathInlineSyntaxes,
            builders: mathBuilders,
          ),
        ),
      ),
    );
