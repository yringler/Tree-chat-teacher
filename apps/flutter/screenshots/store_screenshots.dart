import 'dart:convert';
import 'dart:io';

import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:tangent/app.dart';

import '../test_driver/screen_api.dart';
import '../test_driver/store_screens.dart';

/// Store screenshots, rendered headlessly by `flutter test` on the scripted
/// backend of test_driver/screen_api.dart: no emulator, no status bar, the
/// same pixels on every run, as opaque 24-bit PNGs, which is what Google
/// Play takes. play_store_screenshots_test.dart is the entry point, with the
/// devices; `pnpm --filter @tangent/flutter screenshots` runs it.

class Device {
  const Device(this.physicalSize, this.devicePixelRatio);

  final Size physicalSize;
  final double devicePixelRatio;
}

/// A test for every one of [storeShots] on every one of [devices], each
/// saving its shot to [path], given the device's name and the shot's.
void shootScreens({
  required Map<String, Device> devices,
  required String Function(String device, String shot) path,
}) {
  setUpAll(_loadAppFonts);

  for (final MapEntry(key: device, value: spec) in devices.entries) {
    for (final (:name, :screen, :action, :shows) in storeShots) {
      testWidgets('$device/$name', (tester) async {
        tester.view
          ..physicalSize = spec.physicalSize
          ..devicePixelRatio = spec.devicePixelRatio;
        addTearDown(tester.view.reset);
        // The test binding draws shadows as outlines so goldens stay stable;
        // a store screenshot wants the real ones. It checks the setting is
        // back before any tear-down runs, hence the finally.
        debugDisableShadows = false;
        try {
          await tester.pumpWidget(
            TangentApp(
              api: ScreenApi(screen: screen),
              initialLocation: screenLocations[screen],
            ),
          );
          await _settle(tester);
          await _act(tester, action);
          await _settle(tester);
          expect(find.text(shows), findsWidgets);
          await _save(tester, path(device, name));
        } finally {
          debugDisableShadows = true;
        }
      });
    }
  }
}

/// Does [action] with flutter_test's finders.
Future<void> _act(WidgetTester tester, ShotAction action) => switch (action) {
  NoAction() => Future.value(),
  TapText(:final text) => tester.tap(find.text(text).first),
  TapTooltip(:final message) => tester.tap(find.byTooltip(message)),
};

/// Lets the scripted backend answer, the images decode and every
/// animation finish.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 50)),
    );
    await tester.pumpAndSettle();
  }
}

/// The test binding renders text in a box font until the real fonts are
/// loaded: every family in the font manifest, which holds the app's own
/// (pubspec.yaml), the packages' (KaTeX's from flutter_math_fork) and
/// Material's icons.
Future<void> _loadAppFonts() async {
  final manifest = jsonDecode(
    await rootBundle.loadString('FontManifest.json'),
  ) as List<dynamic>;
  for (final family in manifest.cast<Map<String, dynamic>>()) {
    final loader = FontLoader(family['family'] as String);
    for (final font
        in (family['fonts'] as List<dynamic>).cast<Map<String, dynamic>>()) {
      loader.addFont(rootBundle.load(font['asset'] as String));
    }
    await loader.load();
  }
}

/// The whole window at its physical size, flattened onto white: Play
/// refuses screenshots with an alpha channel.
Future<void> _save(WidgetTester tester, String path) async {
  final view = tester.binding.renderViews.single;
  final layer = view.debugLayer! as OffsetLayer;
  await tester.runAsync(() async {
    final image = await layer.toImage(view.paintBounds);
    final bytes = await image.toByteData();
    final rgba = img.Image.fromBytes(
      width: image.width,
      height: image.height,
      bytes: bytes!.buffer,
      numChannels: 4,
      order: img.ChannelOrder.rgba,
    );
    image.dispose();
    final rgb = img.Image(width: rgba.width, height: rgba.height)
      ..clear(img.ColorRgb8(255, 255, 255));
    img.compositeImage(rgb, rgba);
    final file = File(path);
    await file.parent.create(recursive: true);
    await file.writeAsBytes(img.encodePng(rgb));
  });
}
