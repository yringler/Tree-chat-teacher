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

/**
 * Skips Learn's first-run walkthrough (tangent-guidance.spec.ts walks it), so
 * its coach marks cover nothing. A fresh demo session starts it on the first
 * lesson opened; skipped, it stays away for the session.
 */
async function skipTour(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Skip tour' }).click();
  await expect(page.locator('.coach-mark')).toBeHidden();
}

test('power demo: a dialog opened over another is on top, and Escape closes that one', async ({
  page,
}) => {
  await page.goto('/demo');
  await page.getByRole('button', { name: 'Settings' }).first().click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  // `?` outside a field opens the shortcuts over it.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toBeVisible();
  // Last in the page, so drawn on top of the settings.
  await expect(page.getByRole('dialog').last()).toHaveAccessibleName('Keyboard shortcuts');
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);
  await expect(settings).toBeVisible();
});

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

test('power demo: a tangent is deleted from under its message, without the outline', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/demo');
  await page.locator('.home-list .tree-row a').first().click();
  const yours = page.getByRole('group', { name: 'Your tangents' }).first();
  const forks = yours.getByRole('button', { name: /^Open tangent: / });
  await expect(forks).toHaveCount(2);
  const title = (await forks.first().locator('.tangent-title').innerText()).trim();
  const del = yours.getByRole('button', { name: `Delete the tangent ${title}` });

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

  // Confirm: the tangent leaves the list, and the open branch stays where it was.
  const url = page.url();
  page.once('dialog', (d) => d.accept());
  await del.click();
  await expect(forks).toHaveCount(1);
  await expect(yours).not.toContainText(title);
  expect(page.url()).toBe(url);
  expect(errors).toEqual([]);
});

