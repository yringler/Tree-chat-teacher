import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { withExampleLesson } from './example-lesson';

/*
 * Links between messages in the Canvas, against the Worker: the demos'
 * example conversation ("How do kittens learn to whistle?"), imported into
 * the power account on Tangent credit, has a main thread, a side question
 * lane ("Why the owl hums first"), a followed tangent lane ("Why practice
 * works better in the evening") and one link (the main thread's second reply
 * to that tangent's first message). Links are drawn as lines between the
 * lanes with a glyph halfway. Each test is a new user.
 */

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

/** The card whose own text (not a link chip on it) contains `text`. */
function card(page: Page, text: string): Locator {
  return page
    .locator('article.card')
    .filter({ has: page.locator('.card-body', { hasText: text }) });
}

async function openSeededConversation(page: Page, context: BrowserContext, baseURL: string) {
  const treeId = await withExampleLesson(context, baseURL, 'power');
  await page.goto(`/canvas/t/${treeId}`);
  await expect(page.locator('app-lane')).toHaveCount(3);
  // The seeded link: one line, one glyph.
  await expect(page.locator('.xlink-path')).toHaveCount(1);
  await expect(page.locator('.xlink-glyph')).toHaveCount(1);
}

/** Drags a link out of `from`'s port and lets go over `to`. */
async function dragLink(page: Page, from: Locator, to: Locator): Promise<void> {
  await from.hover();
  const port = await from.locator('.card-port').boundingBox();
  const target = await to.locator('.card-body').boundingBox();
  expect(port).not.toBeNull();
  expect(target).not.toBeNull();
  const start = { x: port!.x + port!.width / 2, y: port!.y + port!.height / 2 };
  const end = { x: target!.x + target!.width / 2, y: target!.y + Math.min(12, target!.height / 2) };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 16, start.y + 8, { steps: 3 });
  await expect(page.locator('.xlink-rubber')).toBeVisible();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await expect(to).toHaveClass(/is-link-target/);
  await page.mouse.up();
  await expect(page.locator('.xlink-rubber')).toHaveCount(0);
}

