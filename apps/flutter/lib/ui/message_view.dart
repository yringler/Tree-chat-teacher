import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../api/models.dart';
import '../api/tangents.dart';
import 'lesson_outline.dart';
import 'links.dart';
import 'math_markdown.dart';
import 'mermaid_markdown.dart';
import 'tangent_help_copy.dart';
import 'theme.dart';

/// One message of the thread: the learner's, or the tutor's reply rendered
/// as Markdown with its footer once it's complete: the tangents the learner
/// started from it first, next steps ("Keep going") on the newest reply
/// only, then the tangents it suggests.
class MessageView extends StatelessWidget {
  const MessageView({
    super.key,
    required this.node,
    required this.status,
    required this.tangents,
    required this.chainIds,
    required this.onFollow,
    required this.onOpenTangent,
    required this.onAskAbout,
    this.latest = false,
    this.onContinue,
  });

  final ChatNode node;

  /// Transient progress text while the reply is written.
  final String? status;

  /// The tangents started from this message, in the server's order. One
  /// titled like a suggested tangent follows that suggestion.
  final List<Branch> tangents;

  /// The branches from the main thread down to the one on screen.
  final Set<String> chainIds;

  /// Starts a tangent that follows a suggestion; null while that isn't
  /// possible (e.g. a send is in flight).
  final ValueChanged<Tangent>? onFollow;

  /// The newest reply of the thread on screen. Only it offers next steps:
  /// on an older reply, the thread has already moved on.
  final bool latest;

  /// Sends a next step as a reply on the thread on screen; null while that
  /// isn't possible.
  final ValueChanged<Tangent>? onContinue;

  final ValueChanged<Branch> onOpenTangent;

  /// "Ask about this" on words selected in a finished reply.
  final ValueChanged<String> onAskAbout;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = TangentColors.of(context);
    final isUser = node.role == Role.user;
    final label = Text(
      isUser ? 'You' : 'Tutor',
      style: theme.textTheme.labelMedium?.copyWith(color: tokens.fgMuted),
    );
    if (isUser) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            label,
            const SizedBox(height: 4),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: tokens.userBg,
                borderRadius: BorderRadius.circular(radius),
              ),
              child: SelectableText(node.content),
            ),
          ],
        ),
      );
    }
    final split = splitTangents(node.content);
    final streaming = node.status == NodeStatus.streaming;
    final complete = node.status == NodeStatus.complete;
    final suggestions = complete ? split.tangents : const <Tangent>[];
    final groups = groupTangents(suggestions);
    final nextSteps = latest ? groups.continueOn : const <Tangent>[];
    final footer = tangentFooter(
      suggestions,
      tangents,
      titleOf: (b) => b.title,
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          label,
          if (streaming && status != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                status!,
                style: theme.textTheme.bodySmall?.copyWith(
                  fontStyle: FontStyle.italic,
                ),
              ),
            ),
          if (split.body.isNotEmpty)
            _SelectableReply(
              onAskAbout: complete ? onAskAbout : null,
              child: _Markdown(split.body, streaming: streaming),
            ),
          if (streaming) const BlinkingCursor(),
          if (node.status == NodeStatus.error) _ErrorBox(node),
          if (footer.yours.isNotEmpty)
            _YourTangents(
              tangents: footer.yours,
              suggested: groups.tangent,
              chainIds: chainIds,
              onOpen: onOpenTangent,
            ),
          if (nextSteps.isNotEmpty)
            _KeepGoing(steps: nextSteps, onContinue: onContinue),
          if (footer.offers.isNotEmpty)
            _SuggestedTangents(
              id: node.id,
              offers: footer.offers,
              folded: footer.folded,
              followed: footer.followed,
              onFollow: onFollow,
            ),
        ],
      ),
    );
  }
}

/// The longest quote a tangent can ask about (the API's limit).
const maxQuote = 10000;

/// A reply's text, selectable as a whole; with [onAskAbout], the selection's
/// menu offers "Ask about this" for the selected words.
class _SelectableReply extends StatefulWidget {
  const _SelectableReply({required this.onAskAbout, required this.child});

