import { expect, test, type Locator, type Page } from '@playwright/test';

/*
 * Links between messages in the power demo (/demo): the seeded lesson
 * ("How do kittens learn to whistle?") has a main thread, a side question
 * ("Why the owl hums first"), a followed tangent ("Why practice works better
 * in the evening") and one link (the main thread's second reply to that
 * tangent). Each test gets a fresh browser context, so a fresh demo session.
 */

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

/** The message whose own text (not a link chip under it) contains `text`. */
function message(page: Page, text: string): Locator {
  return page.locator('article.msg').filter({ has: page.locator('.msg-body', { hasText: text }) });
}

async function openSeededLesson(page: Page): Promise<void> {
  await page.goto('/demo');
  await page.locator('.home-list .tree-row a', { hasText: 'How do kittens learn' }).click();
  await expect(page).toHaveURL(/\/demo\/t\//);
  await expect(page.locator('article.msg').first()).toBeVisible();
}

async function openBranch(page: Page, title: string): Promise<void> {
  await page.locator('.outline-link', { hasText: title }).click();
  await expect(page.locator('.crumb-current', { hasText: title })).toBeVisible();
}

test('power demo: link a nested branch message to the main thread through the search dialog', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openSeededLesson(page);

  // A nested branch: follow one of the tangent's own suggested tangents.
  await openBranch(page, 'Why practice works better in the evening');
  await page.locator('.tangent', { hasText: 'Why rewards must arrive quickly' }).click();
  await expect(
    page.locator('.crumb-current', { hasText: 'Why rewards must arrive quickly' }),
  ).toBeVisible();
  // Main thread ×2, tangent ×2, the new branch's question and its (streamed) reply.
  await expect(page.locator('article.msg')).toHaveCount(6);
  await expect(page.locator('.msg .cursor')).toHaveCount(0, { timeout: 30_000 });
  const nestedUrl = page.url();

  const source = message(page, 'Why rewards must arrive quickly');
  const sourceId = await source.getAttribute('data-node-id');
  expect(sourceId).toBeTruthy();
  await source.hover();
  await source.getByRole('button', { name: 'Link…', exact: true }).click();

  // The dialog: search the main thread's second reply (not on this branch's path).
  const dialog = page.getByRole('dialog', { name: 'Link to another message' });
  await expect(dialog).toBeVisible();
  const search = dialog.getByRole('combobox');
  await expect(search).toBeFocused();
  await search.fill('creative kittens');
  await dialog.getByRole('option', { name: /creative kittens are born/ }).click();
  await dialog.getByRole('textbox', { name: 'Note (optional)' }).fill('Practice makes the tune');
  await dialog.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.toast', { hasText: 'Messages linked' })).toBeVisible();

  // The chip at this end: where the other end lives and what it says, and the note.
  const here = source.locator('.related-chip', { hasText: 'creative kittens are born' });
  await expect(here).toBeVisible();
  await expect(here.locator('.related-crumbs')).toHaveText('Main thread');
  await expect(source.locator('.related-note')).toHaveText('Practice makes the tune');
  await expect(page.locator('.outline-links').first()).toBeVisible();

  // Opening it goes to the main thread, focused on the reply, which links back.
  await here.click();
  const target = message(page, 'creative kittens are born');
  await expect(target).toHaveClass(/msg-focused/);
  const targetId = await target.getAttribute('data-node-id');
  await expect(page).toHaveURL(new RegExp(`[?&]m=${targetId}`));
  await expect(page.locator('.crumb-current', { hasText: 'Main thread' })).toBeVisible();
  const back = target.locator('.related-chip', {
    hasText: 'Tangent: Why rewards must arrive quickly',
  });
  await expect(back).toBeVisible();
  // The seeded link is still there too.
  await expect(
    target.locator('.related-chip', { hasText: 'Tangent: Why practice works better' }),
  ).toBeVisible();
  await expect(page.locator('.link-return')).toContainText('Why rewards must arrive quickly');

  // The browser's Back returns to where the chip was opened.
  await page.goBack();
  await expect(page).toHaveURL(nestedUrl);
  await expect(source).toBeVisible();

  // So does the return pill.
  await here.click();
  await expect(page).toHaveURL(new RegExp(`[?&]m=${targetId}`));
  await page.locator('.link-return').click();
  await expect(page).toHaveURL(new RegExp(`[?&]m=${sourceId}`));
  await expect(source).toHaveClass(/msg-focused/);
  await expect(page.locator('.link-return')).toHaveCount(0);

  // Removing it from the far end asks first, and clears both ends.
  await here.click();
  await expect(target).toHaveClass(/msg-focused/);
  page.once('dialog', (d) => d.accept());
  await target
    .getByRole('button', { name: 'Remove the link to Tangent: Why rewards must arrive quickly' })
    .click();
  await expect(page.locator('.toast', { hasText: 'Link removed' })).toBeVisible();
  await expect(back).toHaveCount(0);
  await expect(
    target.locator('.related-chip', { hasText: 'Tangent: Why practice works better' }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`[?&]m=${sourceId}`));
  await expect(source.locator('app-related-links .related-links')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('power demo: pick the other end on the page, across branches', async ({ page }) => {
  const errors = collectErrors(page);
  await openSeededLesson(page);
  await openBranch(page, 'Why practice works better in the evening');

  const source = message(page, 'Because the lemon is louder in the evening');
  await source.hover();
  await source.getByRole('button', { name: 'Link…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Link to another message' });
  await dialog.getByRole('button', { name: 'Pick on the page instead' }).click();
  await expect(dialog).toBeHidden();

  const banner = page.locator('.link-pick-banner');
  await expect(banner).toContainText('Choose the message that relates to');
  await expect(banner).toContainText('Because the lemon is louder');
  await expect(source.getByRole('button', { name: 'Linking from here' })).toBeDisabled();

  // Pick mode stays on while moving to another branch.
  await openBranch(page, 'Why the owl hums first');
  await expect(banner).toBeVisible();
  const target = message(page, 'Owls are courteous creatures');
  await target.getByRole('button', { name: 'Link here' }).click();
  await expect(page.locator('.toast', { hasText: 'Messages linked' })).toBeVisible();
  await expect(banner).toHaveCount(0);
  await expect(
    target.locator('.related-chip', { hasText: 'Because the lemon is louder' }),
  ).toBeVisible();

  // Again from the same message (the `l` key on it): already linked, so not offered; Esc ends it.
  await openBranch(page, 'Why practice works better in the evening');
  await source.locator('.msg-body').click();
  await expect(source).toHaveClass(/msg-focused/);
  await page.keyboard.press('l');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Pick on the page instead' }).click();
  await openBranch(page, 'Why the owl hums first');
  await expect(target.getByRole('button', { name: 'Already linked' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(banner).toHaveCount(0);
  await expect(target.getByRole('button', { name: 'Link here' })).toHaveCount(0);
  expect(errors).toEqual([]);
});
