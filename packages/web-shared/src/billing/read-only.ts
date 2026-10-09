import type { BranchFunding, MembershipInfo, ProviderInfo } from '@tangent/shared';
import { APP_BASES } from '../core/demo';
import { membershipBlocks } from './membership';

/*
 * Read-only power without a membership, as the power app and Canvas show it. The rule is
 * the server's: `MeResponse.membershipNeededFor` names the fundings that need
 * the membership (the user's own keys), and the membership says whether the
 * user has one. A branch on such a funding is read-only while they don't; a
 * branch on Tangent credit keeps going (anyone may buy credit). The server's 402
 * `membership_required` stays the gate. Framework-light (signals only) so the
 * specs run without a DOM.
 */

/**
 * The fundings the user can't generate on right now: those the server says
 * need the membership, while the user has none (`membershipBlocks`). Empty
 * wherever no membership is required (the fee off, no billing, the demos).
 */
export function lockedFundings(
  neededFor: readonly BranchFunding[] | null | undefined,
  membership: MembershipInfo | null | undefined,
): ReadonlySet<BranchFunding> {
  return membershipBlocks(membership) ? new Set(neededFor ?? []) : new Set();
}

/** A route (a branch, a reviewer, a provider entry) on a locked funding; none named is the user's own key. */
export function routeLocked(
  locked: ReadonlySet<BranchFunding>,
  route: { funding?: BranchFunding },
): boolean {
  return locked.has(route.funding ?? 'own-key');
}

/**
 * A provider entry a power user can generate on now: it has a key, its
 * funding isn't locked, and for Tangent credit, `creditUsable` (sold here:
 * anyone may buy more where top-ups are on, see `creditCarriesOn`).
 */
export function routeOpen(
  p: ProviderInfo,
  locked: ReadonlySet<BranchFunding>,
  creditUsable: boolean,
): boolean {
  if (!p.available || routeLocked(locked, p)) return false;
  return p.funding !== 'credit' || creditUsable;
}

/**
 * How Learn can reply to the same conversation for a user without a
 * membership: on the open pool while it is on, else on Tangent credit where
 * it carries on (`creditCarriesOn`: the credit is per user, shared by every
 * app). Learn's own key is locked just the same, so with neither Learn could
 * only show it.
 */
export type LearnWay = 'pool' | 'credit';

/** How Learn carries the conversation on (`LearnWay`); null when it can't, and Learn isn't offered. */
export function learnWay(poolOn: boolean, creditCarriesOn: boolean): LearnWay | null {
  if (poolOn) return 'pool';
  return creditCarriesOn ? 'credit' : null;
}

/** The read-only notice's words. */
export interface ReadOnlyText {
  /** The first sentence, in bold. */
  lead: string;
  /** What the user can do. */
  body: string;
  /** The way back, as the start of a sentence: "Renew your membership" or "Become a member". */
  act: string;
  /** The billing page link's label. */
  renew: string;
}

/**
 * What the notice that replaces the composer of a read-only branch says. A
 * user who had a membership (a subscription on record) is asked to renew it;
 * one who never had one, to become a member. `credit`: the branch can carry
 * on with Tangent credit instead, which needs no membership. `learn`: Learn
 * can reply to the same conversation (`learnWay`), so the notice offers to
 * open it there; null leaves Learn out.
 */
export function readOnlyText(
  m: Pick<MembershipInfo, 'subscriptionStatus'>,
  credit = false,
  learn: LearnWay | null = null,
): ReadOnlyText {
  const ended = m.subscriptionStatus !== null;
  const lead = ended
    ? 'Your membership has ended.'
    : 'Replies on your own API keys need a membership.';
  const act = ended ? 'Renew your membership' : 'Become a member';
  const where = learn === 'pool' ? 'on the open pool' : 'on Tangent credit';
  let body = learn
    ? `${act} to continue this conversation, or continue it in Learn ${where}.`
    : `${act} to continue this conversation.`;
  if (credit) body += ' You can also continue it on Tangent credit, which needs no membership.';
  return { lead, body, act, renew: ended ? 'Renew membership' : 'Become a member' };
}

/** The same conversation's address in Learn (`/learn/t/<treeId>/b/<branchId>`). */
export function learnLessonHref(treeId: string, branchId: string | null = null): string {
  const tree = `${APP_BASES.simple}t/${encodeURIComponent(treeId)}`;
  return branchId === null ? tree : `${tree}/b/${encodeURIComponent(branchId)}`;
}
