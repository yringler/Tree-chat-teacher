import type { DefaultRouteFacts } from '@tangent/shared';
import { creditSold } from '../availability.js';
import type { AccountContext, AppEnv } from '../env.js';
import { getBalance } from './ledger.js';
import { membershipFor, membershipNeededFor } from './membership.js';
import { USAGE_HOLD_MICROS } from './service.js';

/**
 * What the default route of a new power tree needs to know beyond the
 * provider lists (`pickDefaultRoute` in `@tangent/shared`, docs/DECISIONS.md
 * "Default route of a new tree"), asked by `ChatService` only for a new tree
 * that names no route, where credit is offered (`account.builtIn`):
 * - `creditCanPay`: the available balance covers one call's hold, exactly
 *   what `assertCanSpend` asks of a send, so a tree started on credit gets
 *   its first reply rather than a 402;
 * - `creditBuyable`: more credit can be bought (`creditSold`: credit is
 *   offered and the payment provider sells top-ups, what the top-up checkout
 *   asks), so credit is a way forward even at a zero balance. Where credit
 *   only comes from operator grants, an empty balance stays empty, and a
 *   locked own key (which leads to the membership) is the better start;
 * - `ownKeyLocked`: own keys need the membership the user lacks (what
 *   `/api/me`'s `membershipNeededFor` and the membership tell the apps).
 * Two queries (the balance, the membership), and none where credit isn't
 * offered (credit can neither pay nor be bought; nothing else depends on the lock).
 */
export async function defaultRouteFacts(
  env: AppEnv,
  account: AccountContext,
): Promise<DefaultRouteFacts> {
  if (account.mode === 'simple' || !account.builtIn)
    return { creditCanPay: false, creditBuyable: false, ownKeyLocked: false };
  const [{ balanceMicros, heldMicros }, membership] = await Promise.all([
    getBalance(env.DB, account.billingAccountId),
    membershipFor(env, account),
  ]);
  return {
    creditCanPay: balanceMicros - heldMicros >= USAGE_HOLD_MICROS,
    creditBuyable: creditSold(env),
    ownKeyLocked:
      membership.status === 'inactive' &&
      membershipNeededFor(account, membership).includes('own-key'),
  };
}
