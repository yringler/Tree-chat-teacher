import { expect, test, type Page } from '@playwright/test';

/*
 * Learn's Compare ("ask Normal and Max, keep one"), against the in-browser
 * Learn demo (/learn/demo/): its backend runs the real ChatService on lorem
 * models, where the e2e Worker's built-in provider can't answer. Each test
 * gets a fresh browser context, so a fresh demo session.
 */

const QUESTION = 'Why do owls hum before they hoot?';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

/** Starts an empty lesson and opens Compare on `QUESTION`; returns the sheet. */
async function compareInNewLesson(page: Page) {
  await page.goto('/learn/demo/');
  await page.getByRole('button', { name: 'Start lesson' }).click();
  await expect(page).toHaveURL(/\/t\//);
  const composer = page.locator('#composer-input');
  await composer.fill(QUESTION);
  await page.getByRole('button', { name: 'Compare Normal and Max' }).click();
  const sheet = page.getByRole('dialog', { name: 'Compare answers' });
  await expect(sheet).toBeVisible();
  return sheet;
}

test('Learn compare: side by side on a wide screen, and only the picked answer is kept', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const sheet = await compareInNewLesson(page);

  await expect(sheet.locator('.compare-question')).toHaveText(QUESTION);
  await expect(sheet.getByText(/Only the answer you pick is kept\./)).toBeVisible();
  // Wide: both answers at once, no tab bar.
  await expect(sheet.locator('.compare-tabs')).toBeHidden();
  const normal = sheet.locator('.compare-pane', {
    has: page.getByRole('heading', { name: 'Normal' }),
  });
  const max = sheet.locator('.compare-pane', { has: page.getByRole('heading', { name: 'Max' }) });
  await expect(normal).toBeVisible();
  await expect(max).toBeVisible();

  // Both finish (one after the other), then either can be kept.
  const useMax = max.getByRole('button', { name: 'Use this answer' });
  await expect(normal.getByRole('button', { name: 'Use this answer' })).toBeEnabled({
    timeout: 45_000,
  });
  await expect(useMax).toBeEnabled({ timeout: 45_000 });
  const kept = (await max.locator('.compare-body').innerText()).trim();
  expect(kept.length).toBeGreaterThan(0);
  await useMax.click();

  await expect(sheet).toBeHidden();
  await expect(page.locator('.msg-user')).toHaveCount(1);
  await expect(page.locator('.msg-user .msg-body')).toHaveText(QUESTION);
  await expect(page.locator('.msg-assistant')).toHaveCount(1);
  await expect(page.locator('.msg-assistant .msg-body')).toContainText(kept.slice(0, 40));
  // The question left the composer with the kept exchange.
  await expect(page.locator('#composer-input')).toHaveValue('');
  expect(errors).toEqual([]);
});

test('Learn compare: one answer at a time on a phone; closing keeps the question', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const sheet = await compareInNewLesson(page);

  // Narrow: a tab bar, one answer shown.
  const tabs = sheet.locator('.compare-tabs');
  await expect(tabs).toBeVisible();
  const normal = sheet.locator('.compare-pane', {
    has: page.getByRole('heading', { name: 'Normal' }),
  });
  const max = sheet.locator('.compare-pane', { has: page.getByRole('heading', { name: 'Max' }) });
  await expect(normal).toBeVisible();
  await expect(max).toBeHidden();
  await tabs.getByRole('tab', { name: /Max/ }).click();
  await expect(max).toBeVisible();
  await expect(normal).toBeHidden();
  await expect(tabs.getByRole('tab', { name: /Max/ })).toHaveAttribute('aria-selected', 'true');

  // Closing discards both answers: nothing joins the lesson, the question stays.
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.locator('.msg')).toHaveCount(0);
  await expect(page.locator('#composer-input')).toHaveValue(QUESTION);
  await expect(page.getByRole('button', { name: 'Compare Normal and Max' })).toBeEnabled();
  expect(errors).toEqual([]);
});
