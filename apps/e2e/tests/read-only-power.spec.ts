import { expect, test, type APIRequestContext } from '@playwright/test';
import { membership, newEmail, paymentWebhook, sameOrigin, signIn, topUp } from './helpers';

/*
 * Read-only power without a membership (docs/DECISIONS.md), against the real
 * Worker: the membership required (ANNUAL_FEE_ENABLED, sold by the fake payment
 * provider), a user whose membership was cancelled, with Tangent credit left.
 * The membership and the credit come from the payment webhook, as in production.
 */

interface TreeDetail {
  tree: { id: string; trunkBranchId: string };
  branches: { id: string; title: string; funding: string; providerId: string }[];
  nodes: { id: string; role: string; content: string }[];
}

async function setUp(request: APIRequestContext, baseURL: string, userId: string) {
  const headers = sameOrigin(baseURL);
  // While a member: a conversation on the user's own key (the offline test provider)...
  await paymentWebhook(request, [membership(userId, 'active', 1)]);
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
  expect(sent.status()).toBe(200);
  expect(await sent.text()).toContain('"type":"done"');
  const detail = (await (await request.get(`/api/trees/${tree.id}`)).json()) as TreeDetail;
  const reply = detail.nodes.find((n) => n.role === 'assistant')!;
  // ...and a side branch on Tangent credit, with $5 of it bought.
  const side = await request.post('/api/branches', {
    headers,
    data: {
      fromNodeId: reply.id,
      providerId: 'openrouter',
      funding: 'credit',
      model: 'smart',
      contextMode: 'path',
      title: 'Twin primes (on credit)',
    },
  });
  expect(side.status(), await side.text()).toBe(201);
  await paymentWebhook(request, [topUp(userId, 500)]);
  // Then the membership is cancelled.
  await paymentWebhook(request, [membership(userId, 'canceled', 2)]);
  const me = (await (await request.get('/api/me')).json()) as {
    membership: { status: string };
    membershipNeededFor: string[];
  };
  expect(me.membership.status).toBe('inactive');
  expect(me.membershipNeededFor).toEqual(['own-key']);
  return {
    treeId: tree.id,
    trunk: tree.trunkBranchId,
    side: ((await side.json()) as { id: string }).id,
  };
}

test('a cancelled membership: own-key branches read-only, credit carries on, copy to Learn', async ({
  context,
  page,
  baseURL,
}) => {
  const userId = await signIn(context, baseURL!, newEmail('read-only'));
  const t = await setUp(context.request, baseURL!, userId);
  const before = await (await context.request.get(`/api/trees/${t.treeId}`)).json();

  // The own-key trunk: the notice where the message box was.
  await page.goto(`/t/${t.treeId}`);
  const notice = page.locator('app-read-only-composer');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Your membership has ended.');
  await expect(page.locator('#composer-input')).toHaveCount(0);
  await expect(page.getByText('What is a prime number?', { exact: true })).toBeVisible();
  const renew = notice.getByRole('link', { name: 'Renew membership' });
  await expect(renew).toHaveAttribute('href', '/billing');
  await expect(notice.getByRole('button', { name: 'Continue with Tangent credit' })).toBeVisible();

  // The credit branch keeps its composer.
  await page.goto(`/t/${t.treeId}/b/${t.side}`);
  await expect(page.locator('#composer-input')).toBeVisible();
  await expect(page.locator('app-read-only-composer')).toHaveCount(0);

  // Renew goes to the billing page.
  await page.goto(`/t/${t.treeId}`);
  await notice.getByRole('link', { name: 'Renew membership' }).click();
  await expect(page).toHaveURL(/\/billing$/);

  // Create a copy in Learn: the lesson opens in Learn; the power tree is left as it was.
  await page.goto(`/t/${t.treeId}`);
  await Promise.all([
    page.waitForURL(/\/learn\/t\/[^/]+/),
    page
      .locator('app-read-only-composer')
      .getByRole('button', { name: 'Create a copy in Learn' })
      .click(),
  ]);
  const lessonId = /\/learn\/t\/([^/?#]+)/.exec(page.url())![1];
  expect(lessonId).not.toBe(t.treeId);
  await expect(page.getByText('What is a prime number?', { exact: true })).toBeVisible();
  expect(await (await context.request.get(`/api/trees/${t.treeId}`)).json()).toEqual(before);
  const lessons = (await (
    await context.request.get('/api/trees', { headers: { 'x-tangent-mode': 'simple' } })
  ).json()) as { id: string }[];
  expect(lessons.map((l) => l.id)).toEqual([lessonId]);

  // Continue with Tangent credit: the trunk moves onto credit and gets its composer back.
  await page.goto(`/t/${t.treeId}`);
  await page.getByRole('button', { name: 'Continue with Tangent credit' }).click();
  await expect(page.locator('#composer-input')).toBeVisible();
  await expect(page.locator('app-read-only-composer')).toHaveCount(0);
  const after = (await (await context.request.get(`/api/trees/${t.treeId}`)).json()) as TreeDetail;
  expect(after.branches.find((b) => b.id === t.trunk)).toMatchObject({
    providerId: 'openrouter',
    funding: 'credit',
  });
});

test('a new conversation starts on Tangent credit only while it can pay; with nothing to pay, the notice', async ({
  context,
  page,
  baseURL,
}) => {
  // Never a member, so own keys need the membership; no credit yet.
  const userId = await signIn(context, baseURL!, newEmail('default-route'));
  await page.goto('/');
  const notice = page.locator('.home-read-only');
  await expect(notice).toContainText('Replies on your own API keys need a membership.');
  await expect(notice.getByRole('link', { name: 'Open Learn' })).toBeVisible();
  await expect(page.locator('#composer-input')).toHaveCount(0);

  // With credit bought, the new-conversation box is back, on Tangent credit.
  await paymentWebhook(context.request, [topUp(userId, 500)]);
  await page.reload();
  await expect(page.locator('#composer-input')).toBeVisible();
  await expect(notice).toHaveCount(0);
  await expect(page.getByLabel('Provider')).toHaveValue('openrouter@credit');
});
