import 'dart:math';

import 'package:flutter/material.dart';

import 'tangent_help_copy.dart';
import 'theme.dart';

/// One coach mark of the walkthrough, for an overlay above the page: a ring
/// around the control [target] holds, and a callout beside it with [text],
/// [buttonText] (Got it or Done) and Skip tour. It never blocks the page:
/// only the callout takes taps, so the learner can use the control it
/// points at, which is how the walkthrough moves on. It follows the control
/// as the layout changes, and shows nothing while the control is gone. The
/// callout also keeps clear of what [clear] holds, such as the message box
/// the control sends.
class CoachMark extends StatefulWidget {
  const CoachMark({
    super.key,
    required this.target,
    this.clear,
    required this.text,
    required this.buttonText,
    required this.onNext,
    required this.onSkip,
  });

  final GlobalKey target;
  final GlobalKey? clear;
  final String text;
  final String buttonText;
  final VoidCallback onNext;
  final VoidCallback onSkip;

  @override
  State<CoachMark> createState() => _CoachMarkState();
}

class _CoachMarkState extends State<CoachMark> {
  /// Where the target is, in this overlay's coordinates; null while it is
  /// not laid out.
  Rect? _target;

  /// Where the callout must not go: the target, and what [CoachMark.clear]
  /// holds.
  Rect? _keepClear;

  static const _gap = 12.0;
  static const _margin = 16.0;
  static const _maxWidth = 320.0;

  @override
  void initState() {
    super.initState();
    _follow();
  }

  /// Checks the target's place after every frame, which is when it can
  /// have moved; a frame only comes when something changed, so this costs
  /// nothing while the screen is still.
  void _follow() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final target = _rectOf(widget.target);
      final clear = widget.clear;
      final other = clear == null ? null : _rectOf(clear);
      final keepClear = other == null ? target : target?.expandToInclude(other);
      if (target != _target || keepClear != _keepClear) {
        setState(() {
          _target = target;
          _keepClear = keepClear;
        });
      }
      _follow();
    });
  }

  Rect? _rectOf(GlobalKey key) {
    final box = key.currentContext?.findRenderObject();
    final overlay = context.findRenderObject();
    if (box is! RenderBox || !box.attached || !box.hasSize) return null;
    if (overlay is! RenderBox || !overlay.hasSize) return null;
    final topLeft = overlay.globalToLocal(box.localToGlobal(Offset.zero));
    return topLeft & box.size;
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final target = _target;
      final keepClear = _keepClear ?? target;
      if (target == null || keepClear == null) return const SizedBox.expand();
      final size = constraints.biggest;
      final width = min(_maxWidth, size.width - 2 * _margin);
      final left = max(
        _margin,
        min(target.center.dx - width / 2, size.width - _margin - width),
      );
      // Below a control in the top half of the screen, above one lower down.
      final below = target.center.dy < size.height / 2;
      return Stack(
        children: [
          Positioned.fromRect(
            rect: target.inflate(4),
            child: const IgnorePointer(child: _Ring()),
          ),
          Positioned(
            left: left,
            width: width,
            top: below ? keepClear.bottom + _gap : null,
            bottom: below ? null : size.height - keepClear.top + _gap,
            child: _Callout(
              text: widget.text,
              buttonText: widget.buttonText,
              onNext: widget.onNext,
              onSkip: widget.onSkip,
            ),
          ),
        ],
      );
    },
  );
}

class _Ring extends StatelessWidget {
  const _Ring();

  @override
  Widget build(BuildContext context) {
    final accent = Theme.of(context).colorScheme.primary;
    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(radius + 4),
        border: Border.all(color: accent, width: 3),
        boxShadow: [
          BoxShadow(color: accent.withValues(alpha: 0.3), blurRadius: 12),
        ],
      ),
    );
  }
}

class _Callout extends StatelessWidget {
  const _Callout({
    required this.text,
    required this.buttonText,
    required this.onNext,
    required this.onSkip,
  });

  final String text;
  final String buttonText;
  final VoidCallback onNext;
  final VoidCallback onSkip;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return TweenAnimationBuilder<double>(
      // A new step fades in afresh.
      key: ValueKey(text),
      tween: Tween(
        begin: MediaQuery.disableAnimationsOf(context) ? 1 : 0,
        end: 1,
      ),
      duration: const Duration(milliseconds: 200),
      builder: (context, opacity, child) =>
          Opacity(opacity: opacity, child: child),
      child: Material(
        key: const ValueKey('coach-mark'),
        elevation: 6,
        color: TangentColors.of(context).bgElev,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radius),
          side: BorderSide(color: theme.colorScheme.primary),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 8, 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Semantics(
                liveRegion: true,
                child: Text(text, style: theme.textTheme.bodyLarge),
              ),
              const SizedBox(height: 4),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: onSkip,
                    child: Text(walkthroughButtons.skip),
                  ),
                  const SizedBox(width: 4),
                  FilledButton.tonal(
                    onPressed: onNext,
                    child: Text(buttonText),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
