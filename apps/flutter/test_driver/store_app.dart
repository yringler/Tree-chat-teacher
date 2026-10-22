import 'package:flutter/material.dart';
import 'package:flutter_driver/driver_extension.dart';
import 'package:tangent/app.dart';

import 'screen_api.dart';

/// The app on the scripted backend of screen_api.dart, for the App Store
/// screenshots that store_app_test.dart takes on an iOS simulator. The
/// driver asks for a screen by its [screenLocations] name and the app starts
/// over on it, so one launch serves every screen. Only `lib/main.dart` goes
/// into a release build.
void main() {
  // The screen asked for, and how many have been: a new count is a new key,
  // so the app starts over even when the same screen is asked for twice.
  var screen = 'lesson-reply';
  final launches = ValueNotifier(0);
  enableFlutterDriverExtension(
    handler: (name) async {
      if (!screenLocations.containsKey(name)) return 'unknown screen $name';
      screen = name!;
      launches.value++;
      // Answers once the old screen is gone, so the driver's waitFor can't
      // find what it shows.
      await WidgetsBinding.instance.endOfFrame;
      return 'ok';
    },
    enableTextEntryEmulation: false,
  );
  runApp(
    ValueListenableBuilder(
      valueListenable: launches,
      builder: (context, launch, _) => TangentApp(
        key: ValueKey(launch),
        api: ScreenApi(screen: screen),
        initialLocation: screenLocations[screen],
      ),
    ),
  );
}
