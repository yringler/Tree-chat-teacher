import fs from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

/*
 * The in-browser demos (/demo, /learn/demo): no sign-in, no backend state, no
 * model. Each test gets a fresh browser context, so a fresh demo session.
 */

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

test('power demo: deleting from the conversation list asks first, and Cancel keeps it', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/demo');
  const rows = page.locator('.home-list .tree-row');
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();
  const title = (await rows.first().locator('strong').innerText()).trim();
  const del = page.getByRole('button', { name: `Delete ${title}` }).first();

  // Cancel: nothing changes.
  const asked: string[] = [];
  page.once('dialog', async (d) => {
    asked.push(d.message());
    await d.dismiss();
  });
  await del.click();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toContain(`Delete “${title}”`);
  await expect(rows).toHaveCount(before);

  // Confirm: the row goes, and the page stays on the list.
  page.once('dialog', (d) => d.accept());
  await del.click();
  await expect(rows).toHaveCount(before - 1);
  await expect(page).toHaveURL(/\/demo\/?$/);
  expect(errors).toEqual([]);
});

test('power demo: a branch is deleted from under its message, without the outline', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/demo');
  await page.locator('.home-list .tree-row a').first().click();
  const toggle = page.locator('.fork-toggle').first();
  await expect(toggle).toHaveText(/2 branches/);
  await toggle.click();
  const forks = page.locator('.fork-list .fork-row');
  await expect(forks).toHaveCount(2);
  const title = (await forks.first().locator('.outline-title').innerText()).trim();
  const del = page.locator('.fork-list').getByRole('button', { name: `Delete ${title}` });

  // Cancel: nothing changes.
  const asked: string[] = [];
  page.once('dialog', async (d) => {
    asked.push(d.message());
    await d.dismiss();
  });
  await del.click();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toContain(`Delete “${title}”`);
  await expect(forks).toHaveCount(2);

  // Confirm: the branch leaves the list, and the open branch stays where it was.
  const url = page.url();
  page.once('dialog', (d) => d.accept());
  await del.click();
  await expect(forks).toHaveCount(1);
  await expect(toggle).toHaveText(/1 branch\b/);
  expect(page.url()).toBe(url);
  expect(errors).toEqual([]);
});

test('power demo: the conversation text size scales the messages only, and is remembered', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const fontSize = (l: Locator) => l.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  await page.goto('/demo');
  await page.locator('.home-list .tree-row a').first().click();
  const body = page.locator('.msg-body').first();
  const composer = page.locator('#composer-input');
  const title = page.locator('.tree-name');
  await expect(body).toBeVisible();
  const [bodyBefore, composerBefore, titleBefore] = [
    await fontSize(body),
    await fontSize(composer),
    await fontSize(title),
  ];

  // "Aa" in the header: A+ twice is 125%. Messages and composer grow; the header doesn't.
  await page.getByRole('button', { name: 'Text size' }).click();
  const larger = page.getByRole('button', { name: 'Larger text' });
  await larger.click();
  await larger.click();
  const value = page.locator('.text-size-value');
  await expect(value).toHaveText('125%');
  await expect.poll(() => fontSize(body)).toBeCloseTo(bodyBefore * 1.25, 1);
  expect(await fontSize(composer)).toBeCloseTo(composerBefore * 1.25, 1);
  expect(await fontSize(title)).toBe(titleBefore);
  await page.keyboard.press('Escape');
  await expect(value).toBeHidden();
  await expect(page.getByRole('button', { name: 'Text size' })).toBeFocused();

  // Kept across a reload (the demo reseeds itself, under new ids).
  await page.goto('/demo');
  await page.locator('.home-list .tree-row a').first().click();
  await expect(body).toBeVisible();
  expect(await fontSize(body)).toBeCloseTo(bodyBefore * 1.25, 1);

  // Shortcuts outside a field: - steps down, 0 resets (Esc first leaves the composer).
  await page.keyboard.press('Escape');
  await page.keyboard.press('-');
  await expect.poll(() => fontSize(body)).toBeCloseTo(bodyBefore * 1.12, 1);
  await page.keyboard.press('0');
  await expect.poll(() => fontSize(body)).toBeCloseTo(bodyBefore, 1);
  expect(errors).toEqual([]);
});

