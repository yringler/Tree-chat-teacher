import '@angular/compiler'; // JIT: ApiError's module declares an @Injectable.
import type { MembershipInfo } from '@tangent/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../core/api-client';
import {
  creditFeeText,
  formatDay,
  includedCreditText,
  membershipBlocks,
  membershipPriceText,
  membershipStatusText,
  MembershipSubscribe,
  waiverErrorMessage,
  WaiverForm,
} from './membership';

function membership(overrides: Partial<MembershipInfo> = {}): MembershipInfo {
  return {
    required: true,
    status: 'inactive',
    subscriptionStatus: null,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    priceCents: 1000,
    includedCreditCents: 200,
    ...overrides,
  };
}

describe('membershipBlocks', () => {
  it('blocks only a required membership that is inactive', () => {
    expect(membershipBlocks(membership())).toBe(true);
    expect(membershipBlocks(membership({ status: 'active' }))).toBe(false);
    expect(membershipBlocks(membership({ status: 'waived' }))).toBe(false);
    expect(membershipBlocks(membership({ required: false }))).toBe(false);
    expect(membershipBlocks(null)).toBe(false);
    expect(membershipBlocks(undefined)).toBe(false);
  });
});

describe('membership copy', () => {
  it('prices the year before tax', () => {
    expect(membershipPriceText(membership())).toBe('$10 / year plus tax');
    expect(membershipPriceText(membership({ priceCents: 1250 }))).toBe('$12.50 / year plus tax');
  });

  it('mentions the included credit only when there is some', () => {
    expect(includedCreditText(membership())).toBe('Includes $2 of credit each year.');
    expect(includedCreditText(membership({ includedCreditCents: 0 }))).toBeNull();
  });

  it('says where the user stands', () => {
    const end = '2027-10-02T12:00:00.000Z';
    expect(formatDay(end)).toBe('Oct 2, 2027');
    expect(formatDay('not a date')).toBeNull();
    expect(membershipStatusText(membership({ status: 'active', periodEnd: end }))).toBe(
      'Active until Oct 2, 2027, then renews each year.',
    );
    expect(
      membershipStatusText(
        membership({ status: 'active', periodEnd: end, cancelAtPeriodEnd: true }),
      ),
    ).toBe("Active until Oct 2, 2027. It won't renew.");
    expect(
      membershipStatusText(membership({ status: 'active', subscriptionStatus: 'past_due' })),
    ).toMatch(/last payment failed/);
    expect(membershipStatusText(membership({ status: 'waived' }))).toMatch(/^Waived/);
    expect(membershipStatusText(membership())).toMatch(/^Not active/);
    expect(membershipStatusText(membership())).toMatch(/power mode and prepaid credit/);
    expect(membershipStatusText(membership())).toMatch(/own key stays free/);
  });

  it('spells out the price of a call on credit', () => {
    expect(creditFeeText(1000, 550)).toBe(
      "the model's OpenRouter price + 5.5% OpenRouter fee + 10%",
    );
    expect(creditFeeText(0, 0)).toBe("the model's OpenRouter price");
  });
});

describe('WaiverForm', () => {
  function setup() {
    const redeem = vi.fn(async (_code: string) => membership({ status: 'waived' }));
    const onRedeemed = vi.fn((_m: MembershipInfo) => undefined);
    return { form: new WaiverForm(redeem, onRedeemed), redeem, onRedeemed };
  }

  it('redeems the trimmed code and hands on the new membership', async () => {
    const { form, redeem, onRedeemed } = setup();
    await expect(form.submit('  FRIENDS ')).resolves.toBe(true);
    expect(redeem).toHaveBeenCalledWith('FRIENDS');
    expect(onRedeemed).toHaveBeenCalledWith(expect.objectContaining({ status: 'waived' }));
    expect(form.busy()).toBe(false);
    expect(form.error()).toBeNull();
  });

  it('asks for a code instead of sending an empty one', async () => {
    const { form, redeem } = setup();
    await expect(form.submit('   ')).resolves.toBe(false);
    expect(redeem).not.toHaveBeenCalled();
    expect(form.error()).toBe('Enter your code.');
    form.clearError();
    expect(form.error()).toBeNull();
  });

  it('explains a wrong code, too many tries and a server without codes', async () => {
    const { form, redeem, onRedeemed } = setup();
    redeem.mockRejectedValueOnce(new ApiError(403, 'forbidden', 'Invalid code'));
    await form.submit('x');
    expect(form.error()).toMatch(/didn't work/);
    redeem.mockRejectedValueOnce(new ApiError(429, 'rate_limited', 'Slow down'));
    await form.submit('x');
    expect(form.error()).toMatch(/Too many tries/);
    redeem.mockRejectedValueOnce(new ApiError(400, 'bad_request', 'No code configured'));
    await form.submit('x');
    expect(form.error()).toMatch(/doesn't take membership codes/);
    expect(onRedeemed).not.toHaveBeenCalled();
    expect(waiverErrorMessage(new ApiError(0, 'network', 'Offline'))).toBe('Offline');
  });
});

describe('MembershipSubscribe', () => {
  it('opens the membership checkout and stays pending while the page leaves', async () => {
    const billing = { upgrade: vi.fn(async () => undefined) };
    const sub = new MembershipSubscribe(billing);
    await sub.subscribe();
    expect(billing.upgrade).toHaveBeenCalledOnce();
    expect(sub.pending()).toBe(true);
    await sub.subscribe();
    expect(billing.upgrade).toHaveBeenCalledTimes(1);
    sub.reset();
    expect(sub.pending()).toBe(false);
  });

  it('shows an error and lets the user try again', async () => {
    const billing = { upgrade: vi.fn(async () => Promise.reject(new Error('Payments are down'))) };
    const sub = new MembershipSubscribe(billing);
    await sub.subscribe();
    expect(sub.error()).toBe('Payments are down');
    expect(sub.pending()).toBe(false);
  });
});
