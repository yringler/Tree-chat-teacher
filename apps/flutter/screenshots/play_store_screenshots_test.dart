import 'package:flutter/painting.dart';

import 'store_screenshots.dart';

/// Google Play's screenshots, to `store/screenshots/<device>/<screen>.png`.
/// Every one is 9:16, inside Play's 2:1 limit and at least 1080 px on its
/// short side, so each one can be featured.
const _devices = {
  // A 420 dpi phone (Pixel 7-class): 411 × 731 dp.
  'phone': Device(Size(1080, 1920), 2.625),
  // A 7-inch tablet: 600 dp wide, the width Material calls medium.
  'tablet-7': Device(Size(1080, 1920), 1.8),
  // A 10-inch tablet (Pixel Tablet-class): 800 dp wide.
  'tablet-10': Device(Size(1440, 2560), 1.8),
};

void main() => shootScreens(
  devices: _devices,
  path: (device, screen) => 'store/screenshots/$device/$screen.png',
);
