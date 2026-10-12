import 'package:flutter/widgets.dart';

import '../api/tangent_api.dart';
import 'lessons_controller.dart';
import 'session_controller.dart';
import 'walkthrough_controller.dart';

/// The app-wide controllers, for the pages below. Pages listen to the
/// controllers they show themselves (ListenableBuilder), and the scope never
/// changes, so reading it creates no dependency and works in initState.
class AppScope extends InheritedWidget {
  const AppScope({
    super.key,
    required this.api,
    required this.session,
    required this.lessons,
    required this.walkthrough,
    required super.child,
  });

  final TangentApi api;
  final SessionController session;
  final LessonsController lessons;
  final WalkthroughController walkthrough;

  static AppScope of(BuildContext context) {
    final scope = context.getInheritedWidgetOfExactType<AppScope>();
    assert(scope != null, 'No AppScope above this widget');
    return scope!;
  }

  @override
  bool updateShouldNotify(AppScope oldWidget) =>
      api != oldWidget.api ||
      session != oldWidget.session ||
      lessons != oldWidget.lessons ||
      walkthrough != oldWidget.walkthrough;
}
