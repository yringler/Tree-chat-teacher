import { describe, expect, it } from 'vitest';
import { learnPayer, type LearnPayerFacts } from './learn-payer.js';

/** A new learner on a server that sells credit, the pool off, nothing known yet. */
function facts(over: Partial<LearnPayerFacts> = {}): LearnPayerFacts {
  return {
    chosen: null,
    creditOffered: true,
    creditCanPay: null,
    creditBuyable: true,
    poolOn: false,
    ownKeyReady: true,
    ...over,
  };
}

describe('learnPayer', () => {
  it('runs on the own key until the server says it sells credit', () => {
    expect(learnPayer(facts({ creditOffered: false, creditBuyable: false }))).toBe('own-key');
    // A key known to be missing: credit, which anyone can buy.
    expect(learnPayer(facts({ ownKeyReady: false }))).toBe('credit');
  });

  it('defaults to what can reply now: credit that can pay, a ready key, the pool, credit to buy, the own key', () => {
    const empty = { creditCanPay: false, poolOn: true };
    expect(learnPayer(facts(empty))).toBe('own-key');
    expect(learnPayer(facts({ ...empty, creditCanPay: true }))).toBe('credit');
    expect(learnPayer(facts({ ...empty, ownKeyReady: false }))).toBe('pool');
    expect(learnPayer(facts({ ...empty, ownKeyReady: false, poolOn: false }))).toBe('credit');
    expect(
      learnPayer(facts({ ...empty, ownKeyReady: false, poolOn: false, creditBuyable: false })),
    ).toBe('own-key');
  });

  it('before the balance is read: a ready key stays; between the pool and credit, credit', () => {
    expect(learnPayer(facts({ poolOn: true }))).toBe('own-key');
    expect(learnPayer(facts({ poolOn: true, ownKeyReady: false }))).toBe('credit');
    expect(learnPayer(facts({ poolOn: true, ownKeyReady: false, creditCanPay: false }))).toBe(
      'pool',
    );
  });

  it('an explicit pick wins where it can apply', () => {
    expect(learnPayer(facts({ chosen: 'own-key', creditCanPay: true, poolOn: true }))).toBe(
      'own-key',
    );
    expect(learnPayer(facts({ chosen: 'pool', creditCanPay: true, poolOn: true }))).toBe('pool');
    // The pool switched off: the default.
    expect(learnPayer(facts({ chosen: 'pool', creditCanPay: true }))).toBe('credit');
    // Credit that can be bought, though nothing is left (the pool off).
    expect(learnPayer(facts({ chosen: 'credit', creditCanPay: false }))).toBe('credit');
    // Credit no longer sold: the default.
    expect(
      learnPayer(facts({ chosen: 'credit', creditOffered: false, creditBuyable: false })),
    ).toBe('own-key');
  });

  it("credit picked but unable to pay gives way to the pool while it is on, as the server's gate moves it", () => {
    // The learner's pick, with the balance read and empty.
    expect(learnPayer(facts({ chosen: 'credit', creditCanPay: false, poolOn: true }))).toBe('pool');
    // Not before the balance is known.
    expect(learnPayer(facts({ chosen: 'credit', poolOn: true }))).toBe('credit');
    // The gate's question: a send asking for credit that can't cover one call.
    const gate = { chosen: 'credit', ownKeyReady: false, poolOn: true } as const;
    expect(learnPayer(facts({ ...gate, creditCanPay: false }))).toBe('pool');
    expect(learnPayer(facts({ ...gate, creditCanPay: false, creditBuyable: false }))).toBe('pool');
    expect(learnPayer(facts({ ...gate, creditCanPay: true }))).toBe('credit');
  });
});
