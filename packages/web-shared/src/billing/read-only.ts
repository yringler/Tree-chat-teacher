import { signal } from '@angular/core';
import type {
  BranchFunding,
  CopyToLearnResponse,
  MembershipInfo,
  ProviderInfo,
} from '@tangent/shared';
import { errorMessage } from '../core/api-client';
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
 * How a copy in Learn can get replies for a user without a membership: on
 * the open pool while it is on, else on Tangent credit where it carries on
 * (`creditCarriesOn`: the credit is per user, shared by both apps). Learn's
 * own key is locked just the same, so with neither a copy could only be read.
 */
export type LearnCopyWay = 'pool' | 'credit';

/** How a copy in Learn carries on (`LearnCopyWay`); null when it can't, and no copy is offered. */
export function learnCopyWay(poolOn: boolean, creditCarriesOn: boolean): LearnCopyWay | null {
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
 * on with Tangent credit instead, which needs no membership. `learn`: a copy
 * in Learn can get replies there (`learnCopyWay`), so the notice offers one;
 * null leaves the copy out.
 */
export function readOnlyText(
  m: Pick<MembershipInfo, 'subscriptionStatus'>,
  credit = false,
  learn: LearnCopyWay | null = null,
): ReadOnlyText {
  const ended = m.subscriptionStatus !== null;
  const lead = ended
    ? 'Your membership has ended.'
    : 'Replies on your own API keys need a membership.';
  const act = ended ? 'Renew your membership' : 'Become a member';
  const where = learn === 'pool' ? 'on the open pool' : 'on Tangent credit';
  let body = learn
    ? `${act} to continue this conversation, or create a copy to continue it in Learn ${where}.`
    : `${act} to continue this conversation.`;
  if (credit) body += ' You can also continue it on Tangent credit, which needs no membership.';
  return { lead, body, act, renew: ended ? 'Renew membership' : 'Become a member' };
}

/** A lesson's address in Learn (`/learn/t/<id>`). */
export function learnLessonHref(treeId: string): string {
  return `${APP_BASES.simple}t/${encodeURIComponent(treeId)}`;
}

/**
 * "Create a copy in Learn": the server copies the power tree into the user's
 * Learn account (`POST /api/trees/:id/copy-to-learn`), then the browser opens
 * the new lesson in Learn.
 */
export class LearnCopy {
  /** Stays true on success: the page is leaving for Learn (no second copy meanwhile). */
  readonly pending = signal(false);
  readonly error = signal<string | null>(null);

  constructor(
    private readonly api: { copyToLearn(treeId: string): Promise<CopyToLearnResponse> },
    private readonly leave: (href: string) => void,
  ) {}

  async copy(treeId: string): Promise<void> {
    if (this.pending()) return;
    this.pending.set(true);
    this.error.set(null);
    try {
      const lesson = await this.api.copyToLearn(treeId);
      this.leave(learnLessonHref(lesson.treeId));
    } catch (err) {
      this.error.set(`Couldn't copy it to Learn: ${errorMessage(err)}`);
      this.pending.set(false);
    }
  }

  /** Back from Learn through the back/forward cache: the button works again. */
  reset(): void {
    this.pending.set(false);
  }
}
