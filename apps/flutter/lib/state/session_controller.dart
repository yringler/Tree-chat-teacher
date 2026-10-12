import 'dart:async';

import 'package:flutter/foundation.dart';

import '../api/models.dart';
import '../api/tangent_api.dart';
import '../api/token_store.dart';
import 'learn_payer.dart';
import 'notice.dart';

enum SessionStatus { loading, signedOut, signedIn, failed }

/// Who is signed in, and who pays for their replies.
class SessionController extends ChangeNotifier {
  SessionController(this.api, {this.choiceStore});

  final TangentApi api;

  /// Where the learner's pick of who pays is kept between launches (on the
  /// web, the same entry the web app's Learn uses); null keeps it for this
  /// run only.
  final TokenStore? choiceStore;

  SessionStatus _status = SessionStatus.loading;
  SessionStatus get status => _status;

  Me? _me;
  Me? get me => _me;

  /// The learner's own pick; null until they make one.
  Payer? _chosen;
  Payer? get chosen => _chosen;

  /// Null until read, or when it can't be.
  BillingSummary? _billing;
  BillingSummary? get billing => _billing;
  PoolStatus? _pool;
  PoolStatus? get pool => _pool;
  KeyStatus? _keyStatus;
  KeyStatus? get keyStatus => _keyStatus;

  /// Tangent credit is sold here.
  bool get creditOffered => _me?.builtInCredit ?? false;

  /// The open pool is on.
  bool get poolOn => _pool?.enabled ?? false;

  /// Credit can be bought here (anyone may); only a summary saying top-ups
  /// are off turns it off.
  bool get creditBuyable => creditOffered && (_billing?.topUpsEnabled ?? true);

  /// Credit can pay for a reply now; null while the balance isn't read.
  bool? get creditCanPay {
    final billing = _billing;
    return billing == null
        ? null
        : creditOffered && billing.availableMicros > 0;
  }

  /// Credit can be used: it can be bought, or a balance is left.
  bool get creditUsable => creditBuyable || (creditCanPay ?? false);

  /// The server refused a reply on the own key for want of a membership,
  /// which may have lapsed since [me] was read.
  bool _membershipRefused = false;

  /// Replies on the learner's own key are allowed: no membership they need
  /// is missing. Credit and the pool never need one.
  bool get ownKeyAllowed =>
      !(_me?.membershipMissing ?? false) && !_membershipRefused;

  /// The learner's OpenRouter key is saved; null until the key status is
  /// read, so a status still loading (or failed) never moves a key user onto
  /// the pool.
  bool? get hasOwnKey => _keyStatus?.hasOpenRouterKey;

  /// What replies run on: the learner's pick where it can apply, else what
  /// can reply now (see [learnPayer]).
  Payer get payer => learnPayer(
    chosen: _chosen,
    creditOffered: creditOffered,
    creditCanPay: creditCanPay,
    creditBuyable: creditBuyable,
    poolOn: poolOn,
    ownKeyReady: ownKeyAllowed && hasOwnKey != false,
  );

  /// Credit was picked but can't pay while the pool is on: replies use the
  /// pool until credit is added, and the picker still shows credit.
  bool get creditWaiting =>
      _chosen == Payer.credit &&
      payer == Payer.pool &&
      creditCanPay == false &&
      creditUsable;

  /// The way to pay the picker shows: the learner's pick where it applies,
  /// else [payer].
  Payer get picked => creditWaiting ? Payer.credit : payer;

  /// Replies run on the own key, but none is saved or the membership it
  /// needs is missing: a send would be refused.
  bool get ownKeyBlocked =>
      payer == Payer.ownKey && (!ownKeyAllowed || hasOwnKey == false);

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
    _me = me;
    _membershipRefused = false;
    await Future.wait([
      _readChoice(),
      if (me.builtInCredit) _readBilling(),
      _readPool(),
      _readKey(),
    ]);
    api.payer = payer;
    _status = SessionStatus.signedIn;
    notifyListeners();
  }

  /// Replies run on [payer] from now on, where it can apply; the pick is
  /// kept for the next launch.
  Future<void> choose(Payer payer) async {
    _chosen = payer;
    _changed();
    try {
      await choiceStore?.write(payer.header);
    } on Object {
      // Not kept: the pick lasts for this run.
    }
  }

  /// Saves the learner's OpenRouter key; a key the server or OpenRouter
  /// refuses throws, and changes nothing.
  Future<void> saveKey(String apiKey) async {
    await api.saveKey(apiKey);
    await _readKey();
    _changed();
  }

  Future<void> forgetKey() async {
    await api.forgetKey();
    await _readKey();
    _changed();
  }

  /// A call was refused with [error]: what the payer goes by may have
  /// changed (a key cleared as unreadable, a membership lapsed, credit or
  /// the pool used up), so it is read again.
  void refused(Object error) {
    if (error is! ApiException) return;
    switch (error.code) {
      case 'membership_required':
        _membershipRefused = true;
        _changed();
      case 'key_required' || 'payment_required':
      case 'pool_empty' || 'pool_cap_reached' || 'pool_unavailable':
        break;
      default:
        return;
    }
    unawaited(_refresh());
  }

  Future<void> _refresh() async {
    await Future.wait([
      if (creditOffered) _readBilling(),
      _readPool(),
      _readKey(),
    ]);
    if (_status == SessionStatus.signedIn) _changed();
  }

  Future<void> signOut() async {
    try {
      await api.signOut();
    } on Object {
      // Signed out here either way; a stale cookie fails the next call.
    }
    signedOut();
  }

  /// Deletes the account (see [TangentApi.deleteAccount]); signed out once
  /// it is gone. A refusal throws and changes nothing.
  Future<void> deleteAccount(String confirmEmail) async {
    await api.deleteAccount(confirmEmail);
    signedOut();
  }

  /// A call answered `unauthorized`: the session ended elsewhere.
  void signedOut() {
    if (_status == SessionStatus.signedOut) return;
    _me = null;
    _billing = null;
    _pool = null;
    _keyStatus = null;
    _status = SessionStatus.signedOut;
    notifyListeners();
  }

  void _changed() {
    api.payer = payer;
    notifyListeners();
  }

  Future<void> _readChoice() async {
    try {
      final stored = await choiceStore?.read();
      for (final payer in Payer.values) {
        if (payer.header == stored) _chosen = payer;
      }
    } on Object {
      // Without the stored pick, the default applies.
    }
  }

  // Failures keep the last known value: the rule then goes by what it knows.

  Future<void> _readBilling() async {
    try {
      _billing = await api.billing();
    } on Object {
      // Kept as it was.
    }
  }

  Future<void> _readPool() async {
    try {
      _pool = await api.poolStatus();
    } on Object {
      // Kept as it was.
    }
  }

  Future<void> _readKey() async {
    try {
      _keyStatus = await api.keyStatus();
    } on Object {
      // Kept as it was.
    }
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
