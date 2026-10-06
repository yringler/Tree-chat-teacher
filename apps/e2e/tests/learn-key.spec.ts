import { expect, test } from '@playwright/test';
import { newEmail, signIn } from './helpers';

/*
 * Learn on the learner's own key without one: the server answers 401
 * `key_required`, which is not a lost session (docs/DECISIONS.md "API errors
 * in the clients"): Learn says which key is missing and opens "How replies are
 * paid for", and the learner stays signed in, with the message kept.
 */
test('Learn without a key asks for the OpenRouter key, not for a new sign-in', async ({
  context,
  page,
  baseURL,
}) => {
  await signIn(context, baseURL!, newEmail('learn-key'));
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