test('power demo: ask your own question under a reply, inline or through the branch dialog', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/demo');
  await page.locator('.home-list .tree-row a').first().click();
  // The main thread's last reply (pinned by id: new branches add replies of their own).
  const last = page.locator('.msg-assistant').last();
  await expect(last).toBeVisible();
  const reply = page.locator(`#${await last.getAttribute('id')}`);
  const ask = reply.locator('.tangent-ask');
  const noTitle = (dialog: Locator) =>
    expect(dialog.getByRole('textbox', { name: /title/i })).toHaveCount(0);
  const field = ask.getByRole('textbox', { name: 'Ask your own question in a new branch' });
  // The last item of "Where next?", after the suggested tangents.
  await expect(reply.locator('.tangents > :last-child .tangent-ask')).toBeVisible();
  await expect(field).toHaveAttribute('placeholder', 'Ask your own question…');

  // One click grows it; Escape folds it, typing in it is not a shortcut.
  await field.click();
  await expect(ask).toHaveClass(/is-expanded/);
  await page.keyboard.press('Escape');
  await expect(ask).not.toHaveClass(/is-expanded/);
  await field.click();
  await page.keyboard.type('b');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await field.fill('');

  // Enter asks it in a new branch, opened at once.
  const url = page.url();
  await field.fill('Do owls ever whistle back?');
  await field.press('Enter');
  await expect.poll(() => page.url()).not.toBe(url);
  await expect(page.locator('.msg-user').last()).toContainText('Do owls ever whistle back?');
  await expect(page.locator('.fork-divider.fork-current')).toBeVisible();
  // The field it came from is empty again.
  await expect(field).toHaveValue('');
  await expect(ask).not.toHaveClass(/is-expanded/);
  await page.goBack();
  await expect.poll(() => page.url()).toBe(url);

  // The gear: the branch dialog without a starting message (or a title), carrying the question.
  await field.click();
  await field.fill('What do lemons applaud?');
  await ask.getByRole('button', { name: /^Branch settings/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Branch from here' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Starting message')).toHaveCount(0);
  await noTitle(dialog);
  await expect(dialog.locator('.excerpt').last()).toContainText('What do lemons applaud?');
  // Cancelled, the question stays where it was typed.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(field).toHaveValue('What do lemons applaud?');
  await ask.getByRole('button', { name: /^Branch settings/ }).click();
  await dialog.getByRole('radio', { name: /Independent/ }).check();
  await dialog.getByRole('button', { name: 'Create and ask' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.msg-user').last()).toContainText('What do lemons applaud?');
  await expect(page.locator('.fork-divider.fork-current')).toContainText(/independent/i);
  await page.goBack();
  await expect.poll(() => page.url()).toBe(url);
  await expect(field).toHaveValue('');

  // "Branch from here": a starting message instead of a title; Ctrl+Enter creates and asks.
  await reply.getByRole('button', { name: 'Branch from here' }).click();
  await expect(dialog).toBeVisible();
  await noTitle(dialog);
  const starting = dialog.getByRole('textbox', { name: /Starting message/ });
  await expect(starting).toBeFocused();
  await starting.fill('Can a melon hum?');
  await starting.press('Control+Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.msg-user').last()).toContainText('Can a melon hum?');
  expect(errors).toEqual([]);
});

test('Learn demo: ask your own side question under a reply', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/learn/demo/');
  await page.locator('.lesson-row a').first().click();
  const ask = page.locator('.msg-assistant').last().locator('.tangent-ask');
  const field = ask.getByRole('textbox', { name: 'Ask your own question as a side question' });
  await expect(field).toHaveAttribute('placeholder', 'Ask your own question…');
  const url = page.url();
  await field.fill('Do owls ever whistle back?');
  await field.press('Enter');
  await expect.poll(() => page.url()).not.toBe(url);
  await expect(page).toHaveURL(/\/b\//);
  await expect(page.locator('.msg-user').last()).toContainText('Do owls ever whistle back?');
  expect(errors).toEqual([]);
});

