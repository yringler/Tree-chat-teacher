import 'package:flutter/material.dart';

import 'theme.dart';

/// Google's sign-in button, drawn to its branding guidelines
/// (https://developers.google.com/identity/branding-guidelines): the
/// standard-colour G, Google Sans Medium 14/20, Google's light theme on a
/// light page and its dark theme on a dark one, and 12 px before the G, 10
/// after it and 12 after the label. The web apps' button
/// (packages/web-shared/src/login/login-page.ts) looks the same.
///
/// The G is Google's own raster of it from the guidelines' download, on a
/// transparent background (assets/google/). Disabled, it fades as Google's
/// own button does.
class GoogleSignInButton extends StatelessWidget {
  const GoogleSignInButton({super.key, required this.onPressed});

  /// Null disables the button.
  final VoidCallback? onPressed;

  static const label = 'Continue with Google';

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final enabled = onPressed != null;
    final fill = dark ? const Color(0xFF131314) : const Color(0xFFFFFFFF);
    final stroke = dark ? const Color(0xFF8E918F) : const Color(0xFF747775);
    final text = dark ? const Color(0xFFE3E3E3) : const Color(0xFF1F1F1F);
    return Semantics(
      button: true,
      enabled: enabled,
      child: SizedBox(
        width: double.infinity,
        height: 40,
        child: Material(
          color: enabled ? fill : fill.withAlpha(0x61),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(radius),
            side: BorderSide(color: enabled ? stroke : text.withAlpha(0x1F)),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onPressed,
            overlayColor: WidgetStateProperty.resolveWith(
              (states) =>
                  states.contains(WidgetState.pressed) ||
                      states.contains(WidgetState.focused)
                  ? text.withAlpha(0x1F)
                  : states.contains(WidgetState.hovered)
                  ? text.withAlpha(0x14)
                  : null,
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Opacity(
                opacity: enabled ? 1 : 0.38,
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Image.asset(
                      'assets/google/g.png',
                      width: 20,
                      height: 20,
                      excludeFromSemantics: true,
                    ),
                    const SizedBox(width: 10),
                    Flexible(
                      child: Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontFamily: 'Google Sans',
                          fontWeight: FontWeight.w500,
                          fontSize: 14,
                          height: 20 / 14,
                          color: text,
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
    );
  }
}
