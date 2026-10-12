import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:markdown/markdown.dart' as md;

import 'mermaid_diagram.dart' deferred as diagram;

/// Mermaid diagrams in Markdown, read by the same rules as the web renderer
/// (packages/render): a fenced code block, with backticks or tildes, whose
/// info string's first word is exactly `mermaid` becomes a `mermaid` element
/// holding its source; every other fence stays code. An unclosed fence takes
/// the rest of the text, as code does. A reply adds this syntax only once it
/// is complete, so a diagram still streaming shows as code.
class MermaidFenceSyntax extends md.FencedCodeBlockSyntax {
  const MermaidFenceSyntax();

  @override
  md.Node parse(md.BlockParser parser) {
    final pre = super.parse(parser);
    if (pre case md.Element(children: [md.Element(tag: 'code') && final code])
        when _language(code) == 'mermaid') {
      return md.Element.text('mermaid', code.textContent);
    }
    return pre;
  }

  /// The info string's first word. The markdown package splits it at the
  /// first space only, so a tab after the language is split off here.
  static String? _language(md.Element code) {
    const prefix = 'language-';
    final info = code.attributes['class'];
    if (info == null || !info.startsWith(prefix)) return null;
    return info.substring(prefix.length).split(RegExp(r'\s')).first;
  }
}

/// Diagrams longer than this aren't drawn: layout runs on the UI thread.
const maxMermaidSource = 20000;

/// Draws `mermaid` elements; one that can't be drawn shows its source in
/// [styleSheet]'s code block style.
Map<String, MarkdownElementBuilder> mermaidBuilders(
  MarkdownStyleSheet styleSheet,
) => {'mermaid': _MermaidBuilder(styleSheet)};

class _MermaidBuilder extends MarkdownElementBuilder {
  _MermaidBuilder(this.styleSheet);

  final MarkdownStyleSheet styleSheet;

  @override
  bool isBlockElement() => true;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) => MermaidBlock(source: element.textContent, styleSheet: styleSheet);
}

/// Whether the diagram library has loaded, so a diagram built after that is
/// drawn in its first frame instead of flashing its source.
bool _loaded = false;
Future<void>? _loading;

/// Loads the diagram library once; a failed load is tried again by the next
/// diagram.
Future<void> _loadDiagrams() => _loading ??= () async {
  try {
    await diagram.loadLibrary();
    _loaded = true;
  } catch (_) {
    _loading = null;
    rethrow;
  }
}();

/// One diagram: its source as code until the diagram library has loaded,
/// then the drawing, or a note and the source when it can't be drawn.
class MermaidBlock extends StatefulWidget {
  const MermaidBlock({
    super.key,
    required this.source,
    required this.styleSheet,
  });

  final String source;
  final MarkdownStyleSheet styleSheet;

  @override
  State<MermaidBlock> createState() => _MermaidBlockState();
}

class _MermaidBlockState extends State<MermaidBlock> {
  bool _loadFailed = false;
  final _scroll = ScrollController();

  bool get _tooLong => widget.source.length > maxMermaidSource;

  @override
  void initState() {
    super.initState();
    if (!_loaded && !_tooLong) {
      unawaited(
        _loadDiagrams().then(
          (_) {
            if (mounted) setState(() {});
          },
          onError: (Object _) {
            if (mounted) setState(() => _loadFailed = true);
          },
        ),
      );
    }
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final Widget child;
    if (_tooLong || _loadFailed) {
      child = _unrenderable(context);
    } else if (!_loaded) {
      child = _code();
    } else {
      child = diagram.drawMermaid(
        widget.source,
        dark: Theme.of(context).brightness == Brightness.dark,
        fallback: _unrenderable,
      );
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: child,
    );
  }

  Widget _unrenderable(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    mainAxisSize: MainAxisSize.min,
    children: [
      Text(
        'This diagram could not be drawn.',
        style: Theme.of(context).textTheme.bodySmall,
      ),
      const SizedBox(height: 4),
      _code(),
    ],
  );

  /// The source as the Markdown widget draws a code block.
  Widget _code() {
    final sheet = widget.styleSheet;
    return Container(
      clipBehavior: Clip.hardEdge,
      decoration: sheet.codeblockDecoration,
      child: Scrollbar(
        controller: _scroll,
        child: SingleChildScrollView(
          controller: _scroll,
          scrollDirection: Axis.horizontal,
          padding: sheet.codeblockPadding,
          child: Text.rich(
            TextSpan(
              style: sheet.code,
              text: widget.source.replaceAll(RegExp(r'\n$'), ''),
            ),
            textScaler: sheet.textScaler,
          ),
        ),
      ),
    );
  }
}
