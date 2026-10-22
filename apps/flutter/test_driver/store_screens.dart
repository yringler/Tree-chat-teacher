import 'package:tangent/ui/tangent_help_copy.dart';

/// The store screenshots, in the order both stores show them, for both
/// harnesses: screenshots/store_screenshots.dart renders Google Play's
/// headlessly and store_app_test.dart takes the App Store's on simulators.
/// The second runs as plain Dart on the host, so this file and what it
/// imports stay free of Flutter.
///
/// The stores show the first shots in search results, so the order is the
/// story: a reply, a tangent from it, the way back, then the rest.
final storeShots = <StoreShot>[
  (
    name: 'lesson-reply',
    screen: 'lesson-reply',
    action: const NoAction(),
    shows: digDeeperLabel,
  ),
  (
    name: 'in-tangent',
    screen: 'in-tangent',
    action: const NoAction(),
    shows: digDeeperLabel,
  ),
  (
    name: 'back-on-trunk',
    screen: 'back-on-trunk',
    action: const NoAction(),
    shows: yourTangentsLabel,
  ),
  (
    name: 'tangents',
    screen: 'tangents',
    action: const TapTooltip('Tangents'),
    // The heading of the outline the button opens.
    shows: 'Tangents',
  ),
  (
    name: 'walkthrough-1',
    screen: 'coach1',
    action: const NoAction(),
    shows: walkthroughSteps.tangent,
  ),
  (
    name: 'walkthrough-2',
    screen: 'coach2',
    action: const NoAction(),
    shows: walkthroughSteps.back,
  ),
  (
    name: 'walkthrough-3',
    screen: 'coach3',
    action: const TapText(mainThreadLabel),
    shows: walkthroughSteps.next,
  ),
  (
    name: 'help',
    screen: 'lesson-reply',
    action: const TapTooltip(helpTitle),
    shows: helpRule,
  ),
  (
    name: 'lessons',
    screen: 'help',
    action: const NoAction(),
    shows: 'Your lessons',
  ),
];

/// One shot: its file [name], the screen_api.dart `screenLocations` name of
/// the [screen] the app opens on, what to do there before the shot, and a
/// text the shot [shows] once it is ready.
typedef StoreShot = ({
  String name,
  String screen,
  ShotAction action,
  String shows,
});

/// What a harness does on a screen before the shot. Each maps it to its
/// own finder: flutter_test's and flutter_driver's are different types.
sealed class ShotAction {
  const ShotAction();
}

/// Shoot the screen as it opens.
final class NoAction extends ShotAction {
  const NoAction();
}

/// Tap the first text that reads [text].
final class TapText extends ShotAction {
  const TapText(this.text);

  final String text;
}

/// Tap the button whose tooltip is [message].
final class TapTooltip extends ShotAction {
  const TapTooltip(this.message);

  final String message;
}
