import { expect, test } from '@playwright/test';
import { newEmail, signIn } from './helpers';

/*
 * Buying credit on the billing page, against the real Worker: an amount is
 * picked or typed, the page shows the credit, the service fee and the
 * subtotal before tax, and Add credit opens the fake payment provider's
 * checkout for that much credit at that price.
 */

/** What a fake checkout URL carries (apps/worker/src/billing/providers/fake.ts). */
function checkoutInput(url: string): { creditCents: number; amountCents: number } {
  const encoded = new URL(url).hash.slice(1).replace(/-/g, '+').replace(/_/g, '/');
  const json = new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
  return JSON.parse(json) as { creditCents: number; amountCents: number };
}

test('a top-up shows its service fee and subtotal before checkout', async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  await signIn(context, baseURL!, newEmail('top-up'));
  await page.goto('/billing');

  const add = page.getByRole('button', { name: 'Add credit' });
  const breakdown = page.locator('.billing-breakdown');
  const amounts = breakdown.locator('dd');
  await expect(add).toBeDisabled();
  await expect(amounts).toHaveText(['—', '—', '—']);

  const five = page.getByRole('button', { name: '$5', exact: true });
  await five.click();
  await expect(five).toHaveAttribute('aria-pressed', 'true');
  await expect(breakdown.locator('dt')).toHaveText([
    'Credit',
    'Service fee (20% + 50¢)',
    'Subtotal (before tax)',
  ]);
  await expect(amounts).toHaveText(['$5.00', '$1.50', '$6.50']);
  await expect(add).toBeEnabled();

  // Typing an amount replaces the preset.
  await page.getByLabel(/Other amount/).fill('12.34');
  await expect(five).toHaveAttribute('aria-pressed', 'false');
  await expect(amounts).toHaveText(['$12.34', '$2.97', '$15.31']);
  await page
    .locator('section[aria-labelledby="billing-topup-h"]')
    .screenshot({ path: testInfo.outputPath('top-up.png') });

  await page.route('https://fake-pay.invalid/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<p>Checkout</p>' }),
  );
  await add.click();
  await page.waitForURL(/^https:\/\/fake-pay\.invalid\/checkout#/);
  expect(checkoutInput(page.url())).toMatchObject({ creditCents: 1234, amountCents: 1531 });
});
