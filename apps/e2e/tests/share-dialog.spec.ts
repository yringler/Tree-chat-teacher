import { expect, test, type APIRequestContext } from '@playwright/test';
import { membership, newEmail, paymentWebhook, sameOrigin, signIn } from './helpers';

/*
 * The share dialog (Share… in the chat header) lists the links the open
 * conversation already has, against the real Worker (serve.mjs turns share
 * links on for everyone): only that conversation's, newest first, and a link
 * made or revoked in the dialog shows there at once.
 */

interface TreeDetail {
  tree: { id: string; trunkBranchId: string };
  nodes: { id: string; role: string }[];
}

async function newTree(request: APIRequestContext, baseURL: string, title: string) {
  const created = await request.post('/api/trees', {
    headers: sameOrigin(baseURL),
    data: { title, providerId: 'fake', model: 'fake-1' },
  });
  expect(created.status(), await created.text()).toBe(201);
  return ((await created.json()) as TreeDetail).tree;
}

test('the share dialog lists this conversation’s links; new and revoked ones show at once', async ({
  context,
  page,
  baseURL,
}) => {
  const userId = await signIn(context, baseURL!, newEmail('share-dialog'));
  const request = context.request;
  const headers = sameOrigin(baseURL!);
  // A member, so the conversation on the offline test provider can be sent to.
  await paymentWebhook(request, [membership(userId, 'active', 1)]);

  // "Prime numbers": one exchange, and a live link to the path ending in the reply.
  const primes = await newTree(request, baseURL!, 'Prime numbers');
  const sent = await request.post(`/api/branches/${primes.trunkBranchId}/messages`, {
    headers,
    data: { content: 'What is a prime number?' },
  });
  expect(await sent.text()).toContain('"type":"done"');
  const detail = (await (await request.get(`/api/trees/${primes.id}`)).json()) as TreeDetail;
  const reply = detail.nodes.find((n) => n.role === 'assistant')!;
  const earlier = await request.post('/api/shares', {
    headers,
    data: {
      treeId: primes.id,
      scope: 'path',
      nodeId: reply.id,
      mode: 'live',
      title: 'Earlier link',
    },
  });
  expect(earlier.status(), await earlier.text()).toBe(201);
  // "Tides": no links of its own.
  const tides = await newTree(request, baseURL!, 'Tides');

  // Tides' dialog: the other conversation's link isn't there.
  await page.goto(`/t/${tides.id}`);
  await page.getByRole('button', { name: 'Share…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Share' });
  const existing = dialog.locator('.share-existing');
  await expect(existing).toContainText('No shares of this conversation yet');
  await expect(existing.locator('.share-card')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);

  // Prime numbers' dialog: its live path link, with the branch, the link and its actions.
  await page.goto(`/t/${primes.id}`);
  await page.getByRole('button', { name: 'Share…' }).click();
  const cards = existing.locator('.share-card');
  await expect(cards).toHaveCount(1);
  const old = cards.filter({ hasText: 'Earlier link' });
  await expect(old.locator('.share-top')).toContainText('active');
  await expect(old.locator('.share-top')).toContainText('live');
  await expect(old.locator('.share-top')).toContainText('Path');
  await expect(old).toContainText('ends in “Main thread”');
  await expect(old.locator('.share-url')).toContainText('/s/');
  await expect(old.getByRole('button', { name: 'Copy link' })).toBeEnabled();
  // No link back to the conversation the dialog is already in.
  await expect(old.getByRole('link', { name: 'Prime numbers' })).toHaveCount(0);

  // A new snapshot of the whole conversation joins the top of the list.
  await dialog.getByRole('button', { name: 'Create link' }).click();
  await expect(dialog).toContainText('Anyone with this link can read this conversation.');
  await expect(cards).toHaveCount(2);
  const made = cards.first();
  await expect(made.locator('.share-top')).toContainText('snapshot');
  await expect(made.locator('.share-top')).toContainText('Whole conversation');
  const url = await dialog.getByLabel('Share link').inputValue();
  await expect(made.locator('.share-url')).toHaveText(url);

  // Revoking the earlier link from the dialog takes it down there and then.
  page.once('dialog', (d) => void d.accept());
  await old.getByRole('button', { name: 'Revoke' }).click();
  await expect(old.locator('.share-top')).toContainText('revoked');
  await expect(old.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
  await expect(old.getByRole('button', { name: 'Copy link' })).toBeDisabled();

  // Reopened, the dialog reads the same from the server.
  await dialog.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Share…' }).click();
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(1)).toContainText('Earlier link');
  await expect(cards.nth(1).locator('.share-top')).toContainText('revoked');
  const shares = (await (await request.get('/api/shares')).json()) as { state: string }[];
  expect(shares.map((s) => s.state)).toEqual(['active', 'revoked']);
});
