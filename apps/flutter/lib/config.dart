import 'package:flutter/foundation.dart';

/// The Worker's origin. On the web the app is served by the Worker itself, so
/// the API is on the page's own origin; a native build is pointed at one with
/// `--dart-define=TANGENT_BASE_URL=https://…`.
Uri apiBaseUri() {
  if (kIsWeb) return Uri.parse(Uri.base.origin);
  return Uri.parse(
    const String.fromEnvironment(
      'TANGENT_BASE_URL',
      defaultValue: 'https://tangentailearning.com',
    ),
  );
}
