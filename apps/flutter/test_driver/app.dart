import 'package:flutter_driver/driver_extension.dart';
import 'package:tangent/main.dart' as app;

/// The app with Flutter Driver's extension, so a driver (or the Dart MCP
/// server's flutter_driver tool) can tap, type and take screenshots:
/// `flutter run --target test_driver/app.dart`. Only `lib/main.dart` goes
/// into a release build.
///
/// Text entry emulation stays off so the device's own keyboard still types
/// into fields; a driver that wants `enter_text` turns it on first
/// (`set_text_entry_emulation`).
void main() {
  enableFlutterDriverExtension(enableTextEntryEmulation: false);
  app.main();
}
