import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:markdown/markdown.dart' as md;

import 'theme.dart';

/// TeX math in Markdown, read by the same rules as the web renderer's
/// (packages/render/src/math.ts, which uses @mdit/plugin-tex): `\(…\)` and
/// `$…$` inline, `\[…\]` and `$$…$$` as blocks that start their own line.
/// The math is taken before Markdown escapes can eat its backslashes, `$`
/// follows Pandoc's rules so "$5 and $10" stays text, code is left alone,
/// and an unclosed `\(` or `\[` (still streaming) stays text.
///
/// Inline math becomes a `math` element, display math a `math-display`
/// element, each holding the TeX source; [mathBuilders] typesets them with
/// flutter_math_fork as native widgets. The syntaxes are ours because
/// flutter_markdown_plus_latex reads `( x )` and `[ x ]` as math, misses a
/// `\[` on its own line, and puts inline math outside the line's text.
final List<md.InlineSyntax> mathInlineSyntaxes = [
  _ParenMathSyntax(),
  _DollarMathSyntax(),
];

final List<md.BlockSyntax> mathBlockSyntaxes = [
  const _DisplayMathSyntax(r'$$', r'$$', closeRequired: false),
  const _DisplayMathSyntax(r'\[', r'\]', closeRequired: true),
];

final Map<String, MarkdownElementBuilder> mathBuilders = {
  'math': _MathBuilder(display: false),
  'math-display': _MathBuilder(display: true),
};

const _backslash = 0x5C;
const _dollar = 0x24;

bool _isSpace(int? c) => c == 0x20 || c == 0x09 || c == 0x0A;

bool _isWord(int? c) =>
    c != null &&
    ((c >= 0x30 && c <= 0x39) ||
        (c >= 0x41 && c <= 0x5A) ||
        (c >= 0x61 && c <= 0x7A) ||
        c == 0x5F);

int? _at(String s, int i) => i >= 0 && i < s.length ? s.codeUnitAt(i) : null;

/// How many backslashes run back from just before [end], down to [floor].
int _backslashesBefore(String s, int end, [int floor = 0]) {
  var n = 0;
  for (var i = end - 1; i >= floor && s.codeUnitAt(i) == _backslash; i--) {
    n++;
  }
  return n;
}

/// `\(…\)`, ending at the first `\)` not itself escaped.
class _ParenMathSyntax extends md.InlineSyntax {
  _ParenMathSyntax() : super(r'\\\(', startCharacter: _backslash);

  @override
  bool onMatch(md.InlineParser parser, Match match) => true;

  @override
  bool tryMatch(md.InlineParser parser, [int? startMatchPos]) {
    final src = parser.source;
    final start = parser.pos + 2;
    if (!src.startsWith(r'\(', parser.pos)) return false;
    for (var i = start; i < src.length - 1; i++) {
      if (src.codeUnitAt(i) == _backslash &&
          src.codeUnitAt(i + 1) == 0x29 &&
          _backslashesBefore(src, i, start).isEven) {
        parser.writeText();
        parser.addNode(md.Element.text('math', src.substring(start, i).trim()));
        parser.consume(i + 2 - parser.pos);
        return true;
      }
    }
    return false;
  }
}

/// `$…$` by Pandoc's rules: the opening `$` has no word character before it
/// and no space after; the closing one no space before and no word character
/// or digit after.
class _DollarMathSyntax extends md.InlineSyntax {
  _DollarMathSyntax() : super(r'\$', startCharacter: _dollar);

  @override
  bool onMatch(md.InlineParser parser, Match match) => true;

