import { expect, test, type APIRequestContext } from '@playwright/test';
import { membership, newEmail, paymentWebhook, sameOrigin, signIn } from './helpers';

/*
 * Compaction in the power app's context inspector, against the real Worker:
 * a conversation on the offline test provider's small-window model
 * (`fake-small`, serve.mjs: 6,000 input tokens) passes its budget, its oldest
 * messages are replaced by one summary, and the inspector says they are
 * compacted a step at a time so later turns reuse that summary. One more turn
 * keeps the same summary (same key, nothing new to generate).
 */

interface TreeDetail {
  tree: { id: string; trunkBranchId: string };
}

interface ContextResponse {
  plan: {
    compaction: {
      compactedNodeIds: string[];
      key: { anchorNodeId: string; sourceHash: string };
    } | null;
    truncation: unknown;
    complete: boolean;
    budget: { maxInputTokens: number; usedTokens: number };
  };
}

/** About 400 estimated tokens. */
const question = (i: number) =>
  `Question ${i}: ${'tell me more about tides and the moon. '.repeat(36)}`;

async function sendMessage(
  request: APIRequestContext,
  baseURL: string,
  branchId: string,
  i: number,
) {
  const sent = await request.post(`/api/branches/${branchId}/messages`, {
    headers: sameOrigin(baseURL),
    data: { content: question(i) },
  });
  expect(await sent.text()).toContain('"type":"done"');
}

async function contextOf(request: APIRequestContext, baseURL: string, branchId: string) {
  const res = await request.get(`/api/branches/${branchId}/context?resolve=false`, {
    headers: sameOrigin(baseURL),
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as ContextResponse).plan;
}

test('the inspector shows a compaction that later turns reuse', async ({
  context,
  page,
  baseURL,
}) => {
  const userId = await signIn(context, baseURL!, newEmail('compaction'));
  const request = context.request;
  // A member, so the conversation on the offline test provider can be sent to.
  await paymentWebhook(request, [membership(userId, 'active', 1)]);
  const created = await request.post('/api/trees', {
    headers: sameOrigin(baseURL!),
    data: { title: 'Tides', providerId: 'fake', model: 'fake-small' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { tree } = (await created.json()) as TreeDetail;

  // About 440 tokens a turn: the 6,000-token budget is passed at the 14th.
  let turn = 0;
  for (; turn < 15; turn++) await sendMessage(request, baseURL!, tree.trunkBranchId, turn);
  const before = await contextOf(request, baseURL!, tree.trunkBranchId);
  expect(before.budget.maxInputTokens).toBe(6000);
  expect(before.compaction).not.toBeNull();
  expect(before.truncation).toBeNull();
  expect(before.complete).toBe(true);

  // The next turn reuses the summary: same compacted messages, same key, already generated.
  await sendMessage(request, baseURL!, tree.trunkBranchId, turn);
  const after = await contextOf(request, baseURL!, tree.trunkBranchId);
  expect(after.compaction).toEqual({
    ...before.compaction,
    tokensBefore: expect.any(Number),
    tokensAfter: expect.any(Number),
  });
  expect(after.complete).toBe(true);

  await page.goto(`/t/${tree.id}`);
  await page.getByRole('button', { name: 'Context inspector (i)' }).click();
  const inspector = page.getByRole('complementary', { name: 'Context inspector' });
  await expect(inspector.locator('.notice').filter({ hasText: 'Compacted:' })).toContainText(
    `the ${before.compaction!.compactedNodeIds.length} oldest messages were replaced by a summary`,
  );
  const summary = inspector.locator('.seg-summary');
  await expect(summary).toHaveCount(1);
  await expect(summary).toContainText('compaction');
  await expect(summary).toContainText('exceeded the budget of 6000 tokens');
  await expect(summary).toContainText(
    'compacted about 3000 tokens at a time, so the next turns reuse this summary',
  );
  await expect(summary.locator('.status-ready')).toHaveText('ready');
});
