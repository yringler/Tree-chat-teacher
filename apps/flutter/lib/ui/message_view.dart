import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../api/models.dart';
import '../api/tangents.dart';
import 'links.dart';
import 'math_markdown.dart';
import 'theme.dart';

/// One message of the thread: the learner's, or the tutor's reply rendered
/// as Markdown with its tangents ("Where next?") once it's complete.
class MessageView extends StatelessWidget {
  const MessageView({
    super.key,
    required this.node,
    required this.status,
    required this.sideQuestions,
    required this.onFollow,
    required this.onOpenSideQuestion,
    required this.onAskAbout,
  });

  final ChatNode node;

  /// Transient progress text while the reply is written.
  final String? status;

  /// The side questions that fork from this message. One titled like a
  /// tangent is that tangent followed before, so following it reopens it.
  final List<Branch> sideQuestions;

  /// Null while following isn't possible (e.g. a send is in flight).
  final ValueChanged<Tangent>? onFollow;

  final ValueChanged<Branch> onOpenSideQuestion;

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
    final tangents = complete ? split.tangents : const <Tangent>[];
    final tangentTitles = {for (final t in tangents) t.title};
    final followed = {
      for (final b in sideQuestions)
        if (tangentTitles.contains(b.title)) b.title,
    };
    final others = [
      for (final b in sideQuestions)
        if (!followed.contains(b.title)) b,
    ];
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
              child: _Markdown(split.body),
            ),
          if (streaming) const BlinkingCursor(),
          if (node.status == NodeStatus.error) _ErrorBox(node),
          if (tangents.isNotEmpty)
            _Tangents(
              tangents: tangents,
              followed: followed,
              onFollow: onFollow,
            ),
          if (others.isNotEmpty)
            _SideQuestions(branches: others, onOpen: onOpenSideQuestion),
        ],
      ),
    );
  }
}

/// The longest quote a side question can ask about (the API's limit).
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
  const _Markdown(this.data);
  final String data;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = TangentColors.of(context);
    final base = MarkdownStyleSheet.fromTheme(theme);
    return MarkdownBody(
      data: data,
      blockSyntaxes: mathBlockSyntaxes,
      inlineSyntaxes: mathInlineSyntaxes,
      builders: mathBuilders,
      onTapLink: (text, href, title) {
        if (href != null) openLink(context, href, newTab: true);
      },
      styleSheet: base.copyWith(
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
      ),
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

/// The tangents a reply offers. A phone has little height to spare, so only
/// the first one and any followed before show until the learner asks for the
/// rest.
class _Tangents extends StatefulWidget {
  const _Tangents({
    required this.tangents,
    required this.followed,
    required this.onFollow,
  });

  final List<Tangent> tangents;

  /// Titles of the tangents followed before.
  final Set<String> followed;
  final ValueChanged<Tangent>? onFollow;

  @override
  State<_Tangents> createState() => _TangentsState();
}

class _TangentsState extends State<_Tangents> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final onFollow = widget.onFollow;
    final shown = _expanded
        ? widget.tangents
        : [
            for (final (i, t) in widget.tangents.indexed)
              if (i == 0 || widget.followed.contains(t.title)) t,
          ];
    final hidden = widget.tangents.length - shown.length;
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Where next?', style: theme.textTheme.bodySmall),
          const SizedBox(height: 6),
          for (final tangent in shown)
            _TangentButton(
              tangent: tangent,
              followed: widget.followed.contains(tangent.title),
              onPressed: onFollow == null ? null : () => onFollow(tangent),
            ),
          if (hidden > 0)
            TextButton.icon(
              style: TextButton.styleFrom(
                padding: const EdgeInsets.symmetric(horizontal: 4),
              ),
              onPressed: () => setState(() => _expanded = true),
              icon: const Icon(Icons.expand_more, size: 18),
              label: Text('$hidden more'),
            ),
        ],
      ),
    );
  }
}

/// Side questions from this message that aren't one of its tangents, such as
/// one the learner asked in their own words.
class _SideQuestions extends StatelessWidget {
  const _SideQuestions({required this.branches, required this.onOpen});

  final List<Branch> branches;
  final ValueChanged<Branch> onOpen;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final count = branches.length;
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            count == 1 ? '1 side question' : '$count side questions',
            style: theme.textTheme.bodySmall,
          ),
          const SizedBox(height: 6),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final b in branches)
                ActionChip(
                  avatar: Icon(
                    Icons.chevron_right,
                    size: 18,
                    color: theme.colorScheme.primary,
                  ),
                  label: Text(
                    b.title.isEmpty ? 'Side question' : b.title,
                    overflow: TextOverflow.ellipsis,
                  ),
                  onPressed: () => onOpen(b),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _TangentButton extends StatelessWidget {
  const _TangentButton({
    required this.tangent,
    required this.followed,
    required this.onPressed,
  });

  final Tangent tangent;
  final bool followed;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = TangentColors.of(context);
    final why = tangent.why;
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Material(
        color: followed ? tokens.accentSoft : tokens.bgElev,
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
                Icon(
                  followed ? Icons.chevron_right : Icons.call_split,
                  size: 18,
                  color: theme.colorScheme.primary,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        tangent.title,
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