  @override
  bool tryMatch(md.InlineParser parser, [int? startMatchPos]) {
    final src = parser.source;
    final pos = parser.pos;
    if (_at(src, pos) != _dollar) return false;
    final before = _at(src, pos - 1);
    if (before == _dollar || _isWord(before) || _isSpace(_at(src, pos + 1))) {
      return false;
    }
    var end = pos + 1;
    while (true) {
      end = src.indexOf(r'$', end);
      if (end == -1) return false;
      if (_backslashesBefore(src, end).isOdd) {
        end++;
        continue;
      }
      final prev = _at(src, end - 1);
      final next = _at(src, end + 1);
      if (next != _dollar && !_isWord(next) && !_isSpace(prev)) break;
      if (_isSpace(prev) && (next == null || _isSpace(next))) {
        end++;
        continue;
      }
      return false;
    }
    // `$$` inline is no math; the second `$` then fails the opening rule.
    if (end == pos + 1) return false;
    parser.writeText();
    parser.addNode(md.Element.text('math', src.substring(pos + 1, end).trim()));
    parser.consume(end + 1 - pos);
    return true;
  }
}

/// A display block: a line starting with [open], to the line ending with
/// [close] (the same line or a later one). An unclosed `$$` takes the rest of
/// the text; an unclosed `\[` is not math.
class _DisplayMathSyntax extends md.BlockSyntax {
  const _DisplayMathSyntax(
    this.open,
    this.close, {
    required this.closeRequired,
  });

  final String open;
  final String close;
  final bool closeRequired;

  @override
  RegExp get pattern => RegExp('^ {0,3}${RegExp.escape(open)}');

  @override
  bool canParse(md.BlockParser parser) {
    final line = parser.current.content;
    if (!pattern.hasMatch(line)) return false;
    if (open != r'$$') return true;
    // `$$a$$ b` is a paragraph with text after the formula.
    final rest = line.trimLeft().substring(2);
    final closeAt = rest.indexOf(r'$$');
    return closeAt == -1 || rest.substring(closeAt + 2).trim().isEmpty;
  }

  @override
  md.Node? parse(md.BlockParser parser) {
    final first = parser.current.content;
    final indent = first.length - first.trimLeft().length;
    final head = first.trimLeft().substring(open.length).trimRight();
    final lines = <String>[];
    var closed = false;
    if (head.length >= close.length && head.endsWith(close)) {
      lines.add(head.substring(0, head.length - close.length));
      closed = true;
    } else {
      lines.add(head);
    }
    var taken = 1;
    while (!closed && parser.peek(taken) != null) {
      final line = parser.peek(taken)!.content;
      taken++;
      // Strip up to the opening line's indent, as a list item's is.
      final body = line.length - line.trimLeft().length > indent
          ? line.substring(indent).trimRight()
          : line.trim();
      if (body.endsWith(close)) {
        lines.add(body.substring(0, body.length - close.length));
        closed = true;
      } else {
        lines.add(body);
      }
    }
    if (!closed && closeRequired) return null;
    for (var i = 0; i < taken; i++) {
      parser.advance();
    }
    final tex = lines.join('\n').trim();
    return md.Element.text('math-display', tex);
  }
}

class _MathBuilder extends MarkdownElementBuilder {
  _MathBuilder({required this.display});

  final bool display;

  @override
  bool isBlockElement() => display;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    final theme = Theme.of(context);
    final style = parentStyle ?? theme.textTheme.bodyLarge;
    final tex = element.textContent;
    final math = Math.tex(
      tex,
      mathStyle: display ? MathStyle.display : MathStyle.text,
      textStyle: style,
      settings: const TexParserSettings(strict: Strict.ignore),
      // Invalid TeX, like a half-written formula, shows its source.
      onErrorFallback: (_) => Text(
        tex,
        style: style?.copyWith(
          fontFamily: codeFont,
          fontFamilyFallback: fallbackFonts,
        ),
      ),
    );
    if (display) {
      // A wide formula scrolls rather than overflowing a phone's width.
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: math,
        ),
      );
    }
    // A span, so the paragraph's text merges around it and keeps wrapping.
    return Text.rich(
      WidgetSpan(
        alignment: PlaceholderAlignment.baseline,
        baseline: TextBaseline.alphabetic,
        child: math,
      ),
    );
  }
}
