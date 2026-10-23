import 'dart:async';

import 'package:flutter/foundation.dart';

import '../api/models.dart';
import '../api/tangent_api.dart';
import 'learn_reply.dart';
import 'session_controller.dart';

/// The learner's Advanced settings (the model tier and the reply length),
/// saved with the account. The server reads them for each reply it pays
/// from the learner's key or credit, so this only shows and saves them;
/// until they load, the defaults show. Loaded on sign-in, forgotten on
/// sign-out. What it shows also depends on who pays, so a widget showing
/// [indicator] listens to the session as well.
class ReplySettingsController extends ChangeNotifier {
  ReplySettingsController({required this.api, required this.session}) {
    session.addListener(_onSession);
    _onSession();
  }

  final TangentApi api;
  final SessionController session;

  LearnReplySettings _settings = LearnReplySettings.defaults;
  LearnReplySettings get settings => _settings;

  /// The settings were asked for since the last sign-in.
  bool _loaded = false;

  /// Counts saves, so only the latest one's answer is shown.
  int _saves = 0;

  /// The open pool pays, so neither setting applies.
  bool get pool => session.payer == Payer.pool;

  /// The own Anthropic key has one model, so the tier doesn't apply.
  bool get fixedModel =>
      session.payer == Payer.ownKey && session.replyKey == LearnKey.anthropic;

  /// The composer chip; null while every setting that applies is the default.
  LearnReplyIndicator? get indicator =>
      learnReplyIndicator(_settings, pool: pool, fixedModel: fixedModel);

  /// Saves [tier] or [replyLength] at once, showing it before the server
  /// answers. A refused save goes back to what was shown before it and
  /// rethrows, for the caller to say so.
  Future<void> save({ModelTier? tier, ReplyLength? replyLength}) async {
    final before = _settings;
    final seq = ++_saves;
    _set(before.copyWith(tier: tier, replyLength: replyLength));
    try {
      final saved = await api.updateLearnReply(
        tier: tier,
        replyLength: replyLength,
      );
      if (seq == _saves) _set(saved);
    } on Object {
      if (seq == _saves) _set(before);
      rethrow;
    }
  }

  /// Back to Normal and Normal, in one save.
  Future<void> reset() => save(
    tier: LearnReplySettings.defaults.tier,
    replyLength: LearnReplySettings.defaults.replyLength,
  );

  Future<void> _load() async {
    try {
      _set((await api.settings()).learn);
    } on Object catch (error) {
      // The defaults stay on screen; the server still applies what is saved.
      debugPrint('Could not load the reply settings: $error');
    }
  }

  void _set(LearnReplySettings next) {
    if (next == _settings) return;
    _settings = next;
    notifyListeners();
  }

  void _onSession() {
    switch (session.status) {
      case SessionStatus.signedIn when !_loaded:
        _loaded = true;
        unawaited(_load());
      case SessionStatus.signedOut:
        _loaded = false;
        _set(LearnReplySettings.defaults);
      default:
        // Who pays is the session's: the chip listens to it too.
        break;
    }
  }

  @override
  void dispose() {
    session.removeListener(_onSession);
    super.dispose();
  }
}
