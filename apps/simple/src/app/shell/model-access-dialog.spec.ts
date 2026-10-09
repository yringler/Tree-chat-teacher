import '@angular/compiler'; // JIT: the component metadata and the DI below.
import { Injector, runInInjectionContext } from '@angular/core';
import { Router } from '@angular/router';
import type { BillingSummary, MeResponse, PoolStatusResponse } from '@tangent/shared';
import {
  ApiClient,
  ComposerController,
  DEMO_MODE,
  SAVE_FILE,
  ToastStore,
} from '@tangent/web-shared';
import { describe, expect, it, vi } from 'vitest';
import { AccountStore } from '../state/account-store';
import { LearnFunding } from '../state/learn-funding';
import { LessonStore } from '../state/lesson-store';
import { PaymentChoice } from '../state/payment-choice';
import { UiStore } from '../state/ui-store';
import { ModelAccessDialog } from './model-access-dialog';

const membership = {
  required: false,
  status: 'inactive',
  subscriptionStatus: null,
  periodEnd: null,
  cancelAtPeriodEnd: false,
  priceCents: 1000,
} as const;

const EMPTY: BillingSummary = {
  enabled: true,
  membership,
  builtInCredit: true,
  currency: 'usd',
  balanceMicros: 0,
  heldMicros: 0,
  availableMicros: 0,
  markupBps: 1000,
  openRouterFeeBps: 550,
  minTopUpCents: 500,
  maxTopUpCents: 50_000,
};

const POOL: PoolStatusResponse = {
  enabled: true,
  availableMicros: 2_000_000,
  sessionsRemaining: 10,
  model: { id: 'lite', label: 'Lite' },
};

function open() {
  const api = {
    billing: vi.fn(async () => EMPTY),
    poolStatus: vi.fn(async () => POOL),
    poolMe: vi.fn(async () => null),
  };
  const injector = Injector.create({
    providers: [
      { provide: LessonStore },
      { provide: AccountStore },
      { provide: PaymentChoice },
      { provide: LearnFunding },
      { provide: UiStore },
      { provide: ComposerController },
      { provide: ToastStore },
      { provide: ApiClient, useValue: api },
      { provide: Router, useValue: { navigate: vi.fn(async () => true) } },
      { provide: SAVE_FILE, useValue: vi.fn() },
      { provide: DEMO_MODE, useValue: false },
    ],
  });
  injector
    .get(AccountStore)
    .me.set({ userId: 'u1', builtInCredit: true, membership } as MeResponse);
  const dialog = runInInjectionContext(injector, () => new ModelAccessDialog());
  return { dialog, funding: injector.get(LearnFunding), api };
}

describe('How replies are paid for', () => {
  it('picking Tangent credit with nothing left keeps credit picked, while replies use the pool', async () => {
    const { dialog, funding } = open();
    await funding.refreshBalance();
    await funding.refreshPool();
    dialog['choose']('credit');
    await vi.waitFor(() => expect(funding.billing()).not.toBeNull());
    // The radio stays on credit (the credit panel, its Add credit link), not the pool's.
    expect(dialog['payment']()).toBe('credit');
    expect(funding.creditWaiting()).toBe(true);
    expect(funding.payer()).toBe('pool');
  });
});
