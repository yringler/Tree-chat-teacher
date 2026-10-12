import 'dart:async';

import 'package:flutter/foundation.dart';

import '../api/tangent_api.dart';
import 'session_controller.dart';

/// Where the first-run walkthrough is. [off]: not started (or the account
/// has had it); [done]: finished or skipped here. The three steps in
/// between are the loop it walks once: go on a [tangent], head [back] to
/// the main thread, then reply with [next].
enum WalkthroughPhase { off, tangent, back, next, done }

/// The walkthrough's phase, and whether its coach mark is [shown]: each step
/// waits until the screen has what it points at (a lesson with no reply yet,
/// a tangent not yet entered).
typedef WalkthroughState = ({WalkthroughPhase phase, bool shown});

/// What the chat page tells the walkthrough about the screen, and what the
/// learner does with it.
enum WalkthroughEvent {
  start,
  trunkReplyReady,
  enteredTangent,
  backOnTrunk,
  replied,
  next,
  skip,
}

const walkthroughOff = (phase: WalkthroughPhase.off, shown: false);

/// The walkthrough's one rule, pure, as walkthroughStep in
/// packages/web-shared/src/walkthrough/walkthrough.ts: the loop of going on
/// a tangent, heading back and replying, each step shown when the learner
/// reaches it.
/// - Step 1 (Tangent ↳) waits for a reply on the main thread.
/// - Step 2 (back to the main thread) shows inside any tangent, however it
///   was entered; entering one before step 1 showed skips straight to it.
/// - Step 3 (Next ➜) shows back on the main thread after step 2.
/// "Got it" puts a step away and waits for the next one; Done on step 3,
/// replying with Next ➜ while step 3 shows (what it asks for) and Skip end it.
WalkthroughState walkthroughStep(WalkthroughState s, WalkthroughEvent e) {
  const done = (phase: WalkthroughPhase.done, shown: false);
  if (e == WalkthroughEvent.start) {
    return (phase: WalkthroughPhase.tangent, shown: false);
  }
  if (s.phase == WalkthroughPhase.off || s.phase == WalkthroughPhase.done) {
    return s;
  }
  return switch (e) {
    WalkthroughEvent.start => s,
    WalkthroughEvent.skip => done,
    WalkthroughEvent.next when !s.shown => s,
    WalkthroughEvent.next => switch (s.phase) {
      WalkthroughPhase.tangent => (phase: WalkthroughPhase.back, shown: false),
      WalkthroughPhase.back => (phase: WalkthroughPhase.next, shown: false),
      _ => done,
    },
    WalkthroughEvent.replied =>
      s.phase == WalkthroughPhase.next && s.shown ? done : s,
    WalkthroughEvent.trunkReplyReady =>
      s.phase == WalkthroughPhase.tangent
          ? (phase: WalkthroughPhase.tangent, shown: true)
          : s,
    WalkthroughEvent.enteredTangent =>
      s.phase == WalkthroughPhase.tangent ||
              (s.phase == WalkthroughPhase.back && !s.shown)
          ? (phase: WalkthroughPhase.back, shown: true)
          : s,
    WalkthroughEvent.backOnTrunk =>
      (s.phase == WalkthroughPhase.back && s.shown) ||
              (s.phase == WalkthroughPhase.next && !s.shown)
          ? (phase: WalkthroughPhase.next, shown: true)
          : s,
  };
}

/// The first-run walkthrough: three coach marks that take the learner once
/// round the loop (tangent, back, reply). It runs while the account's
/// `walkthroughDoneAt` is null, and finishing or skipping it tells the
/// server once, so it never comes back on another device or in Learn on
/// the web. The chat page reports the screen ([onTrunkReplyReady],
/// [onEnteredTangent], [onBackOnTrunk]) and a reply sent with Next ➜
/// ([onRepliedOnTrunk]), and shows [showing].
class WalkthroughController extends ChangeNotifier {
  WalkthroughController({required this.api, required this.session}) {
    session.addListener(_onSession);
  }

  final TangentApi api;
  final SessionController session;

  WalkthroughState _state = walkthroughOff;
  WalkthroughState get state => _state;

  /// The server was asked whether the account has had it.
  bool _started = false;

  /// The server knows the account has had it: nothing more to tell it.
  bool _saved = false;

  /// The step whose coach mark is on screen, or null.
  WalkthroughPhase? get showing => switch (_state) {
    (phase: WalkthroughPhase.off || WalkthroughPhase.done, shown: _) => null,
    (:final phase, shown: true) => phase,
    _ => null,
  };

  /// Starts the walkthrough if the account hasn't had it. Asks the server
  /// once; later calls (another lesson opened) do nothing. A failed load
  /// leaves it off: a tour is never worth an error.
  Future<void> start() async {
    if (_started) return;
    _started = true;
    try {
      final settings = await api.settings();
      if (settings.walkthroughDoneAt == null) {
        _dispatch(WalkthroughEvent.start);
      } else {
        _saved = true;
      }
    } on Object catch (error) {
      debugPrint('Could not load the walkthrough setting: $error');
    }
  }

  /// The main thread has a complete reply, with Tangent ↳ under it.
  void onTrunkReplyReady() => _dispatch(WalkthroughEvent.trunkReplyReady);

  /// The branch on screen is a tangent.
  void onEnteredTangent() => _dispatch(WalkthroughEvent.enteredTangent);

  /// The main thread is on screen again, with Next ➜ under its reply.
  void onBackOnTrunk() => _dispatch(WalkthroughEvent.backOnTrunk);

  /// Next ➜ sent a reply on the main thread: on step 3, that ends the tour.
  void onRepliedOnTrunk() => _dispatch(WalkthroughEvent.replied);

  /// "Got it", or Done on the last step.
  void next() => _dispatch(WalkthroughEvent.next);

  /// "Skip tour", or Escape.
  void skip() => _dispatch(WalkthroughEvent.skip);

  /// From the help sheet: once more from step 1. The server is told only if
  /// it hasn't been yet (a replay of the first run still in progress).
  void replay() => _dispatch(WalkthroughEvent.start);

  void _dispatch(WalkthroughEvent event) {
    final next = walkthroughStep(_state, event);
    if (next == _state) return;
    _state = next;
    if (next.phase == WalkthroughPhase.done) _save();
    notifyListeners();
  }

  void _save() {
    if (_saved) return;
    _saved = true;
    unawaited(
      api.markWalkthroughDone().catchError((Object error) {
        debugPrint('Could not save the walkthrough as done: $error');
      }),
    );
  }

  /// Another learner may sign in next, with a walkthrough of their own.
  void _onSession() {
    if (session.status != SessionStatus.signedOut) return;
    _started = false;
    _saved = false;
    if (_state == walkthroughOff) return;
    _state = walkthroughOff;
    notifyListeners();
  }

  @override
  void dispose() {
    session.removeListener(_onSession);
    super.dispose();
  }
}
