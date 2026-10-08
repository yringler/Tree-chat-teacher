import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { membership, newEmail, paymentWebhook, sameOrigin, signIn, topUp } from './helpers';

/*
 * A power conversation started on the user's own key, opened in a browser that
 * has no key saved (another device, or it expired), by a member with Tangent
 * credit (docs/DECISIONS.md "A missing own key is a choice, not a wall"). The
 * route is `keyed` (serve.mjs), a provider on the user's own key that the tests
 * never save a key for: a send is refused with 401 `key_required` before
 * anything is written.
 * Tangent credit points nowhere here (serve.mjs), so a send carried on on credit
 * gets its message written and its reply fails at once; the message is what counts.
 */

interface TreeDetail {
  tree: { id: string; trunkBranchId: string };
  branches: { id: string; funding: string; providerId: string; model: string }[];
  nodes: { role: string; content: string }[];
}

const MESSAGE = 'Why do primes thin out?';

async function setUp(request: APIRequestContext, baseURL: string, userId: string) {
  // A member (own keys need the membership here) with $5 of Tangent credit.
  await paymentWebhook(request, [membership(userId, 'active', 1), topUp(userId, 500)]);
  const created = await request.post('/api/trees', {
    headers: sameOrigin(baseURL),
    data: { title: 'Prime numbers', providerId: 'keyed', model: 'keyed-1' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const tree = ((await created.json()) as TreeDetail).tree;
  return { treeId: tree.id, trunk: tree.trunkBranchId };
}

async function tree(request: APIRequestContext, treeId: string): Promise<TreeDetail> {
  return (await (await request.get(`/api/trees/${treeId}`)).json()) as TreeDetail;
}

/** Opens the conversation and sends MESSAGE from the composer; resolves once it was refused. */
async function sendRefused(page: Page, treeId: string, trunk: string) {
  const sends: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith(`/api/branches/${trunk}/messages`)) {
      sends.push((r.postDataJSON() as { content: string }).content);
    }
  });
  await page.goto(`/t/${treeId}`);
  const composer = page.locator('#composer-input');
  await expect(composer).toBeEnabled();
  // The bar under the composer says so before anything is sent.
  await expect(page.locator('.route-bar')).toContainText('No Keyed key in this browser.');

  // The send is held in flight, to look at the composer before the server answers.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    `**/api/branches/${trunk}/messages`,
    async (route) => {
      await held;
      await route.continue();
    },
    { times: 1 },
  );
  await composer.fill(MESSAGE);
  const refusal = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith(`/api/branches/${trunk}/messages`),
  );
  await composer.press('Enter');
  await expect.poll(() => sends.length).toBe(1);
  // Not in the tree yet: the text stays (disabled) until the reply starts.
  await expect(composer).toBeDisabled();
  await expect(composer).toHaveValue(MESSAGE);
  release();
  const refused = await refusal;
  expect(refused.status()).toBe(401);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('key_required');

  const dialog = page.getByRole('dialog', { name: 'Keys & credit' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('app-key-missing-notice')).toContainText('Your message wasn’t sent.');
  const credit = dialog.getByRole('button', { name: 'Continue on Tangent credit' });
  await expect(credit).toBeVisible();
  return { composer, dialog, credit, sends };
}

test('missing own key: "Continue on Tangent credit" moves the branch onto credit and sends the message', async ({
  context,
  page,
  baseURL,
}) => {
  const userId = await signIn(context, baseURL!, newEmail('missing-key-credit'));
  const t = await setUp(context.request, baseURL!, userId);
  const { composer, dialog, credit, sends } = await sendRefused(page, t.treeId, t.trunk);

  const [patch, sent] = await Promise.all([
    page.waitForRequest(
      (r) => r.method() === 'PATCH' && r.url().endsWith(`/api/branches/${t.trunk}`),
    ),
    page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        r.url().endsWith(`/api/branches/${t.trunk}/messages`) &&
        r.status() === 200,
    ),
    credit.click(),
  ]);
  // Credit doesn't serve the branch's model: its default one.
  expect(patch.postDataJSON()).toEqual({
    providerId: 'openrouter',
    funding: 'credit',
    model: 'smart',
  });
  expect(sent.request().postDataJSON()).toEqual({ content: MESSAGE });
  expect(sends).toEqual([MESSAGE, MESSAGE]);

  await expect(dialog).toHaveCount(0);
  // The message is in the thread, and the composer let it go once the reply started.
  await expect(page.locator('.msg-user')).toContainText(MESSAGE);
  await expect(composer).toHaveValue('');
  await expect(page.locator('.route-bar')).toContainText('Tangent credit');
  await expect(page.locator('.route-bar')).not.toContainText('key in this browser');

  const after = await tree(context.request, t.treeId);
  expect(after.branches.find((b) => b.id === t.trunk)).toMatchObject({
    providerId: 'openrouter',
    funding: 'credit',
    model: 'smart',
  });
  expect(after.nodes.filter((n) => n.role === 'user').map((n) => n.content)).toEqual([MESSAGE]);
});

test('missing own key: closing the dialog sends nothing and keeps the typed message in the composer', async ({
  context,
  page,
  baseURL,
}) => {
  const userId = await signIn(context, baseURL!, newEmail('missing-key-close'));
  const t = await setUp(context.request, baseURL!, userId);
  const { composer, dialog, sends } = await sendRefused(page, t.treeId, t.trunk);
  // While the dialog is open the text is still there.
  await expect(composer).toHaveValue(MESSAGE);

  await dialog.getByRole('button', { name: 'Close' }).first().click();
  await expect(dialog).toHaveCount(0);
  await expect(composer).toHaveValue(MESSAGE);
  await expect(composer).toBeEnabled();
  // Only the refused attempt: closing sent nothing, and nothing was written.
  expect(sends).toEqual([MESSAGE]);
  const after = await tree(context.request, t.treeId);
  expect(after.nodes).toEqual([]);
  expect(after.branches.find((b) => b.id === t.trunk)).toMatchObject({
    providerId: 'keyed',
    funding: 'own-key',
  });
});