  final ValueChanged<String>? onAskAbout;
  final Widget child;

  @override
  State<_SelectableReply> createState() => _SelectableReplyState();
}

class _SelectableReplyState extends State<_SelectableReply> {
  String _selected = '';

  @override
  Widget build(BuildContext context) => SelectionArea(
    onSelectionChanged: (content) =>
        _selected = content?.plainText.trim() ?? '',
    contextMenuBuilder: (context, region) {
      final ask = widget.onAskAbout;
      final quote = _selected.length > maxQuote
          ? _selected.substring(0, maxQuote)
          : _selected;
      return AdaptiveTextSelectionToolbar.buttonItems(
        anchors: region.contextMenuAnchors,
        buttonItems: [
          if (ask != null && quote.isNotEmpty)
            ContextMenuButtonItem(
              label: 'Ask about this',
              onPressed: () {
                region
                  ..hideToolbar()
                  ..clearSelection();
                ask(quote);
              },
            ),
          ...region.contextMenuButtonItems,
        ],
      );
    },
    child: widget.child,
  );
}

class _Markdown extends StatelessWidget {
  const _Markdown(this.data, {required this.streaming});
  final String data;

  /// While the reply streams, a diagram's source is incomplete, so it shows
  /// as code like any other.
  final bool streaming;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = TangentColors.of(context);
    final base = MarkdownStyleSheet.fromTheme(theme);
    final styleSheet = base.copyWith(
      p: theme.textTheme.bodyLarge,
      code: base.code?.copyWith(
        backgroundColor: tokens.sunken,
        fontSize: 15,
        fontFamily: codeFont,
        fontFamilyFallback: fallbackFonts,
      ),
      codeblockDecoration: BoxDecoration(
        color: tokens.sunken,
        borderRadius: BorderRadius.circular(radiusSmall),
      ),
      codeblockPadding: const EdgeInsets.all(12),
      blockquoteDecoration: BoxDecoration(
        border: Border(left: BorderSide(color: tokens.border, width: 3)),
      ),
    );
    return MarkdownBody(
      // The widget parses again only when its text or style changes, and a
      // reply can finish without new text, so the end of streaming makes a
      // new one that draws its diagrams.
      key: ValueKey(streaming),
      data: data,
      blockSyntaxes: [
        ...mathBlockSyntaxes,
        if (!streaming) const MermaidFenceSyntax(),
      ],
      inlineSyntaxes: mathInlineSyntaxes,
      builders: {...mathBuilders, ...mermaidBuilders(styleSheet)},
      onTapLink: (text, href, title) {
        if (href != null) openLink(context, href, newTab: true);
      },
      styleSheet: styleSheet,
    );
  }
}

/// Why a reply ended early, by its `errorKind`.
class _ErrorBox extends StatelessWidget {
  const _ErrorBox(this.node);
  final ChatNode node;

  @override
  Widget build(BuildContext context) {
    final tokens = TangentColors.of(context);
    final (headline, detail) = switch (node.errorKind) {
      'cut_off' => ('Cut off.', node.error),
      'cancelled' => ('Stopped.', null),
      _ => ('The reply failed.', node.error),
    };
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: tokens.dangerSoft,
        borderRadius: BorderRadius.circular(radiusSmall),
      ),
      child: Text.rich(
        TextSpan(
          children: [
            TextSpan(
              text: headline,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            if (detail != null && detail.isNotEmpty) TextSpan(text: ' $detail'),
            const TextSpan(text: ' To try again, send your message again.'),
          ],
        ),
        style: const TextStyle(fontSize: 15),
      ),
    );
  }
}

/// A footer group's heading, which a screen reader can jump between.
class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    // A node of its own: merged into the reply's, the header flag would make
    // the whole reply a header.
    child: Semantics(
      container: true,
      header: true,
      child: Text(text, style: Theme.of(context).textTheme.bodySmall),
    ),
  );
}

