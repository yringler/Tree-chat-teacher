import { expect, test, type Page } from '@playwright/test';
import { membership, newEmail, paymentWebhook, signIn, topUp } from './helpers';

/*
 * Learn on the learner's own key. Where the membership is required (as here),
 * the own key needs it, in Learn as in power mode; Tangent credit and the
 * open pool don't.
 *
 * Without a key, the server answers 401 `key_required`, which is not a lost
 * session: Learn says which key is missing and opens "How replies are paid
 * for", and the learner stays signed in, with the message kept.
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

test('a lapsed member whose browser still chose the own key: the notice replaces Start, one click carries on', async ({
  context,
  page,
  baseURL,
}) => {
  const userId = await signIn(context, baseURL!, newEmail('learn-lapsed'));
  await paymentWebhook(context.request, [membership(userId, 'active', 1)]);
  await paymentWebhook(context.request, [membership(userId, 'canceled', 2)]);
  await chooseOwnKey(page);

  await page.goto('/learn/');
  await expect(page.getByRole('heading', { name: 'New lesson' })).toBeVisible();
  // No blocking dialog: the page stays usable, and the topic box stays.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#new-lesson-topic')).toBeVisible();
  // Where the Start button would be: why, and the ways out.
  const notice = page.getByRole('region', { name: 'Your membership has ended.' });
  await expect(notice).toContainText('OpenRouter still bills you for the replies');
  await expect(notice.getByRole('button', { name: 'Renew membership' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Start lesson' })).toHaveCount(0);
  // Not "add your key" on top of it: the key isn't what's missing.
  await expect(page.getByText('none is saved in this browser yet')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /needs a membership/ }).first()).toBeVisible();
  await expect(page.getByText('Add your key')).toHaveCount(0);

  // The pool is off here; credit is sold, and anyone can buy it.
  await notice.getByRole('button', { name: 'Continue on Tangent credit' }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start lesson' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('tangent.learn.payment'))).toBe('credit');
});

test('a membership that lapses mid-session: the refused message comes back after carrying on', async ({
  context,
  page,
  baseURL,
}) => {
  const userId = await signIn(context, baseURL!, newEmail('learn-lapse-mid'));
  await paymentWebhook(context.request, [membership(userId, 'active', 1)]);
  await chooseOwnKey(page);
  await page.goto('/learn/');
  await expect(page.getByRole('button', { name: 'Start lesson' })).toBeVisible();

  // Cancelled while the page is open: it still thinks the learner is a member.
  await paymentWebhook(context.request, [membership(userId, 'canceled', 2)]);
  const statuses: number[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/messages') && r.request().method() === 'POST') statuses.push(r.status());
  });
  await page.locator('#new-lesson-topic').fill('Why is the sky blue?');
  await page.getByRole('button', { name: 'Start lesson' }).click();

  // The server refuses the reply (402 membership_required); the lesson opens with the
  // notice where the composer would be, and no error toast or dialog.
  await expect(page).toHaveURL(/\/learn\/t\/[^/]+/);
  const notice = page.getByRole('region', { name: 'Your membership has ended.' });
  await expect(notice).toBeVisible();
  expect(statuses).toEqual([402]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.toast-error')).toHaveCount(0);

  await notice.getByRole('button', { name: 'Continue on Tangent credit' }).click();
  await expect(notice).toHaveCount(0);
  // The composer is back, holding the message the server refused.
  await expect(page.getByRole('textbox')).toHaveValue('Why is the sky blue?');
});

test('a never-member: the own-key choice is locked in the dialog, and a stored one asks to become a member', async ({
  context,
  page,
  baseURL,
}) => {
  await signIn(context, baseURL!, newEmail('learn-never'));
  await chooseOwnKey(page);

  await page.goto('/learn/');
  const notice = page.getByRole('region', { name: 'Replies on your own key need a membership.' });
  await expect(notice.getByRole('button', { name: 'Become a member' })).toBeEnabled();
  await notice.getByRole('button', { name: 'Continue on Tangent credit' }).click();
  await expect(page.getByRole('button', { name: 'Start lesson' })).toBeVisible();

  // How replies are paid for: the own key can't be picked again without a membership.
  await page
    .getByRole('button', { name: /Change how replies are paid for/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'How replies are paid for' });
  await expect(dialog.getByRole('radio', { name: /Use my own API key/ })).toBeDisabled();
  await expect(dialog).toContainText('Needs a membership');
  await expect(dialog.getByRole('radio', { name: /Use Tangent credit/ })).toBeChecked();
});

test('a member saves an Anthropic key in the dialog, and replies run on it, named in the switch and the pill', async ({
  context,
  page,
  baseURL,
}) => {
  const userId = await signIn(context, baseURL!, newEmail('learn-anthropic'));
  // A member with credit: the composer's funding switch offers credit, the pool and the key.
  await paymentWebhook(context.request, [membership(userId, 'active', 1), topUp(userId, 500)]);
  // The switch shows only while the pool is on too, which this server leaves off for
  // the other suites: this browser reads it as on. Replies here run on the key, so
  // nothing reaches the pool.
  await page.route('**/api/pool/status', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), enabled: true } });
  });

  await page.goto('/learn/');
  await expect(page.getByRole('heading', { name: 'New lesson' })).toBeVisible();
  await page
    .getByRole('button', { name: /Change how replies are paid for/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'How replies are paid for' });
  await dialog.getByRole('radio', { name: /Use my own API key/ }).check();
  // Which key belongs to the own key's option.
  const which = dialog.getByRole('group', { name: 'Which key' });
  await which.getByRole('radio', { name: /^Anthropic/ }).check();
  await dialog.getByLabel('Your Anthropic API key').fill('sk-ant-e2e-learner-key-1');
  await dialog.getByRole('button', { name: 'Save key' }).click();
  await expect(page.locator('.toast')).toContainText('Your Anthropic key is saved');
  await expect(dialog.getByText('saved', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /^Replies paid by Your Anthropic key\./ }),
  ).toHaveText(/Anthropic key/);

  const sends: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/messages') && r.method() === 'POST')
      sends.push(r.headers()['x-tangent-own-key'] ?? '');
  });
  await page.locator('#new-lesson-topic').fill('Why is the sky blue?');
  await page.getByRole('button', { name: 'Start lesson' }).click();
  await expect(page).toHaveURL(/\/learn\/t\/[^/]+/);
  // The scripted Anthropic upstream answered, on the model Learn runs on that key.
  await expect(page.locator('.msg-assistant')).toContainText(
    'Scripted reply (claude-sonnet-5-5): "Why is the sky blue?"',
  );
  expect(sends).toEqual(['anthropic']);

  const pay = page.getByRole('toolbar', { name: 'Pay for replies with' });
  await expect(pay.getByRole('button')).toHaveText(['My credit', 'Open pool', 'Anthropic key']);
  await expect(pay.getByRole('button', { name: 'Anthropic key' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
