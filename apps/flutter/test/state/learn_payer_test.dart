import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/api/models.dart';
import 'package:tangent/state/learn_payer.dart';

/// The cases of packages/shared/src/learn-payer.spec.ts: a new learner on a
/// server that sells credit, the pool off, nothing known yet.
Payer payer({
  Payer? chosen,
  bool creditOffered = true,
  bool? creditCanPay,
  bool creditBuyable = true,
  bool poolOn = false,
  bool ownKeyReady = true,
}) => learnPayer(
  chosen: chosen,
  creditOffered: creditOffered,
  creditCanPay: creditCanPay,
  creditBuyable: creditBuyable,
  poolOn: poolOn,
  ownKeyReady: ownKeyReady,
);

void main() {
  test('runs on the own key until the server says it sells credit', () {
    expect(payer(creditOffered: false, creditBuyable: false), Payer.ownKey);
    // A key known to be missing: credit, which anyone can buy.
    expect(payer(ownKeyReady: false), Payer.credit);
  });

  test('defaults to what can reply now: credit that can pay, a ready key, '
      'the pool, credit to buy, the own key', () {
    expect(payer(creditCanPay: false, poolOn: true), Payer.ownKey);
    expect(payer(creditCanPay: true, poolOn: true), Payer.credit);
    expect(
      payer(creditCanPay: false, poolOn: true, ownKeyReady: false),
      Payer.pool,
    );
    expect(payer(creditCanPay: false, ownKeyReady: false), Payer.credit);
    expect(
      payer(creditCanPay: false, ownKeyReady: false, creditBuyable: false),
      Payer.ownKey,
    );
  });

  test('before the balance is read: a ready key stays; between the pool and '
      'credit, credit', () {
    expect(payer(poolOn: true), Payer.ownKey);
    expect(payer(poolOn: true, ownKeyReady: false), Payer.credit);
    expect(
      payer(poolOn: true, ownKeyReady: false, creditCanPay: false),
      Payer.pool,
    );
  });

  test('an explicit pick wins where it can apply', () {
    expect(
      payer(chosen: Payer.ownKey, creditCanPay: true, poolOn: true),
      Payer.ownKey,
    );
    expect(
      payer(chosen: Payer.pool, creditCanPay: true, poolOn: true),
      Payer.pool,
    );
    // The pool switched off: the default.
    expect(payer(chosen: Payer.pool, creditCanPay: true), Payer.credit);
    // Credit that can be bought, though nothing is left (the pool off).
    expect(payer(chosen: Payer.credit, creditCanPay: false), Payer.credit);
    // Credit no longer sold: the default.
    expect(
      payer(chosen: Payer.credit, creditOffered: false, creditBuyable: false),
      Payer.ownKey,
    );
  });

  test(
    'credit picked but unable to pay gives way to the pool while it is on',
    () {
      expect(
        payer(chosen: Payer.credit, creditCanPay: false, poolOn: true),
        Payer.pool,
      );
      // Not before the balance is known.
      expect(payer(chosen: Payer.credit, poolOn: true), Payer.credit);
    },
  );
}
