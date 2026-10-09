/*
 * Who pays for a Learn reply. One pure
 * rule, used by the Learn client (the payer it asks for, PAYMENT_HEADER) and
 * by the Worker's gate (where a send asking for credit that can't pay goes),
 * so they agree. The server still decides: it reports the payer a reply
 * actually used on the stream's `start` event.
 */
import type { Payer } from './domain.js';

/** What the rule needs to know. */
export interface LearnPayerFacts {
  /**
   * The payer asked for: the learner's own pick in the client (null until
   * they pick one), the request's payer on the server.
   */
  chosen: Payer | null;
  /** Tangent credit is offered here (`MeResponse.builtInCredit`). */
  creditOffered: boolean;
  /**
   * Credit can pay for a reply now; null while the client hasn't read the
   * balance. The client reads a balance above zero (`creditCanPay` in
   * `@tangent/web-shared`); the server asks for one call's hold.
   */
  creditCanPay: boolean | null;
  /** More credit can be bought here (the payment provider sells top-ups). */
  creditBuyable: boolean;
  /** The open pool is on. */
  poolOn: boolean;
  /**
   * The learner's own OpenRouter key can reply: no membership is missing,
   * and a key is saved, or its state isn't known yet (so a key user who
   * never picked never lands on the pool unasked).
   */
  ownKeyReady: boolean;
}

/**
 * The payer of a Learn reply. The payer asked for first: the own key
 * always (without a membership the client then shows the locked-key notice
 * instead of letting a send fail with a 402), the pool while it is on, and
 * credit wherever it is offered and can pay or be bought, except that
 * credit known to be unable to pay gives way to the pool while it is on.
 * Otherwise the first of:
 * 1. credit that can pay;
 * 2. a ready own key;
 * 3. the open pool while it is on, but credit that can be bought while the
 *    balance isn't known yet, so credit the learner holds is never passed
 *    over for the pool on a guess (the server moves the send to the pool if
 *    the credit can't pay after all);
 * 4. credit that can be bought;
 * 5. the own key (a non-member then meets the locked-key notice).
 */
export function learnPayer(f: LearnPayerFacts): Payer {
  const canPay = f.creditOffered && f.creditCanPay === true;
  const buyable = f.creditOffered && f.creditBuyable;
  if (f.chosen === 'own-key') return 'own-key';
  if (f.chosen === 'pool' && f.poolOn) return 'pool';
  if (f.chosen === 'credit' && (canPay || buyable))
    return f.creditCanPay === false && f.poolOn ? 'pool' : 'credit';
  if (canPay) return 'credit';
  if (f.ownKeyReady) return 'own-key';
  if (f.poolOn) return buyable && f.creditCanPay === null ? 'credit' : 'pool';
  return buyable ? 'credit' : 'own-key';
}
