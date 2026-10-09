import crypto from 'node:crypto';
import { expect, type BrowserContext } from '@playwright/test';
// The demos' example lesson, so the tests against the Worker open the same lesson the demos do.
import { seedDemoLesson } from '../../../packages/web-shared/src/demo/seed';
import { newEmail, paymentWebhook, sameOrigin, signIn, topUp } from './helpers';

/**
 * Signs `context` in as a new user with $5 of Tangent credit and imports the
 * example lesson into the account of `app` (Learn, or power, whose branches
 * move onto credit: the built-in provider's own-key route has no key here).
 * Returns the new tree's id.
 */
export async function withExampleLesson(
  context: BrowserContext,
  baseURL: string,
  app: 'learn' | 'power',
): Promise<string> {
  const userId = await signIn(context, baseURL, newEmail(`example-${app}`));
  await paymentWebhook(context.request, [topUp(userId, 500)]);
  const state = {
    trees: new Map(),
    branches: new Map(),
    nodes: new Map(),
    links: new Map(),
    summaries: new Map(),
    shares: new Map(),
    snapshots: new Map(),
    settings: new Map(),
  };
  seedDemoLesson(state, { accountId: 'e2e', now: new Date(), newId: () => crypto.randomUUID() });
  const [tree] = [...state.trees.values()];
  const backup = {
    format: 'tangent-tree-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    tree,
    branches: [...state.branches.values()].map((b) =>
      app === 'power' ? { ...b, funding: 'credit' } : b,
    ),
    nodes: [...state.nodes.values()],
    links: [...state.links.values()],
  };
  const res = await context.request.post('/api/import', {
    headers: { ...sameOrigin(baseURL), ...(app === 'learn' ? { 'x-tangent-mode': 'simple' } : {}) },
    data: backup,
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { tree: { id: string } }).tree.id;
}
