import 'dart:convert';
import 'dart:io';

import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:tangent/app.dart';
import 'package:tangent/ui/help.dart';
import 'package:tangent/ui/tangent_help_copy.dart';

import '../test_driver/screen_api.dart';

/// Store screenshots, rendered headlessly by `flutter test` on the scripted
/// backend of test_driver/screen_api.dart: no emulator, no status bar, the
/// same pixels on every run. `pnpm --filter @tangent/flutter screenshots`
/// writes them to `store/screenshots/<device>/<screen>.png` as opaque 24-bit
/// PNGs, which is what Google Play takes.
///
/// Every device is 9:16, inside Play's 2:1 limit and at least 1080 px on its
/// short side, so each one can be featured.
const _devices = {
  // A 420 dpi phone (Pixel 7-class): 411 × 731 dp.
  'phone': _Device(Size(1080, 1920), 2.625),
  // A 7-inch tablet: 600 dp wide, the width Material calls medium.
  'tablet-7': _Device(Size(1080, 1920), 1.8),
  // A 10-inch tablet (Pixel Tablet-class): 800 dp wide.
  'tablet-10': _Device(Size(1440, 2560), 1.8),
};

/// The screens shot on every device: a [screenLocations] name, and what to
/// do there once it has settled.
final _screens = <String, (String, Future<void> Function(WidgetTester))>{
  'lessons': ('help', _nothing),
  'lesson-reply': ('lesson-reply', _nothing),
  'in-tangent': ('in-tangent', _nothing),
  'back-on-trunk': ('back-on-trunk', _nothing),
  'walkthrough-1': ('coach1', _nothing),
  'walkthrough-2': ('coach2', _nothing),
  'walkthrough-3': (
    'coach3',
    (tester) => tester.tap(find.text(mainThreadLabel).first),
  ),
  'help': ('lesson-reply', (tester) => tester.tap(find.byType(HelpButton))),
};

Future<void> _nothing(WidgetTester tester) async {}

class _Device {
  const _Device(this.physicalSize, this.devicePixelRatio);

  final Size physicalSize;
  final double devicePixelRatio;
}

void main() {
  setUpAll(_loadAppFonts);

  for (final MapEntry(key: device, value: spec) in _devices.entries) {
    for (final MapEntry(key: name, value: (screen, act)) in _screens.entries) {
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
          await act(tester);
          await _settle(tester);
          await _save(tester, 'store/screenshots/$device/$name.png');
        } finally {
          debugDisableShadows = true;
        }
      });
    }
  }
}

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
