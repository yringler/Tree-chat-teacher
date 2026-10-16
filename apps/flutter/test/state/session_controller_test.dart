import 'package:flutter_test/flutter_test.dart';
import 'package:tangent/api/models.dart';
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
      providers: [if (hasKey) LearnKey.openRouter.id],
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

  test('a sent code is remembered for its lifetime', () async {
    final store = MemoryStore();
    var now = DateTime.utc(2026, 10, 13, 9);
    SessionController at() =>
        SessionController(FakeTangentApi(), signInStore: store, now: () => now);

    await at().codeSent('ada@example.com');
    now = now.add(const Duration(minutes: 14));
    expect(await at().codeSentTo(), 'ada@example.com');
    now = now.add(const Duration(minutes: 1));
    expect(await at().codeSentTo(), isNull, reason: 'the code has expired');
    expect(store.value, isNull);
  });

  test('a sent code is forgotten once over', () async {
    final store = MemoryStore();
    final api = apiWith(creditMicros: 5, poolEnabled: false);
    final session = SessionController(api, signInStore: store);
    await session.codeSent('ada@example.com');
    await session.cancelSignIn();
    expect(await session.codeSentTo(), isNull);

    await session.codeSent('ada@example.com');
    await session.start();
    expect(session.status, SessionStatus.signedIn);
    expect(store.value, isNull);
  });

  test('an unreadable sent code reads as none', () async {
    final store = MemoryStore()..value = 'not json';
    expect(
      await SessionController(
        FakeTangentApi(),
        signInStore: store,
      ).codeSentTo(),
      isNull,
    );
  });

  test('the own key is the one picked where the server offers it', () async {
    final store = MemoryStore();
    final api = apiWith(creditMicros: 0, poolEnabled: true, hasKey: true);
    final session = SessionController(api, keyChoiceStore: store);
    await session.start();
    expect(session.ownKey, LearnKey.openRouter);
    expect(api.ownKeySet, LearnKey.openRouter);
    expect(session.payer, Payer.ownKey);

    // Not offered here: OpenRouter, whatever was picked.
    await session.chooseKey(LearnKey.anthropic);
    expect(store.value, 'anthropic');
    expect(session.ownKey, LearnKey.openRouter);

    api.keyStatusAnswer = const KeyStatus(
      enabled: true,
      providers: ['openrouter'],
      learnProviders: [LearnKey.openRouter, LearnKey.anthropic],
    );
    final next = SessionController(api, keyChoiceStore: store);
    await next.start();
    expect(next.ownKey, LearnKey.anthropic);
    expect(api.ownKeySet, LearnKey.anthropic);
    // Its own entry counts: OpenRouter's saved key is no Anthropic key.
    expect(next.hasOwnKey, isFalse);
    expect(next.payer, Payer.pool);

    await next.saveKey('sk-ant-1');
    expect(next.hasOwnKey, isTrue);
    expect(next.payer, Payer.ownKey);
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