/// The tangents the learner started from a reply, whether they follow a
/// suggestion or were asked in the learner's own words. They come first and
/// never fold: under a reply, they are the one sign of where the learner
/// went from it.
class _YourTangents extends StatelessWidget {
  const _YourTangents({
    required this.tangents,
    required this.suggested,
    required this.chainIds,
    required this.onOpen,
  });

  final List<Branch> tangents;

  /// The reply's tangent suggestions, whose reason a followed one shows.
  final List<Tangent> suggested;
  final Set<String> chainIds;
  final ValueChanged<Branch> onOpen;

  @override
  Widget build(BuildContext context) {
    final whyOf = {for (final t in suggested) t.title: t.why};
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const _SectionLabel(yourTangentsLabel),
          for (final b in tangents)
            _YourTangentRow(
              title: outlineTitle(b),
              tip: _tipFor(b, whyOf[b.title]),
              lit: chainIds.contains(b.id),
              onTap: () => onOpen(b),
            ),
        ],
      ),
    );
  }

  /// What the tangent asks about: the words it quotes, else the reason of
  /// the suggestion it follows, else its title.
  static String _tipFor(Branch branch, String? why) {
    final quote = branch.anchorQuote;
    if (quote != null && quote.isNotEmpty) return quote;
    return why ?? outlineTitle(branch);
  }
}

/// One tangent the learner took: shaped like a suggestion, but marked by an
/// accent bar and a chevron, since it opens a tangent that is there rather
/// than starting one.
class _YourTangentRow extends StatelessWidget {
  const _YourTangentRow({
    required this.title,
    required this.tip,
    required this.lit,
    required this.onTap,
  });

  final String title;

  /// Shown on hover or a long press.
  final String tip;

  /// On the learner's path to the branch on screen.
  final bool lit;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final tokens = TangentColors.of(context);
    final accent = Theme.of(context).colorScheme.primary;
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Semantics(
        container: true,
        button: true,
        selected: lit,
        child: Tooltip(
          message: tip,
          // A tip that is only the title would have it read twice.
          excludeFromSemantics: tip == title,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(radius),
            // Over the outline, so the bar takes the left edge whole.
            child: DecoratedBox(
              position: DecorationPosition.foreground,
              decoration: BoxDecoration(
                border: Border(left: BorderSide(color: accent, width: 3)),
              ),
              child: Material(
                color: lit ? tokens.accentSoft : tokens.bgElev,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(radius),
                  side: BorderSide(color: lit ? accent : tokens.border),
                ),
                child: InkWell(
                  onTap: onTap,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 8,
                    ),
                    child: Row(
                      children: [
                        Icon(Icons.chevron_right, size: 18, color: accent),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            title,
                            semanticsLabel: 'Open tangent: $title',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w600,
                              height: 1.4,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The next steps the newest reply offers; one is sent as a reply.
class _KeepGoing extends StatelessWidget {
  const _KeepGoing({required this.steps, required this.onContinue});

  final List<Tangent> steps;
  final ValueChanged<Tangent>? onContinue;

  @override
  Widget build(BuildContext context) {
    final onContinue = this.onContinue;
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const _SectionLabel(keepGoingLabel),
          for (final step in steps)
            _TangentButton(
              tangent: step,
              icon: Icons.arrow_forward,
              onPressed: onContinue == null ? null : () => onContinue(step),
            ),
        ],
      ),
    );
  }
}

/// The tangents a reply suggests that the learner hasn't taken. Before they
/// take one from the reply, the first shows and the rest wait behind a row,
/// since a phone has little height to spare. Once they have ([folded]), all
/// of them wait behind one row: the learner has read them, and the footer
/// then changes only when a tangent is started, never while they read on or
/// a reply streams in.
class _SuggestedTangents extends StatefulWidget {
  const _SuggestedTangents({
    required this.id,
    required this.offers,
    required this.folded,
    required this.followed,
    required this.onFollow,
  });

  /// The reply's id, to name the rows the fold row shows.
  final String id;
  final List<Tangent> offers;
  final bool folded;

  /// How many of the reply's suggestions a tangent follows.
  final int followed;
  final ValueChanged<Tangent>? onFollow;

  @override
  State<_SuggestedTangents> createState() => _SuggestedTangentsState();
}

class _SuggestedTangentsState extends State<_SuggestedTangents> {
  /// The learner asked for the rows that are hidden.
  bool _open = false;

  @override
  void didUpdateWidget(_SuggestedTangents oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Suggestions that have just folded start out of the way.
    if (oldWidget.folded != widget.folded) _open = false;
  }

  Widget _row(Tangent tangent) {
    final onFollow = widget.onFollow;
    return _TangentButton(
      tangent: tangent,
      action: 'Start a tangent: ',
      onPressed: onFollow == null ? null : () => onFollow(tangent),
    );
  }

  Widget _foldButton(String label) => TextButton.icon(
    style: TextButton.styleFrom(
      padding: const EdgeInsets.symmetric(horizontal: 4),
    ),
    onPressed: () => setState(() => _open = !_open),
    icon: Icon(_open ? Icons.expand_less : Icons.expand_more, size: 18),
    label: Text(label),
  );

  @override
  Widget build(BuildContext context) {
    final offers = widget.offers;
    if (widget.folded) {
      final rows = 'suggested-tangents-${widget.id}';
      return Padding(
        padding: const EdgeInsets.only(top: 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // One node: the button, saying whether its rows are open.
            MergeSemantics(
              child: Semantics(
                expanded: _open,
                // Only while the rows are there: the web engine looks these
                // ids up when the set changes and drops one it can't find.
                controlsNodes: _open ? {rows} : null,
                child: _foldButton(
                  suggestedFoldLabel(offers.length, more: widget.followed > 0),
                ),
              ),
            ),
            if (_open)
              Semantics(
                identifier: rows,
                container: true,
                child: Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const _SectionLabel(suggestedTangentsLabel),
                      for (final tangent in offers) _row(tangent),
                    ],
                  ),
                ),
              ),
          ],
        ),
      );
    }
    final shown = _open ? offers : offers.take(1);
    final hidden = offers.length - shown.length;
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const _SectionLabel(suggestedTangentsLabel),
          for (final tangent in shown) _row(tangent),
          if (hidden > 0) _foldButton(suggestedFoldLabel(hidden, more: true)),
        ],
      ),
    );
  }
}

