import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/api/models.dart';
import 'package:tangent/api/token_store.dart';
import 'package:tangent/state/session_controller.dart';

import '../fakes.dart';

void main() {
  FakeTangentApi apiWith({
    required int creditMicros,
    required bool poolEnabled,
    bool builtInCredit = true,
    bool hasKey = false,
    bool membershipMissing = false,
  }) => FakeTangentApi()
    ..meAnswers = [
      Me(
        userId: 'u1',
        email: 'ada@example.com',
        devMode: false,
        builtInCredit: builtInCredit,
        membershipMissing: membershipMissing,
      ),
    ]
    ..billingAnswer = BillingSummary(
      enabled: true,
      builtInCredit: builtInCredit,
      availableMicros: creditMicros,
    )
    ..poolStatusAnswer = PoolStatus(enabled: poolEnabled, modelLabel: null)
    ..keyStatusAnswer = KeyStatus(
      enabled: true,
      providers: [if (hasKey) openRouterProviderId],
    );

  Future<Payer> payerFor({
    required int creditMicros,
    required bool poolEnabled,
    bool builtInCredit = true,
    bool hasKey = false,
    bool membershipMissing = false,
  }) async {
    final api = apiWith(
      creditMicros: creditMicros,
      poolEnabled: poolEnabled,
      builtInCredit: builtInCredit,
      hasKey: hasKey,
      membershipMissing: membershipMissing,
    );
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

  test('a saved key comes before the pool and credit still to buy', () async {
    expect(
      await payerFor(creditMicros: 0, poolEnabled: true, hasKey: true),
      Payer.ownKey,
    );
  });

  test('credit the user has comes before a saved key', () async {
    expect(
      await payerFor(creditMicros: 5, poolEnabled: true, hasKey: true),
      Payer.credit,
    );
  });

  test('a saved key without the membership it needs is passed over', () async {
    expect(
      await payerFor(
        creditMicros: 0,
        poolEnabled: true,
        hasKey: true,
        membershipMissing: true,
      ),
      Payer.pool,
    );
  });

  test('a pick is kept, and wins where it can apply', () async {
    final store = MemoryStore();
    final api = apiWith(creditMicros: 5, poolEnabled: true, hasKey: true);
    final session = SessionController(api, choiceStore: store);
    await session.start();
    expect(session.payer, Payer.credit);

    await session.choose(Payer.pool);
    expect(api.payerSet, Payer.pool);
    expect(store.value, 'pool');

    final next = SessionController(api, choiceStore: store);
    await next.start();
    expect(next.payer, Payer.pool);
  });

  test(
    'saving a key moves replies onto it; forgetting moves them off',
    () async {
      final api = apiWith(creditMicros: 0, poolEnabled: true);
      final session = SessionController(api);
      await session.start();
      expect(session.payer, Payer.pool);

      await session.saveKey('sk-or-1');
      expect(api.savedKeys, ['sk-or-1']);
      expect(session.payer, Payer.ownKey);
      expect(api.payerSet, Payer.ownKey);

      await session.forgetKey();
      expect(session.payer, Payer.pool);
    },
  );

  test('a refused key changes nothing', () async {
    final api = apiWith(creditMicros: 0, poolEnabled: true)
      ..refuseKey = const ApiException(
        status: 400,
        code: 'bad_request',
        message: 'OpenRouter rejected this API key',
      );
    final session = SessionController(api);
    await session.start();
    await expectLater(session.saveKey('bad'), throwsA(isA<ApiException>()));
    expect(session.hasOwnKey, isFalse);
    expect(session.payer, Payer.pool);
  });

  test('a membership refusal locks the own key until the next start', () async {
    final api = apiWith(creditMicros: 0, poolEnabled: true, hasKey: true);
    final session = SessionController(api);
    await session.start();
    expect(session.payer, Payer.ownKey);

    session.refused(
      const ApiException(
        status: 402,
        code: 'membership_required',
        message: 'Membership needed',
      ),
    );
    expect(session.ownKeyAllowed, isFalse);
    expect(session.payer, Payer.pool);

    await session.start();
    expect(session.payer, Payer.ownKey);
  });

  test('picked own key without a key is blocked', () async {
    final api = apiWith(creditMicros: 0, poolEnabled: true);
    final session = SessionController(api);
    await session.start();
    await session.choose(Payer.ownKey);
    expect(session.payer, Payer.ownKey);
    expect(session.ownKeyBlocked, isTrue);
  });
}

/// A [TokenStore] in memory.
class MemoryStore implements TokenStore {
  String? value;

  @override
  Future<String?> read() async => value;

  @override
  Future<void> write(String token) async => value = token;

  @override
  Future<void> clear() async => value = null;
}