test('canvas: drag a link between cards, follow it from its glyph, come back, remove it', async ({
  page,
  context,
  baseURL,
}) => {
  const errors = collectErrors(page);
  await openSeededConversation(page, context, baseURL!);

  const owls = card(page, 'Owls are courteous creatures');
  const kittens = card(page, 'How do kittens learn to whistle?');
  const owlsId = await owls.getAttribute('data-node-id');
  const kittensId = await kittens.getAttribute('data-node-id');
  expect(owlsId).toBeTruthy();
  expect(kittensId).toBeTruthy();

  // From the side question's reply (one lane) onto the main thread's first question (another).
  await dragLink(page, owls, kittens);
  await expect(page.locator('.toast', { hasText: 'Messages linked' })).toBeVisible();
  await expect(page.locator('.xlink-path')).toHaveCount(2);
  await expect(owls.locator('.related-chip', { hasText: 'How do kittens learn' })).toBeVisible();
  await expect(kittens.locator('.related-chip', { hasText: 'Owls are courteous' })).toBeVisible();

  // The new link's glyph opens its popover: both ends, no note yet.
  const glyph = page.locator('.xlink-glyph[aria-label*="How do kittens learn to whistle?"]');
  await expect(glyph).toHaveCount(1);
  await glyph.click();
  const popover = page.getByRole('dialog', { name: 'Linked messages' });
  await expect(popover).toBeVisible();
  await expect(popover.locator('.xlink-end')).toHaveCount(2);
  await expect(popover.locator('.xlink-note')).toHaveText('No note.');

  // A note, edited in place.
  await popover.getByRole('button', { name: 'Add a note' }).click();
  await popover.getByRole('textbox', { name: 'Note on this link' }).fill('Both start by listening');
  await page.keyboard.press('Enter');
  await expect(popover.locator('.xlink-note')).toHaveText('Both start by listening');
  await expect(glyph).toHaveClass(/has-note/);

  // "Go to" the main thread's question: its lane is selected, the card focused.
  await popover.getByRole('button', { name: 'Go to How do kittens learn to whistle?' }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]m=${kittensId}`));
  await expect(kittens).toHaveClass(/is-focused/);
  await expect(popover).toBeHidden();
  const back = page.locator('.link-return');
  await expect(back).toContainText('Back to ‘Why the owl hums first’');

  // The pill goes back to the end the link was followed from.
  await back.click();
  await expect(page).toHaveURL(new RegExp(`[?&]m=${owlsId}`));
  await expect(owls).toHaveClass(/is-focused/);
  await expect(back).toHaveCount(0);

  // The browser's Back works too.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`[?&]m=${kittensId}`));
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`[?&]m=${owlsId}`));

  // Remove: asks first, then both the line and the chips go.
  await glyph.click();
  await expect(popover).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await popover.getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.toast', { hasText: 'Link removed' })).toBeVisible();
  await expect(page.locator('.xlink-path')).toHaveCount(1);
  await expect(owls.locator('.related-chip')).toHaveCount(0);
  await expect(kittens.locator('.related-chip')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('canvas: link with the keyboard (R), by clicking a card or by searching', async ({
  page,
  context,
  baseURL,
}) => {
  const errors = collectErrors(page);
  await openSeededConversation(page, context, baseURL!);
  await page.locator('.canvas-title').click();

  // R on the main thread: links from its latest message.
  const creative = card(page, 'creative kittens are born');
  const owls = card(page, 'Owls are courteous creatures');
  const tangentHead = card(page, 'Why practice works better in the evening');
  await page.keyboard.press('r');
  const banner = page.locator('.link-pick-banner');
  await expect(banner).toContainText('Click the card that relates to');
  await expect(banner).toContainText('creative kittens');
  await expect(creative.getByRole('button', { name: 'Linking from here' })).toBeDisabled();
  await expect(tangentHead.getByRole('button', { name: 'Already linked' })).toBeDisabled();

  await owls.getByRole('button', { name: 'Link here' }).click();
  await expect(page.locator('.toast', { hasText: 'Messages linked' })).toBeVisible();
  await expect(banner).toHaveCount(0);
  await expect(page.locator('.xlink-path')).toHaveCount(2);
  const chip = owls.locator('.related-chip', { hasText: 'creative kittens' });
  await expect(chip).toBeVisible();

  // A chip follows the link like the glyph's "Go to".
  const creativeId = await creative.getAttribute('data-node-id');
  await chip.click();
  await expect(page).toHaveURL(new RegExp(`[?&]m=${creativeId}`));
  await expect(creative).toHaveClass(/is-focused/);
  await expect(page.locator('.link-return')).toContainText('Back to ‘Why the owl hums first’');

  // R again, now from the focused card; Search instead of clicking.
  await page.locator('.canvas-title').click();
  await page.keyboard.press('r');
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Search' }).click();
  await expect(banner).toHaveCount(0);
  const dialog = page.getByRole('dialog', { name: 'Link to another message' });
  await expect(dialog).toBeVisible();
  const search = dialog.getByRole('combobox');
  await expect(search).toBeFocused();
  await search.fill('lemon louder');
  await dialog.getByRole('option', { name: /Because the lemon is louder/ }).click();
  await dialog.getByRole('textbox', { name: 'Note (optional)' }).fill('Evening practice');
  await dialog.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.xlink-path')).toHaveCount(3);
  await expect(creative.locator('.related-chip', { hasText: 'Because the lemon' })).toBeVisible();

  // Escape ends pick mode without linking.
  await page.keyboard.press('r');
  await expect(banner).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(banner).toHaveCount(0);
  await expect(page.locator('.xlink-path')).toHaveCount(3);

  // The Links toggle hides the lines and glyphs, the chips stay.
  await page.getByRole('button', { name: 'Links', exact: true }).click();
  await expect(page.locator('.xlink-path')).toHaveCount(0);
  await expect(page.locator('.xlink-glyph')).toHaveCount(0);
  await expect(chip).toBeVisible();
  expect(errors).toEqual([]);
});
