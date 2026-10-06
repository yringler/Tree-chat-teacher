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
