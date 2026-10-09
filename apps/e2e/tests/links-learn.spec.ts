import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { withExampleLesson } from './example-lesson';

/*
 * Connections between messages in Learn, against the Worker: the example
 * lesson's connection, connecting two messages through the "Connect" sheet,
 * the chips at both ends, following one and coming back, and removing it.
 * Each test is a new learner with the demos' example lesson imported.
 */

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

/** Opens the example lesson on its main thread. */
async function openExampleLesson(page: Page, context: BrowserContext, baseURL: string) {
  const treeId = await withExampleLesson(context, baseURL, 'learn');
  await page.goto(`/learn/t/${treeId}`);
  await expect(page.locator('app-message-item').first()).toBeVisible();
}

const message = (page: Page, text: string) =>
  page.locator('app-message-item').filter({ hasText: text });

test('Learn: the example lesson shows its connection at both ends', async ({
  page,
  context,
  baseURL,
}) => {
  const errors = collectErrors(page);
  await openExampleLesson(page, context, baseURL!);

  const secondReply = message(page, 'that is how creative kittens are born');
  await expect(secondReply.locator('.related-label')).toHaveText(/Connected to 1 message/);
  const chip = secondReply.locator('.connections .related-chip');
  await expect(chip).toHaveText(/Side question: Why practice works better in the evening/);
  await expect(secondReply.locator('.related-note')).toHaveText(
    'A made-up tune still needs practice to get catchy',
  );

  // Following it opens the side question, focused on its first message, which links back.
  await chip.click();
  await expect(page).toHaveURL(/\/learn\/t\/[^/]+\/b\/[^/?]+\?m=/);
  const head = page.locator('app-message-item .msg-focused');
  await expect(head).toContainText('Why practice works better in the evening');
  await expect(head.locator('.connections .related-chip')).toContainText(
    'that is how creative kittens are born',
  );
  expect(errors).toEqual([]);
});

test('Learn: connect two messages, follow the connection, come back, remove it', async ({
  page,
  context,
  baseURL,
}) => {
  const errors = collectErrors(page);
  await openExampleLesson(page, context, baseURL!);
  const firstReply = message(page, 'By copying owls, mostly.');
  await expect(firstReply.locator('.connections')).not.toContainText('Connected to');

  // Escape closes the sheet without connecting anything.
  await firstReply.locator('.msg-connect').click();
  const sheet = page.getByRole('dialog', { name: 'Connect this message' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('combobox')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // Search, pick the side question with Enter, add a note, Connect.
  await firstReply.locator('.msg-connect').click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole('combobox').fill('owl hums');
  await expect(sheet.getByRole('option').first()).toContainText('Why the owl hums first');
  await sheet.getByRole('combobox').press('Enter');
  const note = sheet.getByLabel('Why? (a note for yourself)');
  await expect(note).toBeFocused();
  await note.fill('Both are about the owl');
  await sheet.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(page.locator('.toast').filter({ hasText: 'Connected' })).toBeVisible();

  // The chip under the message it was made from…
  const chip = firstReply.locator('.connections .related-chip');
  await expect(chip).toHaveText(/Side question: Why the owl hums first/);
  await expect(firstReply.locator('.related-note')).toHaveText('Both are about the owl');

  // …and, after following it, under the other end, with the way back.
  await chip.click();
  await expect(page).toHaveURL(/\/b\/[^/?]+\?m=/);
  const head = page.locator('app-message-item .msg-focused');
  await expect(head).toContainText('Why does the owl hum first?');
  await expect(head.locator('.connections .related-chip')).toContainText(
    'By copying owls, mostly.',
  );
  const back = page.locator('.link-return button');
  await expect(back).toContainText('Back to “By copying owls, mostly.');

  await back.click();
  await expect(page).toHaveURL(/\/learn\/t\/[^/]+\?m=/);
  await expect(page.locator('.link-return')).toHaveCount(0);
  await expect(page.locator('app-message-item .msg-focused')).toContainText(
    'By copying owls, mostly.',
  );

  // Remove (asks first): gone from both ends.
  const asked: string[] = [];
  page.once('dialog', async (d) => {
    asked.push(d.message());
    await d.accept();
  });
  await firstReply
    .getByRole('button', { name: 'Remove the connection to Side question: Why the owl hums first' })
    .click();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toContain('Remove this connection?');
  await expect(firstReply.locator('.connections .related-chip')).toHaveCount(0);
  await expect(page.locator('.toast').filter({ hasText: 'Connection removed' })).toBeVisible();

  // The side question's first message has no chip either.
  await firstReply.locator('.side-questions .chip', { hasText: 'Why the owl hums first' }).click();
  await expect(page).toHaveURL(/\/b\/[^/?]+\?m=/);
  await expect(message(page, 'Why does the owl hum first?')).toBeVisible();
  await expect(
    page.locator('.connections .related-chip', { hasText: 'By copying owls' }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
