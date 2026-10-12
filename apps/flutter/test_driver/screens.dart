import 'package:flutter/material.dart';
import 'package:tangent/app.dart';

import 'screen_api.dart';

/// The app on a scripted backend ([ScreenApi]), so its screens can be shot
/// in a browser the same way on every run. Build and serve it:
///
///     flutter build web -t test_driver/screens.dart --base-href / \
///       --no-web-resources-cdn --output <dir>
///     python3 -m http.server -d <dir> <port>
///
/// then open `/?screen=<name>`, one of [screenLocations] (lesson-reply when
/// left out). Only `lib/main.dart` goes into a release build.
void main() {
  final asked = Uri.base.queryParameters['screen'];
  final screen = screenLocations.containsKey(asked) ? asked! : 'lesson-reply';
  runApp(
    TangentApp(
      api: ScreenApi(screen: screen),
      initialLocation: screenLocations[screen],
    ),
  );
}
