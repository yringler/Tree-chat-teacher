import { expect, test, type Page } from '@playwright/test';

/*
 * The guidance on when to go on a tangent and when to reply, in the Learn
 * demo (/learn/demo): the first-run walkthrough round the loop (Tangent ↳,
 * back to the main thread, Next ➜), the "How tangents work" sheet that
 * replays it, and the "Keep going" suggestions that reply in place. Each
 * test gets a fresh browser context, so a fresh demo session that has not
 * had the walkthrough.
 */

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

async function openExampleLesson(page: Page): Promise<void> {
  await page.goto('/learn/demo/');
  await page.locator('.lesson-row a').first().click();
  await expect(page.locator('.msg').first()).toBeVisible();
}

test('Learn demo: the first-run walkthrough goes round the loop once, then stays away', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openExampleLesson(page);
  const coach = page.locator('.coach-mark');
  const composer = page.locator('#composer-input');
  const tangent = page.locator('[data-action="tangent"]');
  const next = page.locator('[data-action="next"]');

  // Step 1, under the main thread's reply: Tangent ↳, without taking the focus.
  await expect(coach).toBeVisible();
  await expect(coach).toContainText('Anything confusing or interesting? Go on a tangent.');
  await expect(coach.getByRole('button', { name: 'Skip tour' })).toBeVisible();
  await expect(tangent).toHaveText('Tangent ↳');
  await expect(next).toHaveText('Next ➜');
  await expect(tangent).toHaveAttribute('title', /^Wait, what’s that\?/);
  await expect(next).toHaveAttribute('title', /^Got it, what’s next\? Keeps the main lesson/);
  await expect(coach).not.toBeFocused();
  // The coach mark adds nothing to the page's height: the page itself never scrolls.
  expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBe(0);

  // Going on a tangent: step 2 points at the way back.
  const trunkUrl = page.url();
  await composer.fill('What is a whistle, really?');
  await tangent.click();
  await expect.poll(() => page.url()).not.toBe(trunkUrl);
  await expect(page).toHaveURL(/\/b\//);
  await expect(coach).toContainText('Tangents never clutter your main lesson. Head back anytime.');
  const mainThread = page.locator('[data-coach="main-thread"]');
  await expect(mainThread).toHaveText('Main thread');
  await expect(mainThread).toHaveAttribute('title', 'Back to main thread');
  // Below the path, so it covers the messages rather than the header.
  const crumb = (await mainThread.boundingBox())!;
  expect((await coach.boundingBox())!.y).toBeGreaterThan(crumb.y + crumb.height);
  // Inside the tangent, Next ➜ keeps the tangent moving.
  await expect(next).toHaveAttribute('title', /Keeps this tangent moving/);

  // Back on the main thread: step 3 points at Next ➜, and Done ends the tour.
  await mainThread.click();
  await expect(page).not.toHaveURL(/\/b\//);
  await expect(coach).toContainText('Ready to move on? Reply.');
  await coach.getByRole('button', { name: 'Done' }).click();
  await expect(coach).toBeHidden();

  // Finished, it stays away (the demo keeps the session across a reload).
  await page.reload();
  await expect(page.locator('.msg').first()).toBeVisible();
  await expect(next).toBeVisible();
  await expect(coach).toBeHidden();

  // "How tangents work", from the header's ?: the rule, and the tour once more.
  await page.getByRole('button', { name: 'How tangents work' }).click();
  const help = page.getByRole('dialog', { name: 'How tangents work' });
  await expect(help).toBeVisible();
  await expect(help).toContainText('Reply = the next step. Tangent = a side trip.');
  await expect(help).toContainText('Not sure? Tangent.');
  await help.getByRole('button', { name: 'Replay the walkthrough' }).click();
  await expect(help).toBeHidden();
  await expect(coach).toContainText('Anything confusing or interesting? Go on a tangent.');
  // Escape skips it.
  await page.keyboard.press('Escape');
  await expect(coach).toBeHidden();
  expect(errors).toEqual([]);
});

test('Learn demo: replying with Next ➜ on the last step finishes the walkthrough', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openExampleLesson(page);
  const coach = page.locator('.coach-mark');
  const composer = page.locator('#composer-input');
  const users = page.locator('.msg-user');
  const replies = page.locator('.msg-assistant');

  await expect(coach).toContainText('Anything confusing or interesting? Go on a tangent.');
  await composer.fill('What is a whistle, really?');
  await page.locator('[data-action="tangent"]').click();
  await expect(page).toHaveURL(/\/b\//);
  await expect(coach).toContainText('Tangents never clutter your main lesson. Head back anytime.');
  await page.locator('[data-coach="main-thread"]').click();
  await expect(page).not.toHaveURL(/\/b\//);
  await expect(coach).toContainText('Ready to move on? Reply.');

  // Doing what step 3 asks ends the tour, as Done does.
  const before = await users.count();
  const repliesBefore = await replies.count();
  await composer.fill('And what comes next?');
  await page.locator('[data-action="next"]').click();
  await expect(users).toHaveCount(before + 1);
  await expect(coach).toBeHidden();
  await expect(replies).toHaveCount(repliesBefore + 1);
  await expect(replies.last()).not.toHaveClass(/streaming/, { timeout: 30_000 });
  await expect(coach).toBeHidden();

  // Saved: after a reload it stays away, even inside a tangent, where it
  // would otherwise start at step 2.
  await page.reload();
  const tangents = page.getByRole('tree', { name: 'Tangents' });
  await tangents.getByRole('treeitem', { level: 2 }).first().getByRole('button').first().click();
  await expect(page).toHaveURL(/\/b\//);
  await expect(page.locator('[data-action="next"]')).toBeVisible();
  await expect(coach).toBeHidden();
  expect(errors).toEqual([]);
});

test('Learn demo: Keep going replies on the open thread, a suggested tangent opens one', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openExampleLesson(page);
  await page.getByRole('button', { name: 'Skip tour' }).click();
  const url = page.url();
  const users = page.locator('.msg-user');
  const before = await users.count();

  // Only the newest reply offers Keep going; its suggestion is the next message here.
  const keepGoing = page.getByRole('group', { name: 'Keep going' });
  await expect(keepGoing).toHaveCount(1);
  const step = keepGoing.getByRole('button').first();
  const title = (await step.locator('.tangent-title').innerText()).trim();
  await step.click();
  await expect(users).toHaveCount(before + 1);
  await expect(users.last()).toContainText(title);
  await expect(page.locator('.msg-assistant').last()).not.toHaveClass(/streaming/, {
    timeout: 30_000,
  });
  expect(page.url().split('?')[0]).toBe(url.split('?')[0]);
  await expect(page).not.toHaveURL(/\/b\//);

  // A suggestion under Suggested tangents starts a tangent named after it.
  const side = page.getByRole('button', { name: /^Start a tangent: / }).first();
  const sideTitle = (await side.locator('.tangent-title').innerText()).trim();
  await side.click();
  await expect(page).toHaveURL(/\/b\//);
  await expect(page.locator('.crumb-current')).toContainText(sideTitle);
  expect(errors).toEqual([]);
});
