import type {
  Branch,
  ContextPlanResponse,
  ProviderInfo,
  ReviewEvent,
  StreamEvent,
  TreeBackup,
  TreeDetail,
  TreeSummary,
} from '@tangent/shared';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const BASE = 'https://tangent.example.com';

function call(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set('Content-Type', 'application/json');
  return exports.default.fetch(
    new Request(BASE + path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body }),
  );
}

async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  expect(r.status, text).toBe(status);
  return (text ? JSON.parse(text) : null) as T;
}

function parseSse(text: string): StreamEvent[] {
  return text
    .split('\n\n')
    .map((frame) => frame.split('\n').find((l) => l.startsWith('data:')))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(5).trim()) as StreamEvent);
}

async function sendMessage(branchId: string, content: string): Promise<StreamEvent[]> {
  const res = await call(`/api/branches/${branchId}/messages`, { method: 'POST', json: { content } });
  expect(res.status).toBe(200);
  expect(res.headers.get('Content-Type')).toContain('text/event-stream');
  return parseSse(await res.text());
}

async function newTree(providerId = 'fake'): Promise<TreeDetail> {
  return ok<TreeDetail>(call('/api/trees', { method: 'POST', json: { title: 'Test', providerId } }), 201);
}

function textOf(events: StreamEvent[]): string {
  return events.map((e) => (e.type === 'delta' ? e.text : '')).join('');
}

