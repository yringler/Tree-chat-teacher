import 'package:flutter/material.dart';

/// The design tokens Material's [ColorScheme] has no slot for. The values are
/// the web apps' (packages/web-shared/src/styles).
@immutable
class TangentColors extends ThemeExtension<TangentColors> {
  const TangentColors({
    required this.bgElev,
    required this.sunken,
    required this.fgMuted,
    required this.border,
    required this.accentSoft,
    required this.dangerSoft,
    required this.warn,
    required this.warnSoft,
    required this.userBg,
  });

  static const light = TangentColors(
    bgElev: Color(0xFFFFFFFF),
    sunken: Color(0xFFF2F2EF),
    fgMuted: Color(0xFF6B6B66),
    border: Color(0xFFE2E2DD),
    accentSoft: Color(0xFFE6EEFC),
    dangerSoft: Color(0xFFFBE9E7),
    warn: Color(0xFF9A6500),
    warnSoft: Color(0xFFFDF1D8),
    userBg: Color(0xFFF1F3F8),
  );

  static const dark = TangentColors(
    bgElev: Color(0xFF1F1F1E),
    sunken: Color(0xFF121212),
    fgMuted: Color(0xFF9B9B94),
    border: Color(0xFF2F2F2C),
    accentSoft: Color(0xFF1D2A42),
    dangerSoft: Color(0xFF3A1F1C),
    warn: Color(0xFFE7B35A),
    warnSoft: Color(0xFF3A2D14),
    userBg: Color(0xFF22242A),
  );

  final Color bgElev;
  final Color sunken;
  final Color fgMuted;
  final Color border;
  final Color accentSoft;
  final Color dangerSoft;
  final Color warn;
  final Color warnSoft;
  final Color userBg;

  static TangentColors of(BuildContext context) =>
      Theme.of(context).extension<TangentColors>() ?? light;

  @override
  TangentColors copyWith({
    Color? bgElev,
    Color? sunken,
    Color? fgMuted,
    Color? border,
    Color? accentSoft,
    Color? dangerSoft,
    Color? warn,
    Color? warnSoft,
    Color? userBg,
  }) => TangentColors(
    bgElev: bgElev ?? this.bgElev,
    sunken: sunken ?? this.sunken,
    fgMuted: fgMuted ?? this.fgMuted,
    border: border ?? this.border,
    accentSoft: accentSoft ?? this.accentSoft,
    dangerSoft: dangerSoft ?? this.dangerSoft,
    warn: warn ?? this.warn,
    warnSoft: warnSoft ?? this.warnSoft,
    userBg: userBg ?? this.userBg,
  );

  @override
  TangentColors lerp(TangentColors? other, double t) {
    if (other == null) return this;
    Color mix(Color a, Color b) => Color.lerp(a, b, t)!;
    return TangentColors(
      bgElev: mix(bgElev, other.bgElev),
      sunken: mix(sunken, other.sunken),
      fgMuted: mix(fgMuted, other.fgMuted),
      border: mix(border, other.border),
      accentSoft: mix(accentSoft, other.accentSoft),
      dangerSoft: mix(dangerSoft, other.dangerSoft),
      warn: mix(warn, other.warn),
      warnSoft: mix(warnSoft, other.warnSoft),
      userBg: mix(userBg, other.userBg),
    );
  }
}

const radius = 10.0;
const radiusSmall = 6.0;

/// The width of the reading column.
const contentMaxWidth = 760.0;

final lightTheme = _theme(
  brightness: Brightness.light,
  bg: const Color(0xFFFBFBFA),
  fg: const Color(0xFF1D1D1B),
  accent: const Color(0xFF2F6FDB),
  accentFg: const Color(0xFFFFFFFF),
  danger: const Color(0xFFC2372B),
  tokens: TangentColors.light,
);

final darkTheme = _theme(
  brightness: Brightness.dark,
  bg: const Color(0xFF161616),
  fg: const Color(0xFFE9E9E4),
  accent: const Color(0xFF6B9CF0),
  accentFg: const Color(0xFF0D1526),
  danger: const Color(0xFFF07A6D),
  tokens: TangentColors.dark,
);

ThemeData _theme({
  required Brightness brightness,
  required Color bg,
  required Color fg,
  required Color accent,
  required Color accentFg,
  required Color danger,
  required TangentColors tokens,
}) {
  final scheme = ColorScheme(
    brightness: brightness,
    primary: accent,
    onPrimary: accentFg,
    primaryContainer: tokens.accentSoft,
    onPrimaryContainer: fg,
    secondary: accent,
    onSecondary: accentFg,
    secondaryContainer: tokens.accentSoft,
    onSecondaryContainer: fg,
    error: danger,
    onError: bg,
    errorContainer: tokens.dangerSoft,
    onErrorContainer: fg,
    surface: bg,
    onSurface: fg,
    onSurfaceVariant: tokens.fgMuted,
    surfaceContainerLowest: tokens.bgElev,
    surfaceContainerLow: tokens.bgElev,
    surfaceContainer: tokens.bgElev,
    surfaceContainerHigh: tokens.bgElev,
    surfaceContainerHighest: tokens.sunken,
    outline: tokens.border,
    outlineVariant: tokens.border,
  );
  final base = ThemeData(colorScheme: scheme, useMaterial3: true);
  const body = TextStyle(fontSize: 17, height: 1.6);
  final shape = RoundedRectangleBorder(
    borderRadius: BorderRadius.circular(radius),
  );
  return base.copyWith(
    scaffoldBackgroundColor: bg,
    textTheme: base.textTheme.copyWith(
      bodyLarge: base.textTheme.bodyLarge?.merge(body),
      bodyMedium: base.textTheme.bodyMedium?.merge(body),
      bodySmall: base.textTheme.bodySmall?.copyWith(
        fontSize: 14,
        color: tokens.fgMuted,
      ),
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: bg,
      foregroundColor: fg,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      shape: Border(bottom: BorderSide(color: tokens.border)),
    ),
    cardTheme: CardThemeData(
      color: tokens.bgElev,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: shape.copyWith(side: BorderSide(color: tokens.border)),
    ),
    dividerTheme: DividerThemeData(color: tokens.border, space: 1),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: tokens.bgElev,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(radius),
        borderSide: BorderSide(color: tokens.border),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(radius),
        borderSide: BorderSide(color: tokens.border),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(shape: shape),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        shape: shape,
        side: BorderSide(color: tokens.border),
      ),
    ),
    chipTheme: base.chipTheme.copyWith(
      backgroundColor: tokens.bgElev,
      side: BorderSide(color: tokens.border),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(radiusSmall),
      ),
    ),
    extensions: [tokens],
  );
}
