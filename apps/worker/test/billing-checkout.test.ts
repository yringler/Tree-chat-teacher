// Starting a purchase through the payment provider's port (billing/service.ts,
// billing/membership.ts), on the fake provider: its URLs encode what the
// domain asked for (billing/providers/fake.ts `decodeFakeUrl`).
import { DomainError, ValidationError } from '@tangent/core';
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { openBillingPortal, startMembershipCheckout } from '../src/billing/membership.js';
import { customerRefFor } from '../src/billing/payments/customers.js';
import { decodeFakeUrl, type FakeProviderOptions } from '../src/billing/providers/fake.js';
import { checkoutReturnUrl } from '../src/billing/return-urls.js';
import { startTopUpCheckout } from '../src/billing/service.js';
import type { AppEnv } from '../src/env.js';
import { insertUser, powerAccount, simpleAccount, uniq } from './mocks/billing-helpers.js';
import { membership } from './mocks/payment-events.js';
import { applyPaymentEvent } from '../src/billing/payments/apply.js';

const env = rawEnv as unknown as AppEnv;
const BASE = 'https://tangent.example.com';
const withFake = (o: FakeProviderOptions, e: AppEnv = env) =>
  ({ ...e, FAKE_PAYMENTS: JSON.stringify(o) }) as AppEnv;

async function newUser(account = simpleAccount()) {
  const user = await insertUser(env, {
    id: account.userId!,
    email: `${uniq('buyer')}@example.com`,
    name: 'Ada',
  });
  return { account, user };
}

describe('credit checkout', () => {
  it('rejects amounts outside $5..$500 and non-integers before calling the provider', async () => {
    const { account, user } = await newUser();
    for (const cents of [499, 50_001, 0, -500, 1000.5]) {
      await expect(startTopUpCheckout(env, account, user.id, cents, BASE)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });

  it('asks the provider for a top-up of the buyer’s ledger, returning to Learn’s billing page', async () => {
    const { account, user } = await newUser();
    const { url } = await startTopUpCheckout(env, account, user.id, 500, `${BASE}/`);
    expect(decodeFakeUrl(url)).toEqual({
      page: 'checkout',
      input: {
        buyer: { userId: user.id, email: user.email, name: 'Ada', customerRef: null },
        amountCents: 500,
        successUrl: `${BASE}/learn/billing?checkout=success`,
        cancelUrl: `${BASE}/learn/billing?checkout=cancel`,
      },
    });
  });

  it('works from power mode: buys for the same user and returns to /billing', async () => {
    const { user } = await newUser(powerAccount());
    const { url } = await startTopUpCheckout(env, powerAccount(user.id), user.id, 1000, BASE);
    expect(decodeFakeUrl(url).input).toMatchObject({
      buyer: { userId: user.id },
      successUrl: `${BASE}/billing?checkout=success`,
      cancelUrl: `${BASE}/billing?checkout=cancel`,
    });
  });

  it('remembers a customer the provider reports, and passes it on next time', async () => {
    const { account, user } = await newUser();
    const e = withFake({ customerRef: 'cust_42' });
    await startTopUpCheckout(e, account, user.id, 1000, BASE);
    expect(await customerRefFor(env.DB, 'fake', user.id)).toBe('cust_42');
    const { url } = await startTopUpCheckout(e, account, user.id, 1000, BASE);
    expect(decodeFakeUrl(url).input).toMatchObject({ buyer: { customerRef: 'cust_42' } });
  });

  it('refuses when no provider sells credit', async () => {
    const { account, user } = await newUser();
    for (const e of [
      { ...env, PAYMENT_PROVIDER: 'polar', POLAR_ACCESS_TOKEN: '' } as AppEnv,
      withFake({ topUps: false }),
    ]) {
      const err = await startTopUpCheckout(e, account, user.id, 1000, BASE).catch(
        (x: unknown) => x,
      );
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).message).toBe('Billing is not configured');
    }
  });

  it('returns to the billing page of the app the checkout started from', () => {
    expect(checkoutReturnUrl(`${BASE}/`, simpleAccount(), 'success')).toBe(
      `${BASE}/learn/billing?checkout=success`,
    );
    expect(checkoutReturnUrl(BASE, powerAccount(), 'cancel')).toBe(
      `${BASE}/billing?checkout=cancel`,
    );
  });
});

describe('membership checkout and the billing portal', () => {
  const feeOn = (o: FakeProviderOptions = {}) =>
    withFake(o, { ...env, ANNUAL_FEE_ENABLED: 'true' } as AppEnv);

  it('opens the membership checkout, returning to the caller’s billing page', async () => {
    const { account, user } = await newUser();
    const { url } = await startMembershipCheckout(feeOn(), account, BASE);
    expect(decodeFakeUrl(url)).toEqual({
      page: 'membership',
      input: {
        buyer: { userId: user.id, email: user.email, name: 'Ada', customerRef: null },
        successUrl: `${BASE}/learn/billing?checkout=success`,
        cancelUrl: `${BASE}/learn/billing?checkout=cancel`,
      },
    });
  });

  it('sends a paying member to the portal instead', async () => {
    const { account, user } = await newUser(powerAccount());
    await applyPaymentEvent(env, membership(user.id, 'active'), { provider: null });
    const { url } = await startMembershipCheckout(feeOn(), account, BASE);
    expect(decodeFakeUrl(url)).toMatchObject({
      page: 'portal',
      input: { returnUrl: `${BASE}/billing` },
    });
  });

  it('refuses the membership where the provider doesn’t sell it', async () => {
    const { account } = await newUser();
    await expect(
      startMembershipCheckout(feeOn({ membership: false }), account, BASE),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('opens the portal, or reports that there is no customer yet', async () => {
    const { account, user } = await newUser();
    const portal = await openBillingPortal(env, account, BASE);
    expect(decodeFakeUrl(portal!.url)).toMatchObject({
      page: 'portal',
      input: { buyer: { userId: user.id }, returnUrl: `${BASE}/learn/billing` },
    });
    expect(await openBillingPortal(withFake({ portalCustomer: false }), account, BASE)).toBeNull();
  });
});