describe('owner API', () => {
  it('lists providers without secrets', async () => {
    const providers = await ok<ProviderInfo[]>(call('/api/providers'));
    expect(providers.map((p) => p.id)).toEqual(['fake', 'slow', 'ant']);
    expect(JSON.stringify(providers)).not.toMatch(/apiKey|baseUrl/);
  });

  it('creates a tree, streams a reply over SSE and persists it', async () => {
    const detail = await newTree();
    const events = await sendMessage(detail.tree.trunkBranchId, 'Hello worker');
    expect(events[0]?.type).toBe('start');
    expect(events.at(-1)?.type).toBe('done');
    const reply = textOf(events);
    expect(reply).toContain('Hello worker');

    const after = await ok<TreeDetail>(call(`/api/trees/${detail.tree.id}`));
    expect(after.nodes).toHaveLength(2);
    const assistant = after.nodes.find((n) => n.role === 'assistant')!;
    expect(assistant).toMatchObject({ status: 'complete', content: reply, providerId: 'fake' });
    expect(assistant.usage?.outputTokens).toBeGreaterThan(0);

    const trees = await ok<TreeSummary[]>(call('/api/trees'));
    expect(trees.find((t) => t.id === detail.tree.id)).toMatchObject({ messageCount: 2, branchCount: 1 });
  });

  it('branches with different modes and plans their context', async () => {
    const detail = await newTree();
    const trunk = detail.tree.trunkBranchId;
    const first = await sendMessage(trunk, 'TRUNK-CONTENT');
    const start = first[0];
    if (start?.type !== 'start') throw new Error('no start');
    const fork = start.assistantNode.id;

    const modes = ['path', 'summary', 'independent'] as const;
    const branches: Branch[] = [];
    for (const contextMode of modes) {
      branches.push(
        await ok<Branch>(
          call('/api/branches', { method: 'POST', json: { fromNodeId: fork, contextMode, anchorQuote: 'the quote' } }),
          201,
        ),
      );
    }
    for (const b of branches) {
      const ev = await sendMessage(b.id, `in ${b.contextMode}`);
      expect(ev.at(-1)?.type).toBe('done');
    }
    const plans = await Promise.all(
      branches.map((b) => ok<ContextPlanResponse>(call(`/api/branches/${b.id}/context`))),
    );
    const [path, summary, independent] = plans;
    expect(JSON.stringify(path!.rendered)).toContain('TRUNK-CONTENT');
    expect(summary!.plan.segments.some((s) => s.kind === 'summary' && s.status === 'ready')).toBe(true);
    expect(JSON.stringify(summary!.rendered.messages)).not.toContain('TRUNK-CONTENT');
    expect(JSON.stringify(independent!.rendered)).not.toContain('TRUNK-CONTENT');
    expect(independent!.rendered.system).toContain('the quote');
    // Siblings never see each other.
    expect(JSON.stringify(path!.rendered)).not.toContain('in independent');
    // The trunk stays trim.
    const trunkPlan = await ok<ContextPlanResponse>(call(`/api/branches/${trunk}/context`));
    expect(JSON.stringify(trunkPlan.rendered)).not.toMatch(/in (path|summary|independent)/);
  });

  it('rejects a concurrent send in the same branch with 409', async () => {
    const detail = await newTree('slow');
    const first = await call(`/api/branches/${detail.tree.trunkBranchId}/messages`, {
      method: 'POST',
      json: { content: 'long running' },
    });
    const second = await call(`/api/branches/${detail.tree.trunkBranchId}/messages`, {
      method: 'POST',
      json: { content: 'overlap' },
    });
    expect(second.status).toBe(409);
    await second.text();
    expect(parseSse(await first.text()).at(-1)?.type).toBe('done');
  });

  it('reconnects to a running generation and can cancel it', async () => {
    const detail = await newTree('slow');
    const res = await call(`/api/branches/${detail.tree.trunkBranchId}/messages`, {
      method: 'POST',
      json: { content: 'please write a long answer about everything' },
    });
    const reader = res.body!.getReader();
    const first = await reader.read();
    const start = parseSse(new TextDecoder().decode(first.value))[0];
    if (start?.type !== 'start') throw new Error('expected start');
    // Simulate the browser going away.
    await reader.cancel();

    const again = await call(`/api/nodes/${start.assistantNode.id}/stream`);
    const r2 = again.body!.getReader();
    const snap = parseSse(new TextDecoder().decode((await r2.read()).value));
    expect(snap[0]?.type).toBe('snapshot');

    expect((await call(`/api/nodes/${start.assistantNode.id}/cancel`, { method: 'POST' })).status).toBe(204);
    let rest = '';
    for (;;) {
      const chunk = await r2.read();
      if (chunk.done) break;
      rest += new TextDecoder().decode(chunk.value);
    }
    const last = parseSse(rest).at(-1);
    expect(last).toMatchObject({ type: 'error', message: 'Cancelled' });

    // After completion the stream endpoint serves the persisted state.
    const replay = parseSse(await (await call(`/api/nodes/${start.assistantNode.id}/stream`)).text());
    expect(replay.map((e) => e.type)).toEqual(['snapshot', 'error']);
  });

  it('finished generations continue after the client disconnects', async () => {
    const detail = await newTree('slow');
    const res = await call(`/api/branches/${detail.tree.trunkBranchId}/messages`, {
      method: 'POST',
      json: { content: 'short' },
    });
    const reader = res.body!.getReader();
    const start = parseSse(new TextDecoder().decode((await reader.read()).value))[0];
    if (start?.type !== 'start') throw new Error('expected start');
    await reader.cancel();
    const replay = parseSse(await (await call(`/api/nodes/${start.assistantNode.id}/stream`)).text());
    expect(replay.at(-1)?.type).toBe('done');
  });

  it('validates input and 404s', async () => {
    const bad = await call('/api/trees', { method: 'POST', json: { title: '' } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('bad_request');
    expect((await call('/api/trees/missing')).status).toBe(404);
    expect((await call('/api/branches/missing/messages', { method: 'POST', json: { content: 'x' } })).status).toBe(404);
    expect((await call('/api/nothing-here')).status).toBe(404);
  });

  it('updates branches and trees, and deletes trees', async () => {
    const detail = await newTree();
    const b = await ok<Branch>(
      call(`/api/branches/${detail.tree.trunkBranchId}`, { method: 'PATCH', json: { title: 'Renamed' } }),
    );
    expect(b.titleSource).toBe('user');
    await ok(call(`/api/trees/${detail.tree.id}`, { method: 'PATCH', json: { systemPrompt: 'Be terse' } }));
    expect((await call(`/api/trees/${detail.tree.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await call(`/api/trees/${detail.tree.id}`)).status).toBe(404);
  });

  it('backs up and restores a tree', async () => {
    const detail = await newTree();
    await sendMessage(detail.tree.trunkBranchId, 'backup me');
    const res = await call(`/api/trees/${detail.tree.id}/backup`);
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    const backup = (await res.json()) as TreeBackup;
    const restored = await ok<TreeDetail>(call('/api/import', { method: 'POST', json: backup }), 201);
    expect(restored.tree.id).not.toBe(detail.tree.id);
    expect(restored.nodes.map((n) => n.content)).toEqual(backup.nodes.map((n) => n.content));
  });
  it('streams a review of an assistant reply and validates the request', async () => {
    const detail = await newTree();
    const events = await sendMessage(detail.tree.trunkBranchId, 'Check me');
    const start = events[0];
    if (start?.type !== 'start') throw new Error('expected start');
    const assistantId = start.assistantNode.id;

    const res = await call(`/api/nodes/${assistantId}/review`, {
      method: 'POST',
      json: { providerId: 'slow', model: 'fake-1' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    const review = parseSse(await res.text()) as unknown as ReviewEvent[];
    expect(review.at(-1)).toMatchObject({ type: 'done', providerId: 'slow', model: 'fake-1' });
    const text = review.map((e) => (e.type === 'delta' ? e.text : '')).join('');
    expect(text).toContain('Fake reply (fake-1)');

    // Reviews are not stored in the tree.
    const after = await ok<TreeDetail>(call(`/api/trees/${detail.tree.id}`));
    expect(after.nodes).toHaveLength(2);

    const post = (nodeId: string, json: unknown) =>
      call(`/api/nodes/${nodeId}/review`, { method: 'POST', json });
    expect((await post(assistantId, { providerId: 'fake', model: 'not-listed' })).status).toBe(400);
    expect((await post(assistantId, { providerId: 'nope', model: 'fake-1' })).status).toBe(400);
    expect((await post(start.userNode.id, { providerId: 'fake', model: 'fake-1' })).status).toBe(400);
    expect((await post('missing', { providerId: 'fake', model: 'fake-1' })).status).toBe(404);
    expect((await post(assistantId, {})).status).toBe(400);
  });
});
