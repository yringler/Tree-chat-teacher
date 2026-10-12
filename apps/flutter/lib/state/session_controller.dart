import 'dart:async';

import 'package:flutter/foundation.dart';

import '../api/models.dart';
import '../api/tangent_api.dart';
import 'notice.dart';

enum SessionStatus { loading, signedOut, signedIn, failed }

/// Who is signed in, and who pays for their replies.
class SessionController extends ChangeNotifier {
  SessionController(this.api);

  final TangentApi api;

  SessionStatus _status = SessionStatus.loading;
  SessionStatus get status => _status;

  Me? _me;
  Me? get me => _me;

  Payer _payer = Payer.ownKey;
  Payer get payer => _payer;

  /// Learn's choice (learnPayer in packages/shared/src/learn-payer.ts,
  /// without a saved key): credit the user has, else the open pool while it
  /// runs, else credit to buy, else the user's own key, which the web app
  /// manages.
  Future<void> start() async {
    // Signed out, the sign-in page stays up while this checks again.
    if (_status != SessionStatus.signedOut) {
      _status = SessionStatus.loading;
      notifyListeners();
    }
    final Me me;
    try {
      me = await api.me();
    } on Object catch (error) {
      _me = null;
      _status = isUnauthorized(error)
          ? SessionStatus.signedOut
          : SessionStatus.failed;
      notifyListeners();
      return;
    }
    if (!me.devMode) unawaited(_refreshSession());
    _payer = await _choosePayer(me);
    api.payer = _payer;
    _me = me;
    _status = SessionStatus.signedIn;
    notifyListeners();
  }

  Future<void> signOut() async {
    try {
      await api.signOut();
    } on Object {
      // Signed out here either way; a stale cookie fails the next call.
    }
    signedOut();
  }

  /// A call answered `unauthorized`: the session ended elsewhere.
  void signedOut() {
    if (_status == SessionStatus.signedOut) return;
    _me = null;
    _status = SessionStatus.signedOut;
    notifyListeners();
  }

  Future<Payer> _choosePayer(Me me) async {
    if (me.builtInCredit) {
      try {
        if ((await api.billing()).availableMicros > 0) return Payer.credit;
      } on Object {
        // Without the balance, the pool or buying credit still decides.
      }
    }
    try {
      if ((await api.poolStatus()).enabled) return Payer.pool;
    } on Object {
      // Without the pool's status, fall through to the other payers.
    }
    return me.builtInCredit ? Payer.credit : Payer.ownKey;
  }

  /// Rolls the session cookie forward so an active learner stays signed in.
  Future<void> _refreshSession() async {
    try {
      await api.refreshSession();
    } on Object {
      // Best effort: the session is still valid until it expires.
    }
  }
}
