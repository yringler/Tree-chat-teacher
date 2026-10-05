import '@angular/compiler'; // JIT: compiles the components below without the Angular CLI.
import {
  Injector,
  reflectComponentType,
  runInInjectionContext,
  type StaticProvider,
} from '@angular/core';
import type { MembershipInfo } from '@tangent/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from '../core/api-client';
import { BillingPage } from './billing-page';
import { MembershipCodeForm } from './membership-code-form';
import { MembershipGate } from './membership-gate';

const WAIVED: MembershipInfo = {
  required: true,
  status: 'waived',
  subscriptionStatus: null,
  periodEnd: null,
  cancelAtPeriodEnd: false,
  priceCents: 1000,
  includedCreditCents: 200,
};

/** Template of a JIT-compiled component (the decorator's metadata). */
function templateOf(type: object): string {
  const annotations = (type as { __annotations__?: { template?: string }[] }).__annotations__;
  return annotations?.[0]?.template ?? '';
}

/** Builds a component class instance outside a view: enough for its outputs and logic. */
function create<T>(type: new () => T, providers: StaticProvider[]): T {
  return runInInjectionContext(Injector.create({ providers }), () => new type());
}

describe('MembershipGate', () => {
  // (Signal inputs and outputs are only visible to the AOT compiler; ngc checks the bindings.)
  it('is <app-membership-gate>', () => {
    expect(reflectComponentType(MembershipGate)?.selector).toBe('app-membership-gate');
  });

  it('offers Subscribe, the code form, the billing page and sign-out, with no close button', () => {
    const t = templateOf(MembershipGate);
    expect(t).toContain('role="dialog"');
    expect(t).toContain('aria-modal="true"');
    expect(t).toContain('Tangent is {{ price() }} a year');
    expect(t).toContain('(click)="sub.subscribe()"');
    expect(t).toContain('<app-membership-code-form (redeemed)="redeemed.emit($event)" />');
    expect(t).toContain('[href]="billingPath()"');
    expect(t).toContain('Sign out');
    expect(t).not.toContain('aria-label="Close"');
  });

  it('says what needs the membership (power mode by default) and labels the way out', () => {
    const t = templateOf(MembershipGate);
    expect(t).toContain('{{ needs() }}');
    expect(t).not.toContain('New replies need one');
    expect(t).toContain('@if (freeTier(); as label)');
    expect(t).toContain('(click)="freeTierChosen.emit()"');
  });
});

describe('MembershipCodeForm', () => {
  it('redeems through the API and emits the new membership as `redeemed`', async () => {
    const api = { redeemMembershipWaiver: vi.fn(async (_code: string) => WAIVED) };
    const form = create(MembershipCodeForm, [{ provide: ApiClient, useValue: api }]);
    const seen: MembershipInfo[] = [];
    form.redeemed.subscribe((m) => seen.push(m));
    const state = (form as unknown as { form: { submit(code: string): Promise<boolean> } }).form;
    await expect(state.submit(' FRIENDS ')).resolves.toBe(true);
    expect(api.redeemMembershipWaiver).toHaveBeenCalledWith('FRIENDS');
    expect(seen).toEqual([WAIVED]);
    expect(templateOf(MembershipCodeForm)).toContain('Have a code?');
  });

  it('a wrong code shows inline and emits nothing', async () => {
    const api = {
      redeemMembershipWaiver: vi.fn(async (_code: string): Promise<MembershipInfo> => {
        throw new ApiError(403, 'forbidden', 'Invalid code');
      }),
    };
    const form = create(MembershipCodeForm, [{ provide: ApiClient, useValue: api }]);
    const seen: MembershipInfo[] = [];
    form.redeemed.subscribe((m) => seen.push(m));
    const state = (
      form as unknown as {
        form: { submit(code: string): Promise<boolean>; error(): string | null };
      }
    ).form;
    await expect(state.submit('nope')).resolves.toBe(false);
    expect(state.error()).toMatch(/didn't work/);
    expect(seen).toEqual([]);
  });
});

describe('BillingPage', () => {
  it('is <app-billing-page> with a back link to the home path', () => {
    expect(reflectComponentType(BillingPage)?.selector).toBe('app-billing-page');
    expect(templateOf(BillingPage)).toContain('[routerLink]="homePath()"');
    expect(templateOf(BillingPage)).toContain('{{ homeLabel() }}');
  });

  it('shows each section only where it applies', () => {
    const t = templateOf(BillingPage);
    expect(t).toContain('@if (s.membership.required)');
    expect(t).toContain('@if (s.builtInCredit)');
    expect(t).toContain('Each call costs {{ feeText(s) }}.');
    expect(t).toContain('(click)="ctl.subscribe()"');
    expect(t).toContain('<app-membership-code-form (redeemed)="onRedeemed($event)" />');
  });
});
