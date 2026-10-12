import 'package:flutter_driver/driver_extension.dart';
import 'package:tangent/main.dart' as app;

/// The app with Flutter Driver's extension, so a driver (or the Dart MCP
/// server's flutter_driver tool) can tap, type and take screenshots:
/// `flutter run --target test_driver/app.dart`. Only `lib/main.dart` goes
/// into a release build.
void main() {
  enableFlutterDriverExtension();
  app.main();
}
