import { expect, test, type Page } from '@playwright/test';
import { membership, newEmail, paymentWebhook, signIn } from './helpers';

/*
 * Learn on the learner's own key. Where the membership is required (as here),
 * the own key needs it, in Learn as in power mode; Tangent credit and the
 * open pool don't.
 *
 * Without a key, the server answers 401 `key_required`, which is not a lost
 * session (docs/DECISIONS.md "API errors in the clients"): Learn says which
 * key is missing and opens "How replies are paid for", and the learner stays
 * signed in, with the message kept.
 */

/** Makes the own key the learner's explicit choice in this browser, before Learn loads. */
async function chooseOwnKey(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('tangent.learn.payment', 'own-key'));
}

test('Learn without a key asks for the OpenRouter key, not for a new sign-in', async ({
  context,
  page,
  baseURL,
}) => {
  const userId = await signIn(context, baseURL!, newEmail('learn-key'));
  // A member: the own key is theirs to use.
  await paymentWebhook(context.request, [membership(userId, 'active', 1)]);
  await chooseOwnKey(page);
  const keyRequests: number[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/messages') && r.request().method() === 'POST')
      keyRequests.push(r.status());
  });

  await page.goto('/learn/');
  await expect(page.getByRole('heading', { name: 'New lesson' })).toBeVisible();
  await page.locator('#new-lesson-topic').fill('Why is the sky blue?');
  await page.getByRole('button', { name: 'Start lesson' }).click();

  await expect(page).toHaveURL(/\/learn\/t\/[^/]+/);
  await expect(page.locator('.toast-error')).toContainText(
    'Add your OpenRouter API key to continue this conversation.',
  );
  await expect(page.getByRole('dialog', { name: 'How replies are paid for' })).toBeVisible();
  await expect(page.locator('.toast')).not.toContainText(/session has expired/i);
  expect(keyRequests).toEqual([401]);

  // Still signed in, still in the lesson.
  await expect(page).not.toHaveURL(/\/login/);
  expect((await context.request.get('/api/me')).status()).toBe(200);
});

test('Learn on the own key without a membership shows the gate, with Tangent credit as the way out', async ({
  context,
  page,
  baseURL,
}) => {
  await signIn(context, baseURL!, newEmail('learn-gate'));
  await chooseOwnKey(page);

  await page.goto('/learn/');
  const gate = page.getByRole('dialog', { name: /Your own keys: \$\d+ a year/ });
  await expect(gate).toBeVisible();
  await expect(gate).toContainText('is what lets you use your own API keys');
  await expect(gate).toContainText(
    "Using your own OpenRouter key needs one; Tangent credit doesn't",
  );
  // The pool is off here; credit is sold, and anyone can buy it.
  await gate.getByRole('button', { name: 'Continue on Tangent credit' }).click();
  await expect(gate).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'New lesson' })).toBeVisible();
});
