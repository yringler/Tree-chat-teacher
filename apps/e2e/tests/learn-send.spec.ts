import { expect, test, type Locator, type Page } from '@playwright/test';
import { withExampleLesson } from './example-lesson';
import { newEmail, paymentWebhook, signIn, topUp } from './helpers';

/*
 * Learn's sends against the Worker on Tangent credit: through the billing
 * gate and the tree's Durable Object to the scripted upstream (serve.mjs),
 * whose reply streams back and is charged. Each test is a new learner.
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

const LEARN = { 'x-tangent-mode': 'simple' };

test('Learn: a new lesson streams its first reply on credit, and charges for it', async ({
  page,
  context,
  baseURL,
}) => {
  const errors = collectErrors(page);
  const userId = await signIn(context, baseURL!, newEmail('learn-send'));
  await paymentWebhook(context.request, [topUp(userId, 500)]);
  await page.goto('/learn/');
  await page.locator('#new-lesson-topic').fill('Why is the sky blue?');
  await page.getByRole('button', { name: 'Start lesson' }).click();
  await expect(page).toHaveURL(/\/learn\/t\/[^/]+/);
  await expect(page.locator('.msg-user')).toContainText('Why is the sky blue?');
  await expect(page.locator('.msg-assistant')).toContainText(
    'Scripted reply (normal): "Why is the sky blue?"',
  );

  // Settled on the learner's own credit, below the $5 they bought.
  await expect
    .poll(async () => {
      const res = await context.request.get('/api/billing/usage', { headers: LEARN });
      const { entries } = (await res.json()) as { entries: { purpose: string; status: string }[] };
      return entries.find((e) => e.purpose === 'reply')?.status;
    })
    .toBe('settled');
  const res = await context.request.get('/api/billing', { headers: LEARN });
  expect(((await res.json()) as { balanceMicros: number }).balanceMicros).toBeLessThan(5_000_000);
  expect(errors).toEqual([]);
});

test('Learn: ask your own side question under a reply', async ({ page, context, baseURL }) => {
  const errors = collectErrors(page);
  await page.goto(`/learn/t/${await withExampleLesson(context, baseURL!, 'learn')}`);
  const ask = page.locator('.msg-assistant').last().locator('.tangent-ask');
  const field = ask.getByRole('textbox', { name: 'Ask your own question as a side question' });
  await expect(field).toHaveAttribute('placeholder', 'Ask your own question…');
  const url = page.url();
  await field.fill('Do owls ever whistle back?');
  await field.press('Enter');
  await expect.poll(() => page.url()).not.toBe(url);
  await expect(page).toHaveURL(/\/b\//);
  await expect(page.locator('.msg-user').last()).toContainText('Do owls ever whistle back?');
  await expect(page.locator('.msg-assistant').last()).toContainText(
    'Scripted reply (normal): "Do owls ever whistle back?"',
  );
  expect(errors).toEqual([]);
});

test('Learn: "Ask about this", the newest reply stands out, and the box continues the lesson', async ({
  page,
  context,
  baseURL,
}) => {
  const errors = collectErrors(page);
  await page.goto(`/learn/t/${await withExampleLesson(context, baseURL!, 'learn')}`);
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
  await expect(page.locator('.msg-assistant').last()).toContainText(
    'Scripted reply (normal): "Why a hamster?"',
  );
  await expect(composer).toHaveAttribute('placeholder', 'Continue this side question…');
  expect(errors).toEqual([]);
});
