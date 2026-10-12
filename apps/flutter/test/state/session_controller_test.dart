import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/api/models.dart';
import 'package:tangent/state/session_controller.dart';

import '../fakes.dart';

void main() {
  Future<Payer> payerFor({
    required int creditMicros,
    required bool poolEnabled,
    bool builtInCredit = true,
  }) async {
    final api = FakeTangentApi()
      ..meAnswers = [
        Me(
          userId: 'u1',
          email: 'ada@example.com',
          devMode: false,
          builtInCredit: builtInCredit,
        ),
      ]
      ..billingAnswer = BillingSummary(
        enabled: true,
        builtInCredit: builtInCredit,
        availableMicros: creditMicros,
      )
      ..poolStatusAnswer = PoolStatus(enabled: poolEnabled, modelLabel: null);
    final session = SessionController(api);
    await session.start();
    expect(api.payerSet, session.payer);
    return session.payer;
  }

  test('credit the user has comes before the pool', () async {
    expect(await payerFor(creditMicros: 5, poolEnabled: true), Payer.credit);
  });

  test('the pool comes before credit still to buy', () async {
    expect(await payerFor(creditMicros: 0, poolEnabled: true), Payer.pool);
  });

  test('credit to buy, without the pool', () async {
    expect(await payerFor(creditMicros: 0, poolEnabled: false), Payer.credit);
  });

  test('the own key when credit is not offered and the pool is off', () async {
    expect(
      await payerFor(creditMicros: 0, poolEnabled: false, builtInCredit: false),
      Payer.ownKey,
    );
  });
}
