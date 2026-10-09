import { expect, test, type Locator, type Page } from '@playwright/test';
import { membership, newEmail, paymentWebhook, sameOrigin, signIn, topUp } from './helpers';

/*
 * The model of an open-models route (Tangent credit here; OpenRouter on the
 * user's own key works the same) is a free-text id with every suggested model
 * as a chip under it, against the real Worker: serve.mjs lists Normal
 * (`normal`, the default) and Max (`max`) as the built-in provider's models,
 * labelled "Normal (suggested)" and "Max (suggested)" on Tangent credit; the
 * chips drop the note. A `<datalist>` filtered its options by the field's
 * text, so with the default id in it only that model was offered.
 */

interface TreeDetail {
  tree: { id: string; trunkBranchId: string };
  branches: { id: string; providerId: string; funding: string; model: string }[];
  nodes: { id: string; role: string }[];
}

/** Signs in a member with $5 of Tangent credit and one exchange on the offline test provider. */
async function setUp(page: Page, baseURL: string) {
  const context = page.context();
  const userId = await signIn(context, baseURL, newEmail('model-suggestions'));
  const request = context.request;
  const headers = sameOrigin(baseURL);
  await paymentWebhook(request, [membership(userId, 'active', 1), topUp(userId, 500)]);
  const created = await request.post('/api/trees', {
    headers,
    data: { title: 'Prime numbers', providerId: 'fake', model: 'fake-1' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const tree = ((await created.json()) as TreeDetail).tree;
  const sent = await request.post(`/api/branches/${tree.trunkBranchId}/messages`, {
    headers,
    data: { content: 'What is a prime number?' },
  });
  expect(await sent.text()).toContain('"type":"done"');
  return tree.id;
}

/** Both suggestions shown with the default (Normal) id in the field; Max sets its id. */
async function pickMax(scope: Locator, field: Locator) {
  const suggestions = scope.getByRole('group', { name: /suggest/i });
  const normal = suggestions.getByRole('button', { name: 'Normal' });
  const max = suggestions.getByRole('button', { name: 'Max' });
  await expect(field).toHaveValue('normal');
  await expect(normal).toBeVisible();
  await expect(max).toBeVisible();
  await expect(normal).toHaveAttribute('aria-pressed', 'true');
  await expect(max).toHaveAttribute('aria-pressed', 'false');

  await max.click();
  await expect(field).toHaveValue('max');
  await expect(max).toHaveAttribute('aria-pressed', 'true');
  await expect(normal).toHaveAttribute('aria-pressed', 'false');

  // Any other id may be typed: both suggestions stay, neither pressed.
  await field.fill('vendor/other-model');
  await expect(normal).toBeVisible();
  await expect(max).toHaveAttribute('aria-pressed', 'false');
  // Keyboard: the chips are buttons.
  await max.focus();
  await scope.page().keyboard.press('Enter');
  await expect(field).toHaveValue('max');
}

async function creditModels(page: Page, treeId: string): Promise<string[]> {
  const detail = (await (await page.request.get(`/api/trees/${treeId}`)).json()) as TreeDetail;
  return detail.branches.filter((b) => b.funding === 'credit').map((b) => b.model);
}

// One test, one sign-in: magic links are limited to 5 a minute, for the whole suite.
test('every suggested model stays in view under the model id, in power and Canvas', async ({
  page,
  baseURL,
}) => {
  const treeId = await setUp(page, baseURL!);

  // Power: Branch from here.
  await page.goto(`/t/${treeId}`);
  const reply = page.locator('.msg-assistant').first();
  await expect(reply).toBeVisible();
  await reply.getByRole('button', { name: 'Branch from here' }).click();
  const dialog = page.getByRole('dialog', { name: 'Branch from here' });
  await dialog
    .getByRole('combobox', { name: 'Provider' })
    .selectOption({ label: 'Tangent credit' });
  await pickMax(dialog, dialog.getByRole('textbox', { name: 'Model' }));
  await dialog.getByRole('button', { name: 'Create branch' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await creditModels(page, treeId)).toEqual(['max']);

  // Canvas: the lanes dialog of the same conversation.
  await page.goto(`/canvas/t/${treeId}`);
  const card = page.locator('.card-assistant').first();
  await expect(card).toBeVisible();
  await card.locator('.card-branch').click();
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('combobox', { name: 'Provider of lane 1' })
    .selectOption({ label: 'Tangent credit' });
  await pickMax(dialog, dialog.getByRole('textbox', { name: 'Model of lane 1' }));
  await dialog.getByRole('button', { name: 'Open the lane' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await creditModels(page, treeId)).toEqual(['max', 'max']);
});
