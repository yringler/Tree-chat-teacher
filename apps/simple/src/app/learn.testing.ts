import { TestBed } from '@angular/core/testing';
import type {
  BillingSummary,
  MembershipInfo,
  Payer,
  PoolMeResponse,
  PoolStatusResponse,
} from '@tangent/shared';
import { me, membership } from '@tangent/web-shared/testing';
import { AccountStore } from './state/account-store';
import { LearnFunding } from './state/learn-funding';
import { PaymentChoice } from './state/payment-choice';

/** The open pool, on, with ten sessions' worth of credit on Lite. */
export const POOL_ON: PoolStatusResponse = {
  enabled: true,
  availableMicros: 2_000_000,
  sessionsRemaining: 10,
  model: { id: 'lite', label: 'Lite' },
};

/** A membership the learner needs and hasn't (the fee is on). */
export const NOT_A_MEMBER = membership({ status: 'inactive', subscriptionStatus: null });

/**
 * What Learn knows of the signed-in learner, as `/api/me`, the billing
 * summary, the pool and the key status would tell it. Unless `facts` says
 * otherwise: no membership needed, no credit offered, the pool off, and
 * the own OpenRouter key saved. Call it from `render`'s `setup`, or after
 * the render (then wait for the view).
 */
export function learner(
  facts: {
    membership?: MembershipInfo;
    /** The billing summary; offered credit unless it says `builtInCredit: false`. */
    billing?: BillingSummary;
    pool?: PoolStatusResponse;
    poolMe?: PoolMeResponse;
    /** The own key is saved (true), isn't (false), or keys can't be stored here (null). */
    ownKey?: boolean | null;
    chosen?: Payer;
  } = {},
): LearnFunding {
  const m = facts.membership ?? membership({ required: false, status: 'inactive' });
  TestBed.inject(AccountStore).me.set(
    me({ mode: 'simple', membership: m, builtInCredit: facts.billing?.builtInCredit ?? false }),
  );
  const funding = TestBed.inject(LearnFunding);
  if (facts.billing) funding.billing.set({ ...facts.billing, membership: m });
  if (facts.pool) funding.poolStatus.set(facts.pool);
  if (facts.poolMe) funding.poolMe.set(facts.poolMe);
  const ownKey = facts.ownKey === undefined ? true : facts.ownKey;
  funding.keyStatus.set({
    enabled: ownKey !== null,
    hasKey: ownKey === true,
    providers: ownKey ? ['openrouter'] : [],
  });
  if (facts.chosen) TestBed.inject(PaymentChoice).chosen.set(facts.chosen);
  return funding;
}
