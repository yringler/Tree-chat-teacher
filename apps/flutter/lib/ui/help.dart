import 'dart:async';

import 'package:flutter/material.dart';

import '../state/app_scope.dart';
import 'tangent_help_copy.dart';
import 'theme.dart';

/// Opens "How tangents work": a bottom sheet on a phone, a dialog on a
/// wider screen. [showReplay] offers to replay the first-run walkthrough.
///
/// There is no "Keyboard shortcuts" link, unlike the web sheet: the app has
/// no list of shortcuts to open.
Future<void> showTangentHelp(BuildContext context, {bool showReplay = true}) {
  final help = TangentHelp(showReplay: showReplay);
  if (MediaQuery.sizeOf(context).width < 600) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      useSafeArea: true,
      builder: (context) => SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: help,
      ),
    );
  }
  return showDialog<void>(
    context: context,
    builder: (context) => Dialog(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 480),
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: help,
        ),
      ),
    ),
  );
}

/// The "?" of an app bar: opens [showTangentHelp].
class HelpButton extends StatelessWidget {
  const HelpButton({super.key});

  @override
  Widget build(BuildContext context) => IconButton(
    tooltip: helpTitle,
    icon: const Icon(Icons.help_outline),
    onPressed: () => unawaited(showTangentHelp(context)),
  );
}

/// When to reply and when to go on a tangent, short enough to read at a
/// glance: the words of the web's help sheet (tangent_help_copy.dart), with
/// the two actions wearing the look of the composer's buttons, so the help
/// names what the learner sees.
class TangentHelp extends StatelessWidget {
  const TangentHelp({super.key, this.showReplay = true});

  final bool showReplay;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodyMedium?.copyWith(
      color: TangentColors.of(context).fgMuted,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(helpTitle, style: theme.textTheme.titleLarge),
        const SizedBox(height: 8),
        Text(
          helpRule,
          style: theme.textTheme.bodyLarge?.copyWith(
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 12),
        const _Diagram(),
        const SizedBox(height: 12),
        for (final item in helpItems)
          _Item(
            label: _ActionChip(
              label: item.label,
              primary: item.label == tangentAction.label,
            ),
            text: item.text,
          ),
        _Item(
          label: Text(
            helpDefault.label,
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          text: helpDefault.text,
        ),
        const SizedBox(height: 4),
        Text(helpTest, style: muted),
        const SizedBox(height: 8),
        Text(helpAnalogy, style: muted),
        if (showReplay) ...[
          const SizedBox(height: 16),
          OutlinedButton.icon(
            onPressed: () {
              AppScope.of(context).walkthrough.replay();
              Navigator.of(context).pop();
            },
            icon: const Icon(Icons.replay, size: 18),
            label: const Text(helpReplay),
          ),
        ],
      ],
    );
  }
}

/// One line of the help: what it is about, then what it says.
class _Item extends StatelessWidget {
  const _Item({required this.label, required this.text});

  final Widget label;
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 112,
          child: Align(alignment: Alignment.topLeft, child: label),
        ),
        const SizedBox(width: 8),
        Expanded(child: Text(text)),
      ],
    ),
  );
}

/// An action's label as its button shows it: filled for the tangent, the
/// recommended default, outlined for the next step.
class _ActionChip extends StatelessWidget {
  const _ActionChip({required this.label, required this.primary});

  final String label;
  final bool primary;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: ShapeDecoration(
        color: primary ? scheme.primary : null,
        shape: StadiumBorder(
          side: primary
              ? BorderSide.none
              : BorderSide(color: TangentColors.of(context).border),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        child: Text(
          label,
          style: Theme.of(context).textTheme.labelLarge
              ?.copyWith(color: primary ? scheme.onPrimary : scheme.primary),
        ),
      ),
    );
  }
}

/// A main thread running on, with two tangents hanging off it; it fades in.
class _Diagram extends StatelessWidget {
  const _Diagram();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final painter = _DiagramPainter(
      main: theme.colorScheme.onSurface,
      side: theme.colorScheme.primary,
      label: theme.textTheme.bodySmall ?? const TextStyle(fontSize: 12),
      textDirection: Directionality.of(context),
    );
    final still = MediaQuery.disableAnimationsOf(context);
    return Semantics(
      label: 'A main thread running on, with two tangents hanging off it',
      image: true,
      excludeSemantics: true,
      child: TweenAnimationBuilder<double>(
        tween: Tween(begin: still ? 1 : 0, end: 1),
        duration: const Duration(milliseconds: 400),
        curve: Curves.easeOut,
        builder: (context, opacity, child) =>
            Opacity(opacity: opacity, child: child),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 360),
          child: AspectRatio(
            aspectRatio: 280 / 80,
            child: CustomPaint(painter: painter),
          ),
        ),
      ),
    );
  }
}

class _DiagramPainter extends CustomPainter {
  _DiagramPainter({
    required this.main,
    required this.side,
    required this.label,
    required this.textDirection,
  });

  final Color main;
  final Color side;
  final TextStyle label;
  final TextDirection textDirection;

  @override
  void paint(Canvas canvas, Size size) {
    // Drawn on a 280 × 80 grid, scaled to fit.
    final scale = size.width / 280;
    canvas.scale(scale);
    final mainPaint = Paint()
      ..color = main
      ..strokeWidth = 2.5
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round;
    final sidePaint = Paint()
      ..color = side
      ..strokeWidth = 2
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round;
    canvas.drawLine(const Offset(12, 18), const Offset(268, 18), mainPaint);
    for (final x in const [70.0, 174.0]) {
      canvas.drawPath(
        Path()
          ..moveTo(x, 18)
          ..lineTo(x, 50)
          ..arcToPoint(Offset(x + 8, 58), radius: const Radius.circular(8))
          ..lineTo(x + 58, 58),
        sidePaint,
      );
      canvas.drawCircle(Offset(x + 58, 58), 4, Paint()..color = side);
      _text(canvas, 'Tangent', Offset(x + 12, 62), side);
    }
    for (final x in const [12.0, 70.0, 174.0, 268.0]) {
      canvas.drawCircle(Offset(x, 18), 4, Paint()..color = main);
    }
    _text(canvas, mainThreadLabel, const Offset(86, 0), main);
  }

  void _text(Canvas canvas, String text, Offset at, Color color) {
    final painter = TextPainter(
      text: TextSpan(
        text: text,
        style: label.copyWith(color: color, fontSize: 11),
      ),
      textDirection: textDirection,
    )..layout();
    painter.paint(canvas, at);
    painter.dispose();
  }

  @override
  bool shouldRepaint(_DiagramPainter old) =>
      old.main != main || old.side != side || old.label != label;
}
