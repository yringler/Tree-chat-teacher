import { expect, test, type APIRequestContext } from '@playwright/test';
import { membership, newEmail, paymentWebhook, sameOrigin, signIn, topUp } from './helpers';

/*
 * Normal and Max in power, against the real Worker: serve.mjs lists Normal
 * (`simple`) and Max (`smart`) as the built-in provider's tiers, which power
 * offers on Tangent credit. The switch under the message box moves the branch
 * between them; Compare asks both and keeps nothing until one is picked (the
 * provider points nowhere, so here both answers fail and nothing is kept).
 */

interface TreeDetail {
  tree: { id: string; trunkBranchId: string };
  branches: { id: string; providerId: string; funding: string; model: string }[];
  nodes: { id: string; role: string }[];
}

const MESSAGE = 'Why is the sky blue?';

async function tree(request: APIRequestContext, treeId: string): Promise<TreeDetail> {
  return (await (await request.get(`/api/trees/${treeId}`)).json()) as TreeDetail;
}

// One test, one sign-in: magic links are limited to 5 a minute, for the whole suite.
test('the Normal | Max switch moves a credit branch between the tiers, and Compare keeps nothing unpicked', async ({
  context,
  page,
  baseURL,
}) => {
  const userId = await signIn(context, baseURL!, newEmail('tier-switch'));
  const request = context.request;
  await paymentWebhook(request, [membership(userId, 'active', 1), topUp(userId, 500)]);
  const created = await request.post('/api/trees', {
    headers: sameOrigin(baseURL!),
    data: { title: 'Sky', providerId: 'openrouter', funding: 'credit', model: 'simple' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const t = ((await created.json()) as TreeDetail).tree;

  await page.goto(`/t/${t.id}`);
  const bar = page.locator('.route-bar');
  const tiers = bar.getByRole('radiogroup', { name: 'Model tier' });
  const normal = tiers.getByRole('radio', { name: 'Normal' });
  const max = tiers.getByRole('radio', { name: 'Max' });
  const note = page.locator('.route-tier-note');
  await expect(normal).toHaveAttribute('aria-checked', 'true');
  await expect(bar.locator('.route-chip')).toContainText('Normal');
  await expect(note).toHaveCount(0);

  // Max: the branch moves onto it (still on credit), and what it costs shows.
  const [patch] = await Promise.all([
    page.waitForRequest(
      (r) => r.method() === 'PATCH' && r.url().endsWith(`/api/branches/${t.trunkBranchId}`),
    ),
    max.click(),
  ]);
  expect(patch.postDataJSON()).toEqual({
    providerId: 'openrouter',
    funding: 'credit',
    model: 'smart',
  });
  await expect(max).toHaveAttribute('aria-checked', 'true');
  await expect(bar.locator('.route-chip')).toContainText('Max');
  await expect(note).toHaveText(/^Max uses about \d+× as much as Normal\.$/);
  expect((await tree(request, t.id)).branches[0]).toMatchObject({
    funding: 'credit',
    model: 'smart',
  });

  // And back.
  await normal.click();
  await expect(normal).toHaveAttribute('aria-checked', 'true');
  await expect(note).toHaveCount(0);
  await expect.poll(async () => (await tree(request, t.id)).branches[0]?.model).toBe('simple');

  // Compare: both tiers answer in a dialog; closing it keeps the message and adds nothing.
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill(MESSAGE);
  const asked = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith(`/api/branches/${t.trunkBranchId}/candidates`),
  );
  await page.getByRole('button', { name: 'Compare Normal and Max' }).click();
  const dialog = page.getByRole('dialog', { name: 'Compare answers' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(MESSAGE);
  await expect(dialog).toContainText('Only the answer you pick is kept');
  expect((await asked).postDataJSON()).toEqual({
    content: MESSAGE,
    providerId: 'openrouter',
    funding: 'credit',
    model: 'simple',
  });
  await dialog.getByRole('button', { name: 'Close' }).first().click();
  await expect(dialog).toHaveCount(0);
  await expect(composer).toHaveValue(MESSAGE);
  expect((await tree(request, t.id)).nodes).toEqual([]);
});