test('power demo: on a phone, a reply keeps its Tangent ↳ label among the icon-only actions', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/demo');
  await page.locator('.home-list .tree-row a').first().click();
  const reply = page.locator('.msg-assistant').last();
  await reply.click();
  const tangent = reply.getByRole('button', { name: 'Tangent ↳' });
  await expect(tangent).toBeVisible();
  // Its arrow is in the label, so without the label nothing would show.
  expect((await tangent.boundingBox())!.width).toBeGreaterThan(50);
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

test('power demo: the open tangent is deleted from the chat header, back to where it started', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/demo');
  await page.locator('.home-list .tree-row a').first().click();
  const fork = page.getByRole('button', { name: /^Open tangent: / }).first();
  const title = (await fork.locator('.tangent-title').innerText()).trim();
  const outline = page.locator('.outline .outline-title', { hasText: title });
  await expect(outline).toHaveCount(1);
  await fork.click();
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
  // On the parent, at the message the tangent came from; the outline no longer lists it.
  await expect.poll(() => page.url()).not.toContain(branchId);
  await expect(page).toHaveURL(/[?&]m=/);
  await expect(page.locator('.msg-focused')).toBeVisible();
  await expect(outline).toHaveCount(0);
  await expect(page.locator('.toast').filter({ hasText: 'Tangent deleted' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Learn demo: a tangent is deleted from under its message, or from the sidebar when open', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/learn/demo/');
  await page.locator('.lesson-row a').first().click();
  await skipTour(page);
  const chip = page.getByRole('button', { name: 'Open tangent: Why the owl hums first' });
  await expect(chip).toBeVisible();

  const asked: string[] = [];
  page.once('dialog', async (d) => {
    asked.push(d.message());
    await d.dismiss();
  });
  const del = page.getByRole('button', { name: 'Delete the tangent Why the owl hums first' });
  await del.click();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toBe(
    'Delete “Why the owl hums first” (2 messages)? Replies still being written there are stopped. This cannot be undone.',
  );
  await expect(chip).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await del.click();
  await expect(chip).toHaveCount(0);
  await expect(page.locator('.toast').filter({ hasText: 'Tangent deleted' })).toBeVisible();

  // The open tangent (a followed suggestion): from the sidebar, back to the lesson.
  const tangent = page.getByRole('button', { name: /^Open tangent: / }).first();
  const name = (await tangent.locator('.tangent-title').innerText()).trim();
  await tangent.click();
  await expect(page).toHaveURL(/\/b\//);
  page.once('dialog', (d) => d.accept());
  await page
    .getByRole('tree', { name: 'Tangents' })
    .getByRole('button', { name: `Delete ${name}`, exact: true })
    .click();
  await expect(page).not.toHaveURL(/\/b\//);
  await expect(page).toHaveURL(/[?&]m=/);
  // With no tangent left under it, the reply offers that suggestion again, unfolded.
  await expect(page.getByRole('group', { name: 'Your tangents' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Start a tangent: ${name}` })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Learn demo: tangents open where they start; the path, sidebar and keys find the way back', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/learn/demo/');
  await page.locator('.lesson-row a').first().click();
  await skipTour(page);
  await expect(page.locator('.msg').first()).toBeVisible();

  // A tangent opens at its first message.
  await page.getByRole('button', { name: 'Open tangent: Why the owl hums first' }).click();
  await expect(page).toHaveURL(/\/b\/[^?]+\?m=/);
  await expect(page.locator('.msg-focused:not(.msg-ancestor)')).toBeVisible();

  // The path goes back to the message it started from.
  await page.locator('.crumbs').getByRole('button', { name: 'Main thread', exact: true }).click();
  await expect(page).not.toHaveURL(/\/b\//);
  await expect(page).toHaveURL(/[?&]m=/);
  const startedFrom = page.locator('.msg-focused');
  await expect(startedFrom).toBeVisible();

  // j and k move the mark; Alt+arrows move between tangents.
  const marked = () => page.locator('.msg-focused').getAttribute('id');
  const before = await marked();
  await page.keyboard.press('j');
  await expect.poll(marked).not.toBe(before);
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page).toHaveURL(/\/b\//);
  const first = page.url();
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => page.url()).not.toBe(first);
  await expect(page).toHaveURL(/\/b\//);
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page).not.toHaveURL(/\/b\//);

  // The sidebar lists every tangent under the open lesson.
  const outline = page.getByRole('tree', { name: 'Tangents' });
  await outline.getByRole('button', { name: /^Why the owl hums first/ }).click();
  await expect(page).toHaveURL(/\/b\//);
  await expect(page.locator('.msg-focused:not(.msg-ancestor)')).toBeVisible();

  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();

  // On a phone the path is still there, and the sidebar is a drawer.
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.locator('.crumbs ol')).toBeVisible();
  await expect(
    page.locator('.crumbs').getByRole('button', { name: 'Main thread', exact: true }),
  ).toBeVisible();
  await expect(outline).not.toBeInViewport();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(outline).toBeInViewport();
  await outline.getByRole('button', { name: /^Main thread/ }).click();
  await expect(page).not.toHaveURL(/\/b\//);
  await expect(outline).not.toBeInViewport();
  expect(errors).toEqual([]);
});

/** `el` lies wholly inside the thread's scrolled view (the page's viewport also holds the header and composer). */
function inThreadView(el: Locator): Promise<boolean> {
  return el.evaluate((node) => {
    const view = node.closest('.messages')?.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    return !!view && r.top >= view.top && r.bottom <= view.bottom;
  });
}

test('Learn demo: each tangent started from a reply shows its question, not only the first', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/learn/demo/');
  await page.locator('.lesson-row a').first().click();
  await skipTour(page);
  const reply = page.locator('.msg-assistant').last();
  await expect(reply).toBeVisible();
  for (const round of [1, 2]) {
    // After the first, the rest of the suggestions are folded under the tangent taken.
    const more = reply.getByRole('button', { name: /more suggested/ });
    if (round > 1) await more.click();
    const suggestion = reply.getByRole('button', { name: /^Start a tangent: / }).first();
    await suggestion.click();
    await expect(page).toHaveURL(/\/b\//);
    const question = page.locator('.msg-user:not(.msg-ancestor)').first();
    await expect.poll(() => inThreadView(question)).toBe(true);
    await page.goBack();
    await expect(page).not.toHaveURL(/\/b\//);
  }
  expect(errors).toEqual([]);
});

test('Learn demo: "Ask about this" on an earlier reply takes the tap, not the jump to the end', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/learn/demo/');
  await page.locator('.lesson-row a').first().click();
  await skipTour(page);
  // Read back up to the first reply, far from the end.
  const first = page.locator('.msg-assistant').first();
  await first.scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Jump to the end' })).toBeVisible();
  await selectText(first, 'By copying owls');
  await page.getByRole('button', { name: 'Ask about this' }).click();
  await expect(page.getByRole('textbox').last()).toHaveAttribute('placeholder', 'Ask about this…');
  expect(errors).toEqual([]);
});

test('Learn demo: the lesson text size scales the messages only, and is remembered', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const fontSize = (l: Locator) => l.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  await page.goto('/learn/demo/');
  await page.locator('.lesson-row a').first().click();
  await skipTour(page);
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

test('Learn demo: on a phone the lesson title stays whole and every header control is on screen', async ({
  page,
}) => {
  const errors = collectErrors(page);
  for (const width of [360, 400]) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto('/learn/demo/');
    await page.locator('.lesson-row a').first().click();
    // Skipped once, the tour stays away in this demo session.
    if (width === 360) await skipTour(page);
    const title = page.locator('.lesson-title');
    await expect(title).toHaveText('How do kittens learn to whistle?');
    // Not cut short: the title has a row of its own, the tools the next one.
    expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await title.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
    const titleBox = (await title.boundingBox())!;
    const tools = (await page.locator('.lesson-tools').boundingBox())!;
    expect(tools.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height - 1);
    // Nothing off the side of the page: the account menu and Aa are reachable.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    for (const name of ['Account', 'Text size', 'Export this lesson', 'Delete this lesson']) {
      const box = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
      expect(box.x + box.width, name).toBeLessThanOrEqual(width);
    }
    await page.getByRole('button', { name: 'Text size' }).click();
    await expect(page.getByText('Lesson text size')).toBeVisible();
    await page.keyboard.press('Escape');
  }
  expect(errors).toEqual([]);
});

test('power demo: the message box goes on a tangent or goes on; Tangent ↳’s caret sets a tangent up first', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/demo');
  await page.locator('.home-list .tree-row a').first().click();
  // The main thread's last reply (pinned by id: new tangents add replies of their own).
  const last = page.locator('.msg-assistant').last();
  await expect(last).toBeVisible();
  const reply = page.locator(`#${await last.getAttribute('id')}`);
  // A question of your own goes in the message box: no field of its own under a reply.
  await expect(page.locator('.tangent-ask')).toHaveCount(0);
  const composer = page.locator('#composer-input');
  const dock = page.locator('.composer-dock');
  const tangent = dock.getByRole('button', { name: 'Tangent', exact: true });
  const next = dock.getByRole('button', { name: 'Next', exact: true });
  await expect(composer).toHaveAttribute('placeholder', 'Ask anything…');
  await expect(tangent).toHaveClass(/btn-primary/);
  await expect(next).not.toHaveClass(/btn-primary/);

  // Enter on the main thread goes on a tangent from its last reply, opened at once.
  const url = page.url();
  await composer.fill('Do owls ever whistle back?');
  await composer.press('Enter');
  await expect.poll(() => page.url()).not.toBe(url);
  await expect(page.locator('.msg-user').last()).toContainText('Do owls ever whistle back?');
  await expect(page.locator('.fork-divider.fork-current')).toBeVisible();
  await expect(composer).toHaveValue('');
  // Inside it Next ➜ is filled: Enter goes on in the tangent.
  await expect(composer).toHaveAttribute('placeholder', 'Ask anything in this tangent…');
  await expect(next).toHaveClass(/btn-primary/);
  const inTangent = page.url();
  await composer.fill('And then?');
  await composer.press('Enter');
  await expect(page.locator('.msg-user').last()).toContainText('And then?');
  await expect(page).toHaveURL(inTangent);
  await page.goBack();
  await expect.poll(() => page.url()).toBe(url);

  // The caret: "Tangent from here" (no title), from the same reply, starting with what was typed.
  const dialog = page.getByRole('dialog', { name: 'Tangent from here' });
  const starting = dialog.getByRole('textbox', { name: /Starting message/ });
  await composer.fill('What do lemons applaud?');
  await dock.getByRole('button', { name: 'Tangent with options…' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: /title/i })).toHaveCount(0);
  await expect(starting).toHaveValue('What do lemons applaud?');
  // Cancelled, the question stays where it was typed.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(composer).toHaveValue('What do lemons applaud?');
  // Ctrl+Shift+Enter in the box opens it too; Ctrl+Enter in any of its fields creates and asks.
  await composer.press('Control+Shift+Enter');
  await dialog.getByRole('radio', { name: /Independent/ }).check();
  await page.keyboard.press('Control+Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.msg-user').last()).toContainText('What do lemons applaud?');
  await expect(page.locator('.fork-divider.fork-current')).toContainText(/independent/i);
  // The message box let the question go once it was asked.
  await expect(composer).toHaveValue('');
  await page.goBack();
  await expect.poll(() => page.url()).toBe(url);

  // Shift+B on the reply: an empty starting message; Ctrl+Enter creates and asks.
  await reply.locator('.msg-body').click();
  await page.keyboard.press('Shift+B');
  await expect(dialog).toBeVisible();
  await expect(starting).toBeFocused();
  await expect(starting).toHaveValue('');
  await starting.fill('Can a melon hum?');
  await starting.press('Control+Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.msg-user').last()).toContainText('Can a melon hum?');
  expect(errors).toEqual([]);
});

test('power demo: "Ask about this" puts the words on the composer; the tangent starts when asked', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/demo');
  await page.locator('.home-list .tree-row a').first().click();
  const reply = page.locator('.msg-assistant').first();
  const body = reply.locator('.msg-body');
  await expect(body).toBeVisible();
  const url = page.url();
  const bar = page.locator('app-selection-ask');
  await expect(bar).toHaveCount(0);

  // Selecting words in a reply floats the action above the composer (its options are the composer's).
  await selectText(body, 'a careful hamster in disguise');
  await expect(bar.getByRole('button', { name: 'Ask about this' })).toBeVisible();
  await expect(bar.getByRole('button')).toHaveCount(1);
  await bar.getByRole('button', { name: 'Ask about this' }).click();
  // The words go on the composer, focused; nothing is made yet.
  const composer = page.locator('#composer-input');
  const quote = page.locator('.composer-quote');
  await expect(composer).toBeFocused();
  await expect(composer).toHaveAttribute('placeholder', 'Ask about this…');
  await expect(quote).toContainText('a careful hamster in disguise');
  await expect(bar).toHaveCount(0);
  expect(page.url()).toBe(url);

  // Dropped, they leave nothing behind.
  await quote.getByRole('button', { name: /^Don’t ask about/ }).click();
  await expect(quote).toHaveCount(0);
  await expect(composer).toHaveAttribute('placeholder', 'Ask anything…');
  expect(page.url()).toBe(url);

  // A message's own Tangent ↳ puts the whole message there the same way.
  await reply.getByRole('button', { name: 'Tangent ↳' }).click();
  await expect(quote).toContainText('Tangent from “');
  await expect(composer).toBeFocused();
  await expect(composer).toHaveAttribute('placeholder', 'Ask about this…');
  await quote.getByRole('button', { name: 'Don’t go on this tangent' }).click();
  await expect(quote).toHaveCount(0);
  expect(page.url()).toBe(url);

  // Asked, the tangent starts with the question, quoting the words.
  await selectText(body, 'a careful hamster in disguise');
  await bar.getByRole('button', { name: 'Ask about this' }).click();
  await composer.fill('Why a hamster?');
  await composer.press('Enter');
  await expect.poll(() => page.url()).not.toBe(url);
  await expect(page.locator('.fork-divider.fork-current')).toContainText(/full path/i);
  await expect(page.locator('.anchor-quote').last()).toHaveText('a careful hamster in disguise');
  await expect(page.locator('.msg-user').last()).toContainText('Why a hamster?');
  await expect(quote).toHaveCount(0);
  await expect(composer).toHaveAttribute('placeholder', 'Ask anything in this tangent…');

  // Tangent ↳'s caret: "Tangent from here" with the quote filled in; cancelled, the quote stays.
  await page.goto(url);
  await expect(body).toBeVisible();
  await selectText(body, 'patient lemon');
  await bar.getByRole('button', { name: 'Ask about this' }).click();
  await page
    .locator('.composer-dock')
    .getByRole('button', { name: 'Tangent with options…' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Tangent from here' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: /^Anchor quote/ })).toHaveValue('patient lemon');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(page.url()).toBe(url);
  await expect(quote).toContainText('patient lemon');
  await quote.getByRole('button', { name: /^Don’t ask about/ }).click();

  // `b` puts selected words on the composer too; Shift+B opens the dialog with them.
  await body.click();
  await selectText(body, 'off-key');
  await page.keyboard.press('b');
  await expect(quote).toContainText('off-key');
  await expect(composer).toBeFocused();
  await page.keyboard.press('Escape');
  await selectText(body, 'off-key');
  await page.keyboard.press('Shift+B');
  await expect(dialog.getByRole('textbox', { name: /^Anchor quote/ })).toHaveValue('off-key');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(errors).toEqual([]);
});

test('Canvas demo: ask your own question in a new lane, inline or through the tangent dialog', async ({
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
  const dialog = page.getByRole('dialog', { name: 'Tangent from here' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Starting message')).toHaveCount(0);
  await expect(dialog.getByRole('textbox', { name: /title/i })).toHaveCount(0);
  await expect(dialog.locator('.excerpt').last()).toContainText('And owls?');
  await dialog.getByRole('button', { name: 'Open the lane and ask' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(lanes).toHaveCount(before + 2);
  await expect(page.locator('.card-user', { hasText: 'And owls?' })).toBeVisible();
  await expect(field).toHaveValue('');

  // From the tangent button: a starting message, still no title.
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

test('Canvas demo: "Ask about this" asks in a new lane once the question is sent; only the selected lane’s ask is open', async ({
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

  // Select words in the first reply: "Ask about this" asks for the question, making no lane yet.
  await selectText(trunk.locator('.card-assistant .card-body').first(), 'a careful hamster');
  const bar = page.locator('app-selection-ask');
  await expect(bar.getByRole('button', { name: /^More: Tangent from here/ })).toBeVisible();
  await bar.getByRole('button', { name: 'Ask about this' }).click();
  const box = page.locator('.quote-ask');
  const question = box.getByRole('textbox', { name: /question about the quoted words/ });
  await expect(box.locator('.composer-quote')).toContainText('a careful hamster');
  await expect(question).toBeFocused();
  await expect(lanes).toHaveCount(3);
  // Escape drops it, leaving nothing behind.
  await question.press('Escape');
  await expect(box).toHaveCount(0);
  await expect(lanes).toHaveCount(3);

  // Asked, the path lane quoting the words starts with the question.
  await selectText(trunk.locator('.card-assistant .card-body').first(), 'a careful hamster');
  await bar.getByRole('button', { name: 'Ask about this' }).click();
  await question.fill('Why a hamster?');
  await question.press('Enter');
  await expect(lanes).toHaveCount(4);
  await expect(box).toHaveCount(0);
  const lane = page.locator('.lane.is-selected');
  await expect(lane.locator('.anchor')).toHaveText('a careful hamster');
  await expect(lane.locator('.card-user')).toContainText('Why a hamster?');
  // The trunk is no longer selected: its open ask folds.
  await expect(page.locator('.tangent-ask.is-expanded')).toHaveCount(0);

  // The gear: the tangent dialog with the quote filled in.
  await selectText(trunk.locator('.card-assistant .card-body').first(), 'patient lemon');
  await bar.getByRole('button', { name: /^More: Tangent from here/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Tangent from here' });
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
  // Learn never sends the tree's prompt, so it keeps power's for power.
  expect(lesson.tree.systemPrompt).toBe('Talk like a pirate.');
  for (const b of lesson.branches) {
    expect(b.providerId).toBe('openrouter');
    expect(b.model).toBe('normal');
    expect(b.contextMode).toBe('path');
    expect(b.funding).toBe('own-key');
  }
  // An import gets new ids, and messages are listed by branch id, so compare them in any order.
  const contents = (nodes: { content: string }[]) => nodes.map((n) => n.content).sort();
  expect(contents(lesson.nodes)).toEqual(contents(backup.nodes));

  // A file that isn't a backup is refused with a message, and nothing is added.
  const notes = testInfo.outputPath('notes.md');
  fs.writeFileSync(notes, '# Notes');
  await page.locator('input[type=file]').setInputFiles(notes);
  await expect(page.locator('.toast-error')).toBeVisible();
  await expect(lessons).toHaveCount(before + 1);
  expect(errors).toEqual([]);
});
