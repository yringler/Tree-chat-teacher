import 'dart:io';

import 'package:flutter_driver/flutter_driver.dart';
import 'package:image/image.dart' as img;

import 'store_screens.dart';

/// Takes the App Store screenshots: drives store_app.dart through
/// [storeShots] on an iOS simulator and shoots the whole simulator screen
/// with `xcrun simctl io`, so the shots have the real iOS status bar (the
/// lane overrides it to a fixed 9:41). The `screenshots` lane in
/// ios/fastlane/Fastfile runs it once per device:
///
///     SCREENSHOT_UDID=<simulator> SCREENSHOT_DIR=<dir> SCREENSHOT_PREFIX=iphone \
///       flutter drive -t test_driver/store_app.dart -d <simulator>
///
/// It writes `<dir>/<prefix>-<nn>-<shot>.png`; deliver uploads them in file
/// name order and tells the device from the pixel size.
Future<void> main() async {
  final env = Platform.environment;
  final udid = env['SCREENSHOT_UDID']!;
  final dir = env['SCREENSHOT_DIR']!;
  final prefix = env['SCREENSHOT_PREFIX']!;

  final driver = await FlutterDriver.connect();
  try {
    for (final (i, (:name, :screen, :action, :shows)) in storeShots.indexed) {
      final answer = await driver.requestData(screen);
      if (answer != 'ok') throw StateError(answer);
      await _act(driver, action);
      await driver.waitFor(find.text(shows));
      await driver.waitUntilNoTransientCallbacks();
      final number = '${i + 1}'.padLeft(2, '0');
      await _shoot(udid, '$dir/$prefix-$number-$name.png');
      stdout.writeln('$prefix $number $name');
    }
  } finally {
    await driver.close();
  }
}

/// Does [action] with flutter_driver's finders. A tap waits for its target
/// to appear, which is the screen having loaded.
Future<void> _act(FlutterDriver driver, ShotAction action) => switch (action) {
  NoAction() => Future.value(),
  TapText(:final text) => driver.tap(find.text(text)),
  TapTooltip(:final message) => driver.tap(find.byTooltip(message)),
};

/// The simulator's screen, flattened onto white: App Store Connect refuses
/// screenshots with an alpha channel, and simctl writes one.
Future<void> _shoot(String udid, String path) async {
  final raw = '$path.raw.png';
  final result = await Process.run('xcrun', [
    'simctl',
    'io',
    udid,
    'screenshot',
    raw,
  ]);
  if (result.exitCode != 0) throw StateError('${result.stderr}');
  final rgba = img.decodePng(await File(raw).readAsBytes())!;
  final rgb = img.Image(width: rgba.width, height: rgba.height)
    ..clear(img.ColorRgb8(255, 255, 255));
  img.compositeImage(rgb, rgba);
  await File(path).writeAsBytes(img.encodePng(rgb));
  await File(raw).delete();
}
