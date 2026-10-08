// Compare (shared/compare.ts, docs/DECISIONS.md "Compare"): each candidate
// streams from the Worker and nothing enters the tree until one is committed;
// the tree's Durable Object holds finished candidates (CANDIDATE_TTL_MS) and
// appends the picked one under its send lock.
import type {
  ApiError,
  CandidateEvent,
  CommitCandidateResponse,
  StreamEvent,
  TreeDetail,
} from '@tangent/shared';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env as rawEnv, exports } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { grantCredit } from '../src/billing/ledger.js';
import type { AppEnv } from '../src/env.js';
import { uniq, usageRows } from './mocks/billing-helpers.js';
import { poolReadyUser } from './pool-helpers.js';
import { authEnv, client } from './session-client.js';

const env = rawEnv as unknown as AppEnv;
const BASE = 'https://tangent.example.com';

/** The dev bypass's power account (fake providers, vitest.config.ts). */
function call(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set('Content-Type', 'application/json');
  return exports.default.fetch(
    new Request(BASE + path, {
      ...rest,
      headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    }),
  );
}

async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  expect(r.status, text).toBe(status);
  return (text ? JSON.parse(text) : null) as T;
}

function events<T = CandidateEvent>(text: string): T[] {
  return text
    .split('\n\n')
    .map((frame) => frame.split('\n').find((l) => l.startsWith('data:')))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(5).trim()) as T);
}

function textOf(evs: CandidateEvent[]): string {
  return evs.map((e) => (e.type === 'delta' ? e.text : '')).join('');
}

/** A power tree on `fake` with one finished exchange. */
async function treeWithExchange(): Promise<TreeDetail> {
  const detail = await ok<TreeDetail>(
    call('/api/trees', { method: 'POST', json: { title: 'Compare', providerId: 'fake' } }),
    201,
  );
  const res = await call(`/api/branches/${detail.tree.trunkBranchId}/messages`, {
    method: 'POST',
    json: { content: 'First question' },
  });
  expect(res.status).toBe(200);
  expect(events<StreamEvent>(await res.text()).at(-1)?.type).toBe('done');
  return ok<TreeDetail>(call(`/api/trees/${detail.tree.id}`));
}

/** Streams one candidate; returns its events and the `done`. */
async function candidate(branchId: string, json: object) {
  const res = await call(`/api/branches/${branchId}/candidates`, { method: 'POST', json });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  expect(res.headers.get('Content-Type')).toContain('text/event-stream');
  const evs = events(text);
  const done = evs.at(-1);
  if (done?.type !== 'done') throw new Error(`expected done, got ${JSON.stringify(done)}`);
  return { evs, done };
}

function commit(branchId: string, candidateId: string) {
  return call(`/api/branches/${branchId}/candidates/${candidateId}/commit`, { method: 'POST' });
}

function treeSession(treeId: string) {
  return env.TREE_SESSION.get(env.TREE_SESSION.idFromName(treeId));
}

