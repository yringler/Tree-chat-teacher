import { expect, test, type Page } from '@playwright/test';
import { membership, newEmail, paymentWebhook, sameOrigin, signIn } from './helpers';

/*
 * Power's input limit (Settings → Input limit), against the real Worker: on
 * the user's own key (the offline fake provider, a 200,000-token window), the
 * setting shows the model's default and the chosen limit in words and pages
 * as it is edited, is kept in the browser, rides along with every send and
 * with the Context panel's preview, and its over-limit choice decides whether
 * the oldest messages are summarized or dropped.
 */

interface TreeDetail {
  tree: { id: string; trunkBranchId: string };
}

/**
 * About 1,430 tokens each (3.5 characters a token): with the built-in system
 * prompt (about 1,000), three of them overflow a 3,000-token limit, which
 * still has room for a summary of the oldest ones.
 */
const LONG = 'The quick brown fox jumps over the lazy dog. '.repeat(110);

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  return { dialog, section: dialog.getByRole('group', { name: 'Input limit' }) };
}

// One test, one sign-in: magic links are limited to 5 a minute, for the whole suite.
test('the input limit shows its size live, persists, and shapes sends and the Context preview', async ({
  context,
  page,
  baseURL,
}) => {
  const userId = await signIn(context, baseURL!, newEmail('input-limit'));
  const request = context.request;
  const headers = sameOrigin(baseURL!);
  await paymentWebhook(request, [membership(userId, 'active', 1)]);
  const created = await request.post('/api/trees', {
    headers,
    data: { title: 'Long talk', providerId: 'fake', model: 'fake-1' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const t = ((await created.json()) as TreeDetail).tree;
  for (const n of [1, 2, 3]) {
    const sent = await request.post(`/api/branches/${t.trunkBranchId}/messages`, {
      headers,
      data: { content: `Part ${n}. ${LONG}` },
    });
    expect(await sent.text()).toContain('"type":"done"');
  }

  await page.goto(`/t/${t.id}`);
  let { dialog, section } = await openSettings(page);

  // Off: the model's own default, in tokens, words and pages.
  const limit = section.getByRole('checkbox', { name: 'Limit what each message sends' });
  await expect(limit).not.toBeChecked();
  await expect(section.locator('.input-limit-route')).toHaveText(
    "Without a limit, this conversation's model (fake-1) takes up to 195,904 tokens a message: " +
      'its 200,000-token context window less 4,096 for the reply.',
  );
  await expect(section.locator('.input-limit-size')).toHaveText(
    '195,904 tokens ≈ 150,000 words ≈ 530 paperback pages, about the length of a long novel.',
  );
  // The fake model has no list price: no cost is made up.
  await expect(section.locator('.input-limit-cost')).toHaveCount(0);

  // On: 32,000 to start with, then a custom number, live as it is typed.
  await limit.check();
  const presets = section.getByRole('radiogroup', { name: 'Input limit' });
  await expect(presets.getByRole('radio', { name: '32,000' })).toBeChecked();
  await expect(section.locator('.input-limit-size')).toHaveText(
    '32,000 tokens ≈ 24,000 words ≈ 87 paperback pages, about the length of a novella.',
  );
  await presets.getByRole('radio', { name: 'Custom' }).check();
  const box = section.getByRole('spinbutton', { name: /Tokens/ });
  await box.fill('200');
  await expect(section.getByRole('alert')).toHaveText(/Enter a whole number from 1,000/);
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
  await box.fill('3000');
  await expect(section.getByRole('alert')).toHaveCount(0);
  await expect(section.locator('.input-limit-size')).toHaveText(
    '3,000 tokens ≈ 2,300 words ≈ 8.2 paperback pages, about the length of a short story.',
  );
  const overflow = section.getByRole('radiogroup', { name: 'Over the limit' });
  await expect(overflow.getByRole('radio', { name: /Summarize the oldest part/ })).toBeChecked();
  await overflow.getByRole('radio', { name: /Drop the oldest messages/ }).check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);

  // Kept in this browser across a reload.
  await page.reload();
  ({ dialog, section } = await openSettings(page));
  await expect(
    section.getByRole('checkbox', { name: 'Limit what each message sends' }),
  ).toBeChecked();
  await expect(section.getByRole('spinbutton', { name: /Tokens/ })).toHaveValue('3000');
  await expect(
    section
      .getByRole('radiogroup', { name: 'Over the limit' })
      .getByRole('radio', { name: /Drop the oldest messages/ }),
  ).toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // The Context panel plans with the limit: the oldest messages are dropped.
  const previewed = page.waitForRequest(
    (r) => r.url().includes(`/api/branches/${t.trunkBranchId}/context?`) && r.method() === 'GET',
  );
  await page.getByRole('button', { name: 'Context inspector (i)' }).click();
  const query = new URL((await previewed).url()).searchParams;
  expect(query.get('maxInputTokens')).toBe('3000');
  expect(query.get('inputOverflow')).toBe('truncate');
  const inspector = page.locator('app-inspector');
  await expect(inspector).toContainText('/ 3,000 tokens (est.)');
  await expect(inspector).toContainText('Truncated:');
  await expect(inspector).toContainText('Settings drop the oldest messages over the limit');

  // A send carries the limit, and only the newest messages reach the model.
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('And what next?');
  const asked = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith(`/api/branches/${t.trunkBranchId}/messages`),
  );
  await page.getByRole('button', { name: 'Send message' }).click();
  expect((await asked).postDataJSON()).toEqual({
    content: 'And what next?',
    maxInputTokens: 3000,
    inputOverflow: 'truncate',
  });
  // Without the limit it would be 7 messages (three exchanges and the new question).
  const reply = page.getByText(/Fake reply \(fake-1\) to \d+ message\(s\): "And what next\?"/);
  await expect(reply).toBeVisible();
  const count = Number(/to (\d+) message/.exec((await reply.textContent()) ?? '')?.[1]);
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThan(7);

  // Summarize instead: the preview compacts the oldest part, and sends say nothing of it.
  ({ dialog, section } = await openSettings(page));
  await section
    .getByRole('radiogroup', { name: 'Over the limit' })
    .getByRole('radio', { name: /Summarize the oldest part/ })
    .check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(inspector).toContainText('Compacted:');
  await expect(inspector).not.toContainText('Settings drop the oldest messages');
  await composer.fill('One more?');
  const again = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith(`/api/branches/${t.trunkBranchId}/messages`),
  );
  await page.getByRole('button', { name: 'Send message' }).click();
  expect((await again).postDataJSON()).toEqual({ content: 'One more?', maxInputTokens: 3000 });
  await expect(
    page.getByText(/Fake reply \(fake-1\) to \d+ message\(s\): "One more\?"/),
  ).toBeVisible();
});
