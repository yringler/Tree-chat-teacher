import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../api/models.dart';
import '../api/tangents.dart';
import 'links.dart';
import 'theme.dart';

/// One message of the thread: the learner's, or the tutor's reply rendered
/// as Markdown with its tangents ("Where next?") once it's complete.
class MessageView extends StatelessWidget {
  const MessageView({
    super.key,
    required this.node,
    required this.status,
    required this.followed,
    required this.onFollow,
  });

  final ChatNode node;

  /// Transient progress text while the reply is written.
  final String? status;

  /// Whether a tangent was followed before, so following it reopens that.
  final bool Function(Tangent tangent) followed;

  /// Null while following isn't possible (e.g. a send is in flight).
  final ValueChanged<Tangent>? onFollow;

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
          if (split.body.isNotEmpty) _Markdown(split.body),
          if (streaming) const BlinkingCursor(),
          if (node.status == NodeStatus.error) _ErrorBox(node),
          if (complete && split.tangents.isNotEmpty)
            _Tangents(
              tangents: split.tangents,
              followed: followed,
              onFollow: onFollow,
            ),
        ],
      ),
    );
  }
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
      selectable: true,
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

class _Tangents extends StatelessWidget {
  const _Tangents({
    required this.tangents,
    required this.followed,
    required this.onFollow,
  });

  final List<Tangent> tangents;
  final bool Function(Tangent tangent) followed;
  final ValueChanged<Tangent>? onFollow;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Where next?', style: theme.textTheme.bodySmall),
          const SizedBox(height: 6),
          for (final tangent in tangents)
            _TangentButton(
              tangent: tangent,
              followed: followed(tangent),
              onPressed: onFollow == null ? null : () => onFollow!(tangent),
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