describe('compare candidates', () => {
  it('streams each candidate without touching the tree; a commit appends the picked one only', async () => {
    const detail = await treeWithExchange();
    const branchId = detail.tree.trunkBranchId;
    const before = detail.nodes.length;

    const slow = await candidate(branchId, {
      content: 'Which is better?',
      providerId: 'slow',
      model: 'fake-1',
    });
    expect(slow.done).toMatchObject({
      type: 'done',
      providerId: 'slow',
      funding: 'own-key',
      model: 'fake-1',
    });
    expect(textOf(slow.evs)).toContain('Fake reply (fake-1)');
    const expiresIn = Date.parse(slow.done.expiresAt) - Date.now();
    expect(expiresIn).toBeGreaterThan(29 * 60_000);
    expect(expiresIn).toBeLessThanOrEqual(30 * 60_000);
    // Without a provider, the candidate runs on the branch's route.
    const own = await candidate(branchId, { content: 'Which is better?', model: 'fake-1' });
    expect(own.done).toMatchObject({ providerId: 'fake', funding: 'own-key' });

    // Nothing is stored before the commit.
    expect((await ok<TreeDetail>(call(`/api/trees/${detail.tree.id}`))).nodes).toHaveLength(before);

    const committed = await ok<CommitCandidateResponse>(commit(branchId, slow.done.candidateId));
    expect(committed.userNode).toMatchObject({ role: 'user', content: 'Which is better?' });
    expect(committed.assistantNode).toMatchObject({
      role: 'assistant',
      status: 'complete',
      providerId: 'slow',
      model: 'fake-1',
      content: textOf(slow.evs),
      parentId: committed.userNode.id,
    });
    // The branch keeps its own route.
    expect(committed.branch).toMatchObject({ id: branchId, providerId: 'fake' });
    const after = await ok<TreeDetail>(call(`/api/trees/${detail.tree.id}`));
    expect(after.nodes).toHaveLength(before + 2);
    expect(after.nodes.at(-1)?.id).toBe(committed.assistantNode.id);

    // The other answer to the same question went with the commit, as does the picked one.
    for (const id of [own.done.candidateId, slow.done.candidateId]) {
      const gone = await commit(branchId, id);
      expect(gone.status).toBe(410);
      expect(((await gone.json()) as ApiError).error.code).toBe('gone');
    }
  });

  it('409 when the branch moved on since the candidate was asked', async () => {
    const detail = await treeWithExchange();
    const branchId = detail.tree.trunkBranchId;
    const { done } = await candidate(branchId, { content: 'Q', model: 'fake-1' });
    const send = await call(`/api/branches/${branchId}/messages`, {
      method: 'POST',
      json: { content: 'Something else' },
    });
    await send.text();
    const res = await commit(branchId, done.candidateId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiError).error.message).toMatch(/moved on/);
  });

  it('410 once it expired, 404 for another account or another branch', async () => {
    const detail = await treeWithExchange();
    const branchId = detail.tree.trunkBranchId;
    const stub = treeSession(detail.tree.id);
    const key = (id: string) => `candidate:${id}`;
    type Entry = { accountId: string; expiresAt: number };

    const expired = (await candidate(branchId, { content: 'Q', model: 'fake-1' })).done;
    await runInDurableObject(stub, async (_, state) => {
      const entry = (await state.storage.get<Entry>(key(expired.candidateId)))!;
      await state.storage.put(key(expired.candidateId), { ...entry, expiresAt: Date.now() - 1 });
    });
    const res = await commit(branchId, expired.candidateId);
    expect(res.status).toBe(410);
    expect(((await res.json()) as ApiError).error.message).toBe(
      'This comparison expired. Ask again.',
    );
    // An expired candidate is deleted once it is seen.
    await runInDurableObject(stub, async (_, state) => {
      expect(await state.storage.get(key(expired.candidateId))).toBeUndefined();
    });

    const foreign = (await candidate(branchId, { content: 'Q', model: 'fake-1' })).done;
    await runInDurableObject(stub, async (_, state) => {
      const entry = (await state.storage.get<Entry>(key(foreign.candidateId)))!;
      await state.storage.put(key(foreign.candidateId), { ...entry, accountId: 'p_someone' });
    });
    expect((await commit(branchId, foreign.candidateId)).status).toBe(404);

    // A candidate is committed only to its own branch.
    const mine = (await candidate(branchId, { content: 'Q', model: 'fake-1' })).done;
    const other = await ok<{ id: string }>(
      call('/api/branches', {
        method: 'POST',
        json: { fromNodeId: detail.nodes.at(-1)!.id, title: 'Side' },
      }),
      201,
    );
    expect((await commit(other.id, mine.candidateId)).status).toBe(404);
    expect((await commit(branchId, 'no-such-candidate')).status).toBe(410);
    expect((await commit('no-such-branch', mine.candidateId)).status).toBe(404);
  });

  it('the alarm deletes a candidate when it expires, with no later hold needed', async () => {
    const detail = await treeWithExchange();
    const stub = treeSession(detail.tree.id);
    const { done } = await candidate(detail.tree.trunkBranchId, { content: 'Q', model: 'fake-1' });
    const key = `candidate:${done.candidateId}`;
    await runInDurableObject(stub, async (_, state) => {
      expect(await state.storage.getAlarm()).toBe(Date.parse(done.expiresAt));
      const entry = (await state.storage.get<{ expiresAt: number }>(key))!;
      await state.storage.put(key, { ...entry, expiresAt: Date.now() - 1 });
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_, state) => {
      expect(await state.storage.get(key)).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it('deleting the tree drops its held candidates', async () => {
    const detail = await treeWithExchange();
    await candidate(detail.tree.trunkBranchId, { content: 'Q', model: 'fake-1' });
    expect((await call(`/api/trees/${detail.tree.id}`, { method: 'DELETE' })).status).toBe(204);
    await runInDurableObject(treeSession(detail.tree.id), async (_, state) => {
      expect((await state.storage.list()).size).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it('after an account deletion, a held candidate still goes when it expires', async () => {
    const c = client(authEnv());
    const email = `compare-gone-${uniq('u')}@example.org`;
    await c.signIn(email);
    const detail = await ok<TreeDetail>(
      c.call('/api/trees', { method: 'POST', json: { title: 'Gone', providerId: 'fake' } }),
      201,
    );
    const branchId = detail.tree.trunkBranchId;
    await c.call(`/api/branches/${branchId}/messages`, { method: 'POST', json: { content: 'Q1' } });
    const held = await c.call(`/api/branches/${branchId}/candidates`, {
      method: 'POST',
      json: { content: 'Q2', model: 'fake-1' },
    });
    const done = events(await held.text()).at(-1);
    if (done?.type !== 'done') throw new Error('expected done');

    expect(
      (await c.call('/api/account', { method: 'DELETE', json: { confirmEmail: email } })).status,
    ).toBe(204);
    const stub = treeSession(detail.tree.id);
    const key = `candidate:${done.candidateId}`;
    await runInDurableObject(stub, async (_, state) => {
      expect(await state.storage.getAlarm()).toBe(Date.parse(done.expiresAt));
      const entry = (await state.storage.get<{ expiresAt: number }>(key))!;
      await state.storage.put(key, { ...entry, expiresAt: Date.now() - 1 });
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_, state) => {
      expect((await state.storage.list()).size).toBe(0);
    });
  });

  it('validates the request before any stream opens', async () => {
    const detail = await treeWithExchange();
    const branchId = detail.tree.trunkBranchId;
    const post = (json: unknown) =>
      call(`/api/branches/${branchId}/candidates`, { method: 'POST', json });
    expect((await post({ content: 'Q', model: 'not-listed' })).status).toBe(400);
    expect((await post({ content: 'Q', providerId: 'nope', model: 'fake-1' })).status).toBe(400);
    expect((await post({ content: '   ', model: 'fake-1' })).status).toBe(400);
    expect((await post({ model: 'fake-1' })).status).toBe(400);
    expect(
      (
        await call('/api/branches/missing/candidates', {
          method: 'POST',
          json: { content: 'Q', model: 'fake-1' },
        })
      ).status,
    ).toBe(404);
  });

  it('a dropped client stops the candidate, and nothing is held', async () => {
    const detail = await treeWithExchange();
    const branchId = detail.tree.trunkBranchId;
    const controller = new AbortController();
    const res = await exports.default.fetch(
      new Request(`${BASE}/api/branches/${branchId}/candidates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `slow` streams 2 characters every 30 ms.
        body: JSON.stringify({ content: 'Q', providerId: 'slow', model: 'fake-1' }),
        signal: controller.signal,
      }),
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => undefined);
    // Long enough for the whole slow reply, had it kept running.
    await new Promise((r) => setTimeout(r, 1_000));
    await runInDurableObject(treeSession(detail.tree.id), async (_, state) => {
      expect((await state.storage.list({ prefix: 'candidate:' })).size).toBe(0);
    });
  });
});

describe('compare in Learn', () => {
  it('on credit: both candidates are metered replies, on the lesson’s provider and tiers only', async () => {
    const c = client(authEnv());
    await c.signIn(`compare-${uniq('u')}@example.org`);
    const me = (await (await c.call('/api/me')).json()) as { userId: string };
    const billing = `u_${me.userId}`;
    await grantCredit(env.DB, {
      accountId: billing,
      kind: 'adjustment',
      amountMicros: 1_000_000,
      providerRef: null,
    });
    const detail = await ok<TreeDetail>(
      c.call('/api/trees', { method: 'POST', json: { title: 'Lesson' }, learn: 'credit' }),
      201,
    );
    const branchId = detail.tree.trunkBranchId;
    const ask = (json: object) =>
      c.call(`/api/branches/${branchId}/candidates`, { method: 'POST', json, learn: 'credit' });

    const dones: Extract<CandidateEvent, { type: 'done' }>[] = [];
    for (const model of ['simple', 'smart']) {
      const res = await ask({ content: 'Why is the sky blue?', model });
      const text = await res.text();
      expect(res.status, text).toBe(200);
      const done = events(text).at(-1);
      if (done?.type !== 'done') throw new Error(text);
      expect(done).toMatchObject({ providerId: 'openrouter', model });
      dones.push(done);
    }
    await vi.waitFor(async () => {
      const rows = (await usageRows(env, billing)).filter((r) => r.purpose === 'reply');
      rows.sort((a, b) => a.model.localeCompare(b.model));
      expect(rows.map((r) => [r.model, r.node_id, r.status])).toEqual([
        ['simple', null, 'settled'],
        ['smart', null, 'settled'],
      ]);
    });

    // Learn compares on its own provider, and only its tiers.
    expect((await ask({ content: 'Q', providerId: 'fake', model: 'fake-1' })).status).toBe(400);
    expect((await ask({ content: 'Q', model: 'some/other-model' })).status).toBe(400);

    const res = await c.call(
      `/api/branches/${branchId}/candidates/${dones[1]!.candidateId}/commit`,
      { method: 'POST', learn: 'credit' },
    );
    const committed = (await res.json()) as CommitCandidateResponse;
    expect(res.status).toBe(200);
    expect(committed.assistantNode).toMatchObject({ model: 'smart', providerId: 'openrouter' });
    expect(committed.userNode.content).toBe('Why is the sky blue?');
    // The commit itself calls no model (titles are off in tests): still two rows.
    expect(await usageRows(env, billing)).toHaveLength(2);
  });

  it('is refused on the open pool, for both routes', async () => {
    const u = await poolReadyUser();
    const detail = await ok<TreeDetail>(
      u.client.call('/api/trees', { method: 'POST', json: { title: 'P' }, learn: 'pool' }),
      201,
    );
    const branchId = detail.tree.trunkBranchId;
    const ask = await u.client.call(`/api/branches/${branchId}/candidates`, {
      method: 'POST',
      json: { content: 'Q', model: 'simple' },
      learn: 'pool',
    });
    expect(ask.status).toBe(403);
    expect((await ask.json()) as ApiError).toMatchObject({
      error: { code: 'pool_unavailable', message: "Compare isn't available on the open pool" },
    });
    const pick = await u.client.call(`/api/branches/${branchId}/candidates/any/commit`, {
      method: 'POST',
      learn: 'pool',
    });
    expect(pick.status).toBe(403);
    expect(((await pick.json()) as ApiError).error.code).toBe('pool_unavailable');
    expect(await usageRows(env, u.poolId)).toHaveLength(0);
  });
});
