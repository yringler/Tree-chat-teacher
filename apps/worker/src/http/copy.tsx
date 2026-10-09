import type { GroundingPolicy } from '@tangent/core';
import { MAX_TOP_UP_CENTS, MIN_TOP_UP_CENTS } from '@tangent/shared';
import { creditSold, ownKeyProviders } from '../availability.js';
import { groundingDailyCap, groundingPolicy } from '../billing/grounding.js';
import { membershipRequired } from '../billing/membership.js';
import { appConfig } from '../config.js';
import type { AppEnv } from '../env.js';
import { learnOffer } from '../simple-mode.js';

/**
 * What this deployment sells and offers, as the landing and pricing pages
 * state it, and the copy they share. A self-hoster's config changes these
 * claims (the membership, credit, web search, share links, the own-key
 * providers, every price and cap); the pages word nothing else from it.
 */
export interface Offer {
  /** The yearly membership, while it is required (`membershipRequired`): what own keys need, in Learn and power mode alike. */
  membership: { priceCents: number } | null;
  /** Prepaid credit, while it is sold (`creditSold`): on OpenRouter, to anyone, member or not. */
  credit: {
    markupBps: number;
    openRouterFeeBps: number;
    minTopUpCents: number;
    maxTopUpCents: number;
  } | null;
  /** The `GROUNDING` ceiling, or `off` when Learn's provider can't search (`LearnOffer.search`). */
  grounding: GroundingPolicy;
  /** A search costs about 1¢ (`LearnOffer.searchAboutOneCent`). */
  searchAboutOneCent: boolean;
  /** Automatic web searches a user may run per UTC day on credit (`GROUNDING_AUTO_DAILY_CAP`); 0 = no cap. */
  searchDailyCap: number;
  /** Learn's two tiers' labels; null when Learn has one model. */
  tiers: { normal: string; max: string } | null;
  /** Who power mode takes the user's own keys for, and which can search (`ownKeyProviders`). */
  providers: { id: string; label: string; search: boolean }[];
  /** Share links are offered to everyone (`LegalInfo.sharing`). */
  sharing: boolean;
}

export function offerOf(env: AppEnv, sharing: boolean): Offer {
  const { billing } = appConfig(env);
  const learn = learnOffer(env);
  const normal = learn?.tiers.find((t) => t.tier === 'normal');
  const max = learn?.tiers.find((t) => t.tier === 'max');
  return {
    membership: membershipRequired(env) ? { priceCents: billing.membershipPriceCents } : null,
    credit: creditSold(env)
      ? {
          markupBps: billing.markupBps,
          openRouterFeeBps: billing.openRouterFeeBps,
          minTopUpCents: MIN_TOP_UP_CENTS,
          maxTopUpCents: MAX_TOP_UP_CENTS,
        }
      : null,
    grounding: learn?.search ? groundingPolicy(env) : 'off',
    searchAboutOneCent: learn?.searchAboutOneCent ?? false,
    searchDailyCap: groundingDailyCap(env),
    tiers: normal && max ? { normal: normal.label, max: max.label } : null,
    providers: ownKeyProviders(env),
    sharing,
  };
}

/** `A`, `A or B`, `A, B or C` (or `and`). */
export function joinList(items: readonly string[], word: 'and' | 'or'): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;
}

/**
 * How the pool comes about, as numbered steps for the landing and pricing
 * pages. Tangent is the subject of every step that moves money: a customer
 * pays for Tangent, never for someone else's learning (docs/DECISIONS.md).
 */
export function PoolSteps(props: { memberships: boolean }) {
  return (
    <ol class="steps">
      <li>
        Tangent earns money from{' '}
        {props.memberships ? 'memberships and credit' : 'the credit people buy'}, like any software
        business.
      </li>
      <li>It sets aside free credit as the open pool.</li>
      <li>
        Anyone signed in can learn free from the pool, within daily limits, while it has credit.
      </li>
    </ol>
  );
}
