import '../api/models.dart';

/// The payer of a Learn reply: `learnPayer` in
/// packages/shared/src/learn-payer.ts, which the server's gate applies too,
/// so the two must agree. The payer asked for first: the own key always,
/// the pool while it is on, and credit wherever it is offered and can pay or
/// be bought, except that credit known to be unable to pay gives way to the
/// pool while it is on. Otherwise the first of: credit that can pay; a ready
/// own key; the open pool while it is on (but credit that can be bought while
/// the balance isn't known yet); credit that can be bought; the own key.
///
/// [creditCanPay] is null while the balance isn't read. [ownKeyReady]: no
/// membership is missing, and a key is saved or its state isn't known yet.
Payer learnPayer({
  required Payer? chosen,
  required bool creditOffered,
  required bool? creditCanPay,
  required bool creditBuyable,
  required bool poolOn,
  required bool ownKeyReady,
}) {
  final canPay = creditOffered && creditCanPay == true;
  final buyable = creditOffered && creditBuyable;
  if (chosen == Payer.ownKey) return Payer.ownKey;
  if (chosen == Payer.pool && poolOn) return Payer.pool;
  if (chosen == Payer.credit && (canPay || buyable)) {
    return creditCanPay == false && poolOn ? Payer.pool : Payer.credit;
  }
  if (canPay) return Payer.credit;
  if (ownKeyReady) return Payer.ownKey;
  if (poolOn) {
    return buyable && creditCanPay == null ? Payer.credit : Payer.pool;
  }
  return buyable ? Payer.credit : Payer.ownKey;
}