test('Canvas demo: ask your own question in a new lane, inline or through the branch dialog', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/canvas/demo/');
  await page.getByText('How do kittens learn to whistle?').first().click();
  const lanes = page.locator('.lane');
  await expect(lanes.first()).toBeVisible();
  const before = await lanes.count();
  // The main thread's last reply (pinned by id: new lanes add replies of their own).
  const last = lanes.first().locator('.card-assistant').last();
  await expect(last).toBeVisible();
  const card = page.locator(`#${await last.getAttribute('id')}`);
  const ask = card.locator('.tangent-ask');
  const field = ask.getByRole('textbox', { name: 'Ask your own question in a new lane' });

  await field.click();
  await field.fill('Why do lemons applaud?');
  await field.press('Enter');
  await expect(lanes).toHaveCount(before + 1);
  await expect(page.locator('.card-user', { hasText: 'Why do lemons applaud?' })).toBeVisible();
  await expect(field).toHaveValue('');
  // Back on the main thread (the canvas pans to the new lane).
  await page.goBack();

  // The gear: the lanes dialog without a starting message (or a title), asking the question.
  await field.click();
  await field.fill('And owls?');
  await ask.getByRole('button', { name: /^Lane settings/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Branch from here' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Starting message')).toHaveCount(0);
  await expect(dialog.getByRole('textbox', { name: /title/i })).toHaveCount(0);
  await expect(dialog.locator('.excerpt').last()).toContainText('And owls?');
  await dialog.getByRole('button', { name: 'Open the lane and ask' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(lanes).toHaveCount(before + 2);
  await expect(page.locator('.card-user', { hasText: 'And owls?' })).toBeVisible();
  await expect(field).toHaveValue('');

  // From the branch button: a starting message, still no title.
  await page.goBack();
  await card.locator('.card-branch').click();
  await expect(dialog.getByRole('textbox', { name: /Starting message/ })).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: /title/i })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(errors).toEqual([]);
});

test('Learn demo: export a lesson, import a power-style backup, get a Learn lesson', async ({
  page,
}, testInfo) => {
  const errors = collectErrors(page);
  await page.goto('/learn/demo/');
  await expect(page.getByRole('heading', { name: 'Your lessons' })).toBeVisible();
  const lessons = page.locator('.lesson-row');
  const before = await lessons.count();
  expect(before).toBeGreaterThan(0);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page
      .getByRole('button', { name: /^Export / })
      .first()
      .click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.tangent\.json$/);
  const exported = testInfo.outputPath('exported.json');
  await download.saveAs(exported);
  const backup = JSON.parse(fs.readFileSync(exported, 'utf8'));
  expect(backup.format).toBe('tangent-tree-backup');
  expect(backup.branches.length).toBeGreaterThan(1);

  // What the power app exports: another provider and model, a custom prompt, other context modes.
  backup.tree.title = 'From power';
  backup.tree.systemPrompt = 'Talk like a pirate.';
  backup.branches[0].providerId = 'anthropic';
  backup.branches[0].model = 'claude-opus-5-5';
  backup.branches[1].contextMode = 'summary';
  backup.branches[1].providerId = 'openrouter';
  backup.branches[1].model = 'some/other-model';
  backup.branches[1].funding = 'credit';
  const powerFile = testInfo.outputPath('from-power.tangent.json');
  fs.writeFileSync(powerFile, JSON.stringify(backup));

  await page.locator('input[type=file]').setInputFiles(powerFile);
  await expect(page).toHaveURL(/\/learn\/demo\/t\//);
  await expect(page.locator('.toast').first()).toBeVisible();

  // The imported lesson, exported again: adapted to Learn.
  await page.goto('/learn/demo/');
  await expect(lessons).toHaveCount(before + 1);
  const [again] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export From power' }).click(),
  ]);
  const reexported = testInfo.outputPath('reexported.json');
  await again.saveAs(reexported);
  const lesson = JSON.parse(fs.readFileSync(reexported, 'utf8'));
  expect(lesson.tree.title).toBe('From power');
  expect(lesson.tree.systemPrompt).not.toBe('Talk like a pirate.');
  for (const b of lesson.branches) {
    expect(b.providerId).toBe('openrouter');
    expect(['smart', 'simple']).toContain(b.model);
    expect(b.contextMode).toBe('path');
    expect(b.funding).toBe('own-key');
  }
  expect(lesson.branches[0].model).toBe('smart');
  expect(lesson.nodes.map((n: { content: string }) => n.content)).toEqual(
    backup.nodes.map((n: { content: string }) => n.content),
  );

  // A file that isn't a backup is refused with a message, and nothing is added.
  const notes = testInfo.outputPath('notes.md');
  fs.writeFileSync(notes, '# Notes');
  await page.locator('input[type=file]').setInputFiles(notes);
  await expect(page.locator('.toast-error')).toBeVisible();
  await expect(lessons).toHaveCount(before + 1);
  expect(errors).toEqual([]);
});
