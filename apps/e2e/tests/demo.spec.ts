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

/** Selects `text` inside `scope` (its first occurrence), as dragging over it would. */
async function selectText(scope: Locator, text: string): Promise<void> {
  await scope.evaluate((root, wanted) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent?.indexOf(wanted) ?? -1;
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + wanted.length);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      return;
    }
    throw new Error(`not found: ${wanted}`);
  }, text);
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

test('power demo: the open branch is deleted from the chat header, back to where it started', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/demo');
  await page.locator('.home-list .tree-row a').first().click();
  await page.locator('.fork-toggle').first().click();
  const fork = page.locator('.fork-list .fork-row').first();
  const title = (await fork.locator('.outline-title').innerText()).trim();
  const outline = page.locator('.outline .outline-title', { hasText: title });
  await expect(outline).toHaveCount(1);
  await fork.locator('.fork-link').click();
  await expect(page).toHaveURL(/\/b\//);
  const branchUrl = page.url();
  const branchId = /\/b\/([^/?]+)/.exec(branchUrl)?.[1] ?? '';

  // The trash beside "Parent message": Cancel stays, OK deletes.
  const del = page.locator('.chat-head').getByRole('button', { name: `Delete ${title}` });
  const asked: string[] = [];
  page.once('dialog', async (d) => {
    asked.push(d.message());
    await d.dismiss();
  });
  await del.click();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toMatch(new RegExp(`^Delete “${title}” \\(\\d+ messages?\\)\\?`));
  expect(asked[0]).toContain('This cannot be undone.');
  expect(page.url()).toBe(branchUrl);

  page.once('dialog', (d) => d.accept());
  await del.click();
  // On the parent, at the message the branch came from; the outline no longer lists it.
  await expect.poll(() => page.url()).not.toContain(branchId);
  await expect(page).toHaveURL(/[?&]m=/);
  await expect(page.locator('.msg-focused')).toBeVisible();
  await expect(outline).toHaveCount(0);
  await expect(page.locator('.toast').filter({ hasText: 'Branch deleted' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Learn demo: a side question is deleted from its chip, or from the header when open', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/learn/demo/');
  await page.locator('.lesson-row a').first().click();
  const chip = page.locator('.side-questions .chip', { hasText: 'Why the owl hums first' });
  await expect(chip).toBeVisible();

  const asked: string[] = [];
  page.once('dialog', async (d) => {
    asked.push(d.message());
    await d.dismiss();
  });
  const del = page.getByRole('button', { name: 'Delete the side question Why the owl hums first' });
  await del.click();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toBe(
    'Delete “Why the owl hums first” (2 messages)? Replies still being written there are stopped. This cannot be undone.',
  );
  await expect(chip).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await del.click();
  await expect(chip).toHaveCount(0);
  await expect(page.locator('.toast').filter({ hasText: 'Side question deleted' })).toBeVisible();

  // The open side question (a followed tangent): from the header, back to the lesson.
  const tangent = page.locator('.tangent.is-followed').first();
  const name = (await tangent.locator('.tangent-title').innerText()).trim();
  await tangent.click();
  await expect(page).toHaveURL(/\/b\//);
  page.once('dialog', (d) => d.accept());
  await page
    .locator('.crumbs')
    .getByRole('button', { name: `Delete the side question ${name}` })
    .click();
  await expect(page).not.toHaveURL(/\/b\//);
  await expect(page).toHaveURL(/[?&]m=/);
  await expect(page.locator('.tangent', { hasText: name })).not.toHaveClass(/is-followed/);
  expect(errors).toEqual([]);
});

test('Learn demo: the lesson text size scales the messages only, and is remembered', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const fontSize = (l: Locator) => l.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  await page.goto('/learn/demo/');
  await page.locator('.lesson-row a').first().click();
  const body = page.locator('.msg-body').first();
  const composer = page.locator('#composer-input');
  const title = page.locator('.lesson-title');
  await expect(body).toBeVisible();
  const [bodyBefore, composerBefore, titleBefore] = [
    await fontSize(body),
    await fontSize(composer),
    await fontSize(title),
  ];

  await page.getByRole('button', { name: 'Text size' }).click();
  await expect(page.getByText('Lesson text size')).toBeVisible();
  const larger = page.getByRole('button', { name: 'Larger text' });
  await larger.click();
  await larger.click();
  await expect(page.locator('.text-size-value')).toHaveText('125%');
  await expect.poll(() => fontSize(body)).toBeCloseTo(bodyBefore * 1.25, 1);
  expect(await fontSize(composer)).toBeCloseTo(composerBefore * 1.25, 1);
  expect(await fontSize(title)).toBe(titleBefore);
  // Escape closes it (Learn has no text-size shortcuts) and hands focus back.
  await page.keyboard.press('Escape');
  await expect(page.locator('.text-size-value')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Text size' })).toBeFocused();

  // Kept across a reload (the demo reseeds itself, under new ids), apart from power's.
  await page.goto('/learn/demo/');
  await page.locator('.lesson-row a').first().click();
  await expect(body).toBeVisible();
  expect(await fontSize(body)).toBeCloseTo(bodyBefore * 1.25, 1);
  expect(await page.evaluate(() => localStorage.getItem('tangent.chatFontScale'))).toBeNull();

  await page.getByRole('button', { name: 'Text size' }).click();
  await page.getByRole('button', { name: 'Reset to 100%' }).click();
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

test('power demo: "Ask about this" on selected text branches at once, ready to type', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/demo');
  await page.locator('.home-list .tree-row a').first().click();
  const reply = page.locator('.msg-assistant').first();
  const body = reply.locator('.msg-body');
  await expect(body).toBeVisible();
  const url = page.url();
  const users = await page.locator('.msg-user').count();
  const bar = page.locator('app-selection-ask');
  await expect(bar).toHaveCount(0);

  // Selecting words in a reply floats the action above the composer.
  await selectText(body, 'a careful hamster in disguise');
  await expect(bar.getByRole('button', { name: 'Ask about this' })).toBeVisible();
  await bar.getByRole('button', { name: 'Ask about this' }).click();
  // A new branch quoting it, opened with the composer focused, nothing sent yet.
  await expect.poll(() => page.url()).not.toBe(url);
  await expect(page.locator('.fork-divider.fork-current')).toContainText(/full path/i);
  await expect(page.locator('.anchor-quote').last()).toHaveText('a careful hamster in disguise');
  const composer = page.locator('#composer-input');
  await expect(composer).toBeFocused();
  await expect(composer).toHaveAttribute('placeholder', 'Ask your question…');
  expect(await page.locator('.msg-user').count()).toBeLessThanOrEqual(users);
  await expect(bar).toHaveCount(0);
  await composer.fill('Why a hamster?');
  await composer.press('Enter');
  await expect(page.locator('.msg-user').last()).toContainText('Why a hamster?');
  await expect(composer).toHaveAttribute('placeholder', 'Continue this thread…');

  // Its gear: "Branch from here" with the quote filled in.
  await page.goto(url);
  await expect(body).toBeVisible();
  await selectText(body, 'patient lemon');
  await bar.getByRole('button', { name: /^More: Branch from here/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Branch from here' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: /^Anchor quote/ })).toHaveValue('patient lemon');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(page.url()).toBe(url);

  // `b` on the focused message with a selection in it still opens the dialog with it.
  await body.click();
  await selectText(body, 'off-key');
  await page.keyboard.press('b');
  await expect(dialog.getByRole('textbox', { name: /^Anchor quote/ })).toHaveValue('off-key');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(errors).toEqual([]);
});

test('power demo: the newest reply’s "Ask your own" is open, without taking focus', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/demo');
  await page.locator('.home-list .tree-row a').first().click();
  const replies = page.locator('.msg-assistant');
  await expect(replies.first()).toBeVisible();
  const newest = page.locator(`#${await replies.last().getAttribute('id')}`);
  const older = page.locator(`#${await replies.first().getAttribute('id')}`);
  const ask = newest.locator('.tangent-ask');
  const field = ask.getByRole('textbox', { name: 'Ask your own question in a new branch' });
  const composer = page.locator('#composer-input');

  // Open from the start (three lines), marked as the newest, and nothing focused.
  await expect(ask).toHaveClass(/is-expanded/);
  await expect(ask).toHaveClass(/is-latest/);
  await expect(field).toHaveAttribute('rows', '3');
  // (The composer keeps the focus it takes on opening.)
  await expect(field).not.toBeFocused();
  await expect(composer).toHaveAttribute('placeholder', 'Continue this thread…');
  // Older replies keep theirs folded.
  await expect(older.locator('.tangent-ask')).not.toHaveClass(/is-expanded/);
  await expect(older.locator('.tangent-ask')).not.toHaveClass(/is-latest/);

  // Leaving it empty keeps it open; Shift+Enter is a new line, not a question.
  await field.click();
  await composer.click();
  await expect(ask).toHaveClass(/is-expanded/);
  await field.click();
  await field.pressSequentially('Line one');
  await field.press('Shift+Enter');
  await field.pressSequentially('line two');
  await expect(field).toHaveValue('Line one\nline two');
  expect(page.url()).not.toMatch(/\/b\//);
  await field.fill('');

  // Folded by hand (its button, or Escape), it stays folded until the user moves on.
  await ask.getByRole('button', { name: 'Fold' }).click();
  await expect(ask).not.toHaveClass(/is-expanded/);
  await expect(field).toBeFocused();
  await composer.click();
  await expect(ask).not.toHaveClass(/is-expanded/);
  await older.locator('.msg-body').click();
  await expect(page).toHaveURL(/[?&]m=/);
  await expect(ask).not.toHaveClass(/is-expanded/);

  // Into a branch and back: the newest reply's item is open again.
  const here = page.url();
  await page.locator('.fork-toggle').first().click();
  await page.locator('.fork-list .fork-link').first().click();
  await expect.poll(() => page.url()).not.toBe(here);
  await page.goBack();
  await expect.poll(() => page.url()).toBe(here);
  await expect(ask).toHaveClass(/is-expanded/);

  // An older reply's item: blurred empty, it folds; blurred with text, it stays open with it.
  const olderAsk = older.locator('.tangent-ask');
  const olderField = olderAsk.getByRole('textbox');
  await olderField.click();
  await expect(olderAsk).toHaveClass(/is-expanded/);
  await composer.click();
  await expect(olderAsk).not.toHaveClass(/is-expanded/);
  await olderField.click();
  await olderField.fill('Keep me');
  await composer.click();
  await expect(olderAsk).toHaveClass(/is-expanded/);
  await expect(olderField).toHaveValue('Keep me');
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

test('Learn demo: "Ask about this", the newest reply stands out, and the box continues the lesson', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/learn/demo/');
  await page.locator('.lesson-row a').first().click();
  const replies = page.locator('.msg-assistant');
  await expect(replies.first()).toBeVisible();
  const composer = page.locator('#composer-input');
  await expect(composer).toHaveAttribute('placeholder', 'Continue this lesson…');
  // The newest reply's "Ask your own" stands out (a one-line field: nothing grows).
  await expect(replies.last().locator('.tangent-ask')).toHaveClass(/is-latest/);
  await expect(replies.first().locator('.tangent-ask')).not.toHaveClass(/is-latest/);

  const url = page.url();
  await selectText(replies.first().locator('.msg-body'), 'a careful hamster in disguise');
  await page.getByRole('button', { name: 'Ask about this' }).click();
  await expect.poll(() => page.url()).not.toBe(url);
  await expect(page.locator('.anchor-quote').last()).toHaveText('a careful hamster in disguise');
  await expect(composer).toBeFocused();
  await expect(composer).toHaveAttribute('placeholder', 'Ask your side question…');
  await composer.fill('Why a hamster?');
  await composer.press('Enter');
  await expect(page.locator('.msg-user').last()).toContainText('Why a hamster?');
  await expect(composer).toHaveAttribute('placeholder', 'Continue this side question…');
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

test('Canvas demo: a lane is deleted from its head, with the lanes below it', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/canvas/demo/');
  await page.getByText('How do kittens learn to whistle?').first().click();
  const lanes = page.locator('.lane');
  await expect(lanes).toHaveCount(3);
  const lane = page.locator('.lane', {
    has: page.locator('.lane-title', { hasText: 'Why the owl hums first' }),
  });
  // Select it, so deleting it moves the selection back to the fork.
  await lane.locator('.lane-title').click();
  await expect(page).toHaveURL(/\/b\//);
  const laneId = (await lane.getAttribute('data-branch-id')) ?? '';
  expect(page.url()).toContain(laneId);
  const del = lane.getByRole('button', { name: 'Delete the lane Why the owl hums first' });

  const asked: string[] = [];
  page.once('dialog', async (d) => {
    asked.push(d.message());
    await d.dismiss();
  });
  await del.click();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toMatch(/^Delete “Why the owl hums first” \(2 messages\)\? /);
  expect(asked[0]).toContain('This cannot be undone.');
  await expect(lanes).toHaveCount(3);

  page.once('dialog', (d) => d.accept());
  await del.click();
  await expect(lanes).toHaveCount(2);
  await expect.poll(() => page.url()).not.toContain(laneId);
  await expect(page).toHaveURL(/[?&]m=/);
  // The main thread has no delete of its own (the conversation's is in the bar).
  await expect(lanes.first().getByRole('button', { name: /^Delete the lane/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Canvas demo: the card text size re-lays the lanes out, and is remembered', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const fontSize = (l: Locator) => l.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const open = async () => {
    await page.goto('/canvas/demo/');
    await page.getByText('How do kittens learn to whistle?').first().click();
    await expect(page.locator('.lane')).toHaveCount(3);
  };
  await open();
  const card = page.locator('.card-body').first();
  const composer = page.locator('.lane .composer textarea').first();
  const title = page.locator('.canvas-title');
  const lanes = page.locator('.lane');
  // The two lanes forking from the first reply sit one above the other.
  const gap = async () => {
    const [a, b] = [await lanes.nth(1).boundingBox(), await lanes.nth(2).boundingBox()];
    const [top, bottom] = (a?.y ?? 0) < (b?.y ?? 0) ? [a, b] : [b, a];
    return (bottom?.y ?? 0) - ((top?.y ?? 0) + (top?.height ?? 0));
  };
  const heightOf = async (l: Locator) => (await l.boundingBox())?.height ?? 0;
  // (Once the first layout has settled: lanes slide into place.)
  await expect.poll(gap).toBeGreaterThan(0);
  const [cardBefore, composerBefore, titleBefore, trunkBefore] = [
    await fontSize(card),
    await fontSize(composer),
    await fontSize(title),
    await heightOf(lanes.first()),
  ];

  await page.getByRole('button', { name: 'Text size' }).click();
  await expect(page.getByText('Card text size')).toBeVisible();
  const larger = page.getByRole('button', { name: 'Larger text' });
  await larger.click();
  await larger.click();
  await larger.click();
  await expect(page.locator('.text-size-value')).toHaveText('140%');
  await expect.poll(() => fontSize(card)).toBeCloseTo(cardBefore * 1.4, 1);
  expect(await fontSize(composer)).toBeCloseTo(composerBefore * 1.4, 1);
  expect(await fontSize(title)).toBe(titleBefore);
  // Taller cards: the lanes are measured again and laid out without overlapping.
  await expect.poll(() => heightOf(lanes.first())).toBeGreaterThan(trunkBefore * 1.15);
  await expect.poll(gap).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.text-size-value')).toBeHidden();

  // Kept across a reload, under its own key; the canvas's +/-/0 still zoom.
  await open();
  await expect(card).toBeVisible();
  expect(await fontSize(card)).toBeCloseTo(cardBefore * 1.4, 1);
  expect(await page.evaluate(() => localStorage.getItem('tangent.canvas.chatFontScale'))).toBe(
    '1.4',
  );
  const zoom = page.locator('.zoom-value');
  const zoomBefore = await zoom.innerText();
  await page.locator('.canvas-title').click();
  await page.keyboard.press('-');
  await expect(zoom).not.toHaveText(zoomBefore);
  expect(await fontSize(card)).toBeCloseTo(cardBefore * 1.4, 1);
  expect(errors).toEqual([]);
});

test('Canvas demo: "Ask about this" opens a lane to type in; only the selected lane’s ask is open', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/canvas/demo/');
  await page.getByText('How do kittens learn to whistle?').first().click();
  const lanes = page.locator('.lane');
  await expect(lanes).toHaveCount(3);
  const trunk = lanes.first();
  await expect(trunk).toHaveClass(/is-selected/);
  // The selected lane's last card has its "Ask your own" open; no other card does.
  const lastCard = trunk.locator('.card-assistant').last();
  await expect(lastCard.locator('.tangent-ask')).toHaveClass(/is-expanded/);
  await expect(page.locator('.tangent-ask.is-expanded')).toHaveCount(1);
  await expect(page.locator('.lane .composer textarea:focus')).toHaveCount(0);
  await expect(trunk.locator('.composer textarea')).toHaveAttribute(
    'placeholder',
    'Continue this lane…',
  );

  // Select words in the first reply: "Ask about this" opens a path lane quoting them, its box focused.
  await selectText(trunk.locator('.card-assistant .card-body').first(), 'a careful hamster');
  const bar = page.locator('app-selection-ask');
  await expect(bar.getByRole('button', { name: /^More: Branch from here/ })).toBeVisible();
  await bar.getByRole('button', { name: 'Ask about this' }).click();
  await expect(lanes).toHaveCount(4);
  const lane = page.locator('.lane.is-selected');
  await expect(lane.locator('.anchor')).toHaveText('a careful hamster');
  await expect(lane.locator('.composer textarea')).toBeFocused();
  await expect(lane.locator('.composer textarea')).toHaveAttribute('placeholder', 'Ask here…');
  // The trunk is no longer selected: its open ask folds.
  await expect(page.locator('.tangent-ask.is-expanded')).toHaveCount(0);

  // The gear: the branch dialog with the quote filled in.
  await selectText(trunk.locator('.card-assistant .card-body').first(), 'patient lemon');
  await bar.getByRole('button', { name: /^More: Branch from here/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Branch from here' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: /^Anchor quote/ })).toHaveValue('patient lemon');
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
