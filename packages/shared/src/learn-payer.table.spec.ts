import { describe, expect, it } from 'vitest';
import type { Payer } from './domain.js';
import { learnPayer } from './learn-payer.js';

/** The facts as the Learn client holds them: the billing summary is null until read. */
interface Facts {
  chosen: Payer | null;
  offered: boolean;
  billing: { avail: number; topUps: boolean } | null;
  poolOn: boolean;
  member: boolean;
  hasKey: boolean | null;
}

/** `learnPayer` called as LearnFunding calls it (web-shared's creditCanPay / creditBuyable). */
function payer(f: Facts): Payer {
  return learnPayer({
    chosen: f.chosen,
    creditOffered: f.offered,
    creditCanPay: f.billing === null ? null : f.offered && f.billing.avail > 0,
    creditBuyable: f.offered && (f.billing?.topUps ?? true),
    poolOn: f.poolOn,
    ownKeyReady: f.member && f.hasKey !== false,
  });
}

/**
 * The truth, written out as a priority list independent of `learnPayer`:
 * the learner's pick where it applies (credit known unable to pay gives way
 * to the pool while it is on), else credit with a balance, a ready own key,
 * the pool (credit while the balance is unknown and credit can be had), credit
 * that can be had, the own key.
 */
function truth(f: Facts): Payer {
  const balance = f.billing ? f.billing.avail : null;
  const topUps = f.billing ? f.billing.topUps : true;
  const creditHad = f.offered && (topUps || (balance ?? 0) > 0);
  const empty = f.offered && balance !== null && balance <= 0;
  if (f.chosen === 'own-key') return 'own-key';
  if (f.chosen === 'pool' && f.poolOn) return 'pool';
  if (f.chosen === 'credit' && creditHad) return empty && f.poolOn ? 'pool' : 'credit';
  if (f.offered && balance !== null && balance > 0) return 'credit';
  if (f.member && f.hasKey !== false) return 'own-key';
  if (f.poolOn) return creditHad && balance === null ? 'credit' : 'pool';
  return creditHad ? 'credit' : 'own-key';
}

const all: Facts[] = [];
for (const chosen of [null, 'own-key', 'credit', 'pool'] as const)
  for (const offered of [true, false])
    for (const billing of [
      null,
      { avail: 0, topUps: true },
      { avail: 0, topUps: false },
      { avail: 5, topUps: true },
      { avail: 5, topUps: false },
      { avail: -3, topUps: true },
    ])
      for (const poolOn of [true, false])
        for (const member of [true, false])
          for (const hasKey of [null, true, false])
            all.push({ chosen, offered, billing, poolOn, member, hasKey });

const base: Facts = {
  chosen: null,
  offered: true,
  billing: { avail: 0, topUps: true },
  poolOn: true,
  member: true,
  hasKey: false,
};

describe('learnPayer, every combination of what Learn knows', () => {
  it('matches the written-out rule everywhere', () => {
    const wrong = all.filter((f) => payer(f) !== truth(f));
    expect(wrong).toEqual([]);
  });

  it.each<[string, Partial<Facts>, Payer]>([
    ['credit picked, nothing left, the pool on: the pool', { chosen: 'credit' }, 'pool'],
    [
      'credit picked, nothing left, the pool off: credit to buy',
      { chosen: 'credit', poolOn: false },
      'credit',
    ],
    ['credit picked, the balance unread: credit', { chosen: 'credit', billing: null }, 'credit'],
    [
      'credit picked, top-ups off, nothing left: the pool',
      { chosen: 'credit', billing: { avail: 0, topUps: false } },
      'pool',
    ],
    [
      'a balance left beats a ready key',
      { hasKey: true, billing: { avail: 5, topUps: true } },
      'credit',
    ],
    ['a ready key beats the pool', { hasKey: true }, 'own-key'],
    ['no key, nothing left: the pool', {}, 'pool'],
    ['no key, the balance unread: credit, not the pool on a guess', { billing: null }, 'credit'],
    ['nothing on offer: the own key', { offered: false, poolOn: false }, 'own-key'],
    ['the own key picked stands for a non-member', { chosen: 'own-key', member: false }, 'own-key'],
    [
      'the pool picked while it is off: the default',
      { chosen: 'pool', poolOn: false, billing: { avail: 5, topUps: true } },
      'credit',
    ],
  ])('%s', (_name, over, expected) => {
    expect(payer({ ...base, ...over })).toBe(expected);
  });
});

describe('learnPayer as the gate asks it (a Learn send asking for credit)', () => {
  it('moves credit to the pool exactly when it cannot cover a call, whatever top-ups say', () => {
    for (const creditCanPay of [true, false])
      for (const creditBuyable of [true, false])
        expect(
          learnPayer({
            chosen: 'credit',
            creditOffered: true,
            creditCanPay,
            creditBuyable,
            poolOn: true,
            ownKeyReady: false,
          }),
        ).toBe(creditCanPay ? 'credit' : 'pool');
  });
});