class _TangentButton extends StatelessWidget {
  const _TangentButton({
    required this.tangent,
    required this.onPressed,
    this.icon = Icons.subdirectory_arrow_right,
    this.action,
  });

  final Tangent tangent;
  final VoidCallback? onPressed;

  /// The tangent arrow, or another for a next step.
  final IconData icon;

  /// What a tap does, said before the title to a screen reader.
  final String? action;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = TangentColors.of(context);
    final why = tangent.why;
    final action = this.action;
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Semantics(
        container: true,
        button: true,
        enabled: onPressed != null,
        child: Material(
          color: tokens.bgElev,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(radius),
            side: BorderSide(color: tokens.border),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onPressed,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Row(
                children: [
                  Icon(icon, size: 18, color: theme.colorScheme.primary),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          tangent.title,
                          semanticsLabel: action == null
                              ? null
                              : '$action${tangent.title}',
                          style: const TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w600,
                            height: 1.4,
                          ),
                        ),
                        if (why != null)
                          Text(
                            why,
                            style: theme.textTheme.bodySmall?.copyWith(
                              height: 1.4,
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The end of a reply that is still being written.
class BlinkingCursor extends StatefulWidget {
  const BlinkingCursor({super.key});

  @override
  State<BlinkingCursor> createState() => _BlinkingCursorState();
}

class _BlinkingCursorState extends State<BlinkingCursor>
    with SingleTickerProviderStateMixin {
  late final _blink = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 600),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _blink.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Semantics(
    label: 'Writing…',
    child: FadeTransition(
      opacity: _blink,
      child: Container(
        margin: const EdgeInsets.only(top: 4),
        width: 9,
        height: 18,
        color: Theme.of(context).colorScheme.primary,
      ),
    ),
  );
}
