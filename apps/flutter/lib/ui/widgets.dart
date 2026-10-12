import 'dart:async';

import 'package:flutter/material.dart';

import '../state/notice.dart';
import 'links.dart';
import 'payment_dialog.dart';
import 'theme.dart';

const brandName = 'Tangent Learn';

/// The brand mark and name.
class Logo extends StatelessWidget {
  const Logo({super.key, this.size = 24, this.showName = true});

  final double size;
  final bool showName;

  @override
  Widget build(BuildContext context) {
    final mark = ClipRRect(
      borderRadius: BorderRadius.circular(size / 4),
      child: Image.asset(
        'assets/icon/icon.png',
        width: size,
        height: size,
        semanticLabel: showName ? null : brandName,
      ),
    );
    if (!showName) return mark;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        mark,
        const SizedBox(width: 8),
        Text(
          brandName,
          style: Theme.of(context).textTheme.titleMedium
              ?.copyWith(fontWeight: FontWeight.w600),
        ),
      ],
    );
  }
}

/// Centres [child] in the reading column.
class ContentColumn extends StatelessWidget {
  const ContentColumn({super.key, required this.child, this.padding});

  final Widget child;
  final EdgeInsetsGeometry? padding;

  @override
  Widget build(BuildContext context) => Align(
    alignment: Alignment.topCenter,
    child: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: contentMaxWidth),
      child: Padding(
        padding: padding ?? const EdgeInsets.symmetric(horizontal: 16),
        child: child,
      ),
    ),
  );
}

/// Side padding that centres a full-width scroll view's content in the
/// reading column, so the scroll bar stays at the window's edge.
EdgeInsets columnPadding(double width, {double vertical = 16}) {
  final side = width > contentMaxWidth + 32
      ? (width - contentMaxWidth) / 2
      : 16.0;
  return EdgeInsets.symmetric(horizontal: side, vertical: vertical);
}

/// An inline [Notice], with its link and a way to dismiss it.
class NoticeBanner extends StatelessWidget {
  const NoticeBanner({super.key, required this.notice, this.onDismiss});

  final Notice notice;
  final VoidCallback? onDismiss;

  @override
  Widget build(BuildContext context) {
    final tokens = TangentColors.of(context);
    final link = notice.link;
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 8, 4, 8),
      decoration: BoxDecoration(
        color: tokens.warnSoft,
        borderRadius: BorderRadius.circular(radius),
      ),
      child: Row(
        children: [
          Expanded(
            child: Semantics(
              liveRegion: true,
              child: Text(notice.text, style: const TextStyle(fontSize: 15)),
            ),
          ),
          if (link != null)
            TextButton(
              onPressed: () => openLink(context, link.path),
              child: Text(link.label),
            ),
          if (notice.choosePayment)
            TextButton(
              onPressed: () =>
                  unawaited(showPaymentDialog(context, refused: true)),
              child: const Text('How you pay'),
            ),
          if (onDismiss != null)
            IconButton(
              tooltip: 'Dismiss',
              icon: const Icon(Icons.close, size: 18),
              onPressed: onDismiss,
            ),
        ],
      ),
    );
  }
}

/// A lesson's title as the learner sees it: the server's default title is
/// power-mode wording.
String lessonTitle(String title) =>
    title.isEmpty || title == 'New conversation' ? 'New lesson' : title;
