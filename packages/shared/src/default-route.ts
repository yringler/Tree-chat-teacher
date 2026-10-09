/*
 * The route (provider + funding) a new power tree starts on when nobody picked
 * one. One pure rule, used
 * by the Worker's ChatService (a new tree that names no provider) and by the
 * power and Canvas clients (the route their new-conversation pickers start
 * on), so they agree.
 */
import type { ProviderInfo } from './provider.js';
import { OPENROUTER_PROVIDER_ID } from './route.js';

/** What the rule reads of a provider entry (`/api/providers`, or a registry's list). */
export type DefaultRouteCandidate = Pick<ProviderInfo, 'id' | 'available' | 'funding' | 'scripted'>;

/** What the rule needs to know beyond the provider list. */
export interface DefaultRouteFacts {
  /**
   * Tangent credit can pay for a reply now: it is offered and the balance is
   * above zero. The clients read the balance (`creditCanPay` in
   * `@tangent/web-shared`); the Worker asks for what its gate asks, one
   * call's hold. False whenever the balance isn't known.
   */
  creditCanPay: boolean;
  /**
   * More Tangent credit can be bought here: it is offered and the payment
   * provider sells top-ups. False where credit only comes from operator
   * grants, so an empty balance stays empty.
   */
  creditBuyable: boolean;
  /**
   * The user's own keys need a membership they lack: `membershipNeededFor`
   * has `own-key` and the membership is inactive (read-only power).
   */
  ownKeyLocked: boolean;
}

/**
 * The default route of a new tree: the first of
 * 1. while own keys need a membership the user lacks, Tangent credit that can pay
 *    or can be bought (`creditBuyable`, whatever the balance: anyone can buy it,
 *    and a locked own key can't reply at all). Credit that can do neither is a
 *    dead end; the locked own key at least leads to the membership;
 * 2. an own-key provider the user can use (a saved key, or a server key in the
 *    dev bypass), in the configured order;
 * 3. Tangent credit, when it can pay;
 * 4. an own-key test provider (`scripted`) the operator configured, which needs no
 *    key (never offered by default: test and offline setups only);
 * 5. `openrouter` on the user's own key, when configured: one OpenRouter key
 *    unlocks every model and is the key Learn uses, so the first send asks for it;
 * 6. the first configured own-key provider (a self-hosted list without OpenRouter),
 *    else whatever is configured first.
 * Credit is otherwise never picked when it can't pay, nor is a test provider while a real one is usable;
 * the rest ask for a key on the first send (401 `key_required`). Null only for an
 * empty list (or credit alone, unable to pay). Entries without a funding are own-key.
 */
export function pickDefaultRoute<P extends DefaultRouteCandidate>(
  entries: readonly P[],
  facts: DefaultRouteFacts,
): P | null {
  const own = entries.filter((p) => p.funding !== 'credit');
  const real = (p: P) => p.scripted !== true;
  const offered = entries.find((p) => p.funding === 'credit' && p.available && real(p));
  if (facts.ownKeyLocked && offered && (facts.creditCanPay || facts.creditBuyable)) return offered;
  const credit = facts.creditCanPay ? offered : undefined;
  return (
    own.find((p) => p.available && real(p)) ??
    credit ??
    own.find((p) => p.available) ??
    own.find((p) => p.id === OPENROUTER_PROVIDER_ID && real(p)) ??
    own.find(real) ??
    own[0] ??
    null
  );
}
