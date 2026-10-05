import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector } from '@angular/core';
import {
  DEFAULT_SYSTEM_PROMPT,
  splitTangents,
  type ReviewEvent,
  type StreamEvent,
} from '@tangent/shared';
import {
  API_FETCH,
  ApiClient,
  ApiError,
  parseReviewEvent,
  readSseEvents,
  readStreamEvents,
} from '../index';
import { describe, expect, it } from 'vitest';
import {
  createDemoFetch,
  DEMO_START_BALANCE_MICROS,
  DemoBackend,
  sseFrame,
  type DemoBackendOptions,
  type DemoStorage,
} from './backend';
import { createLoremProvider, seededRandom, type LoremProviderOptions } from './lorem';

/** The real ApiClient over the demo backend (no network, no DOM). */
function setup(options: DemoBackendOptions & { lorem?: LoremProviderOptions } = {}) {
  const { lorem, ...rest } = options;
  const backend = new DemoBackend({
    storage: null,
    provider: createLoremProvider({
      random: seededRandom(42),
      sleep: async () => undefined,
      ...lorem,
    }),
    ...rest,
  });
  const api = Injector.create({
    providers: [{ provide: ApiClient }, { provide: API_FETCH, useValue: backend.fetch }],
  }).get(ApiClient);
  return { backend, api };
}

async function events(res: Response): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of readStreamEvents(res.body!)) out.push(e);
  return out;
}

/** Resolves once `predicate` holds (polling the event loop). */
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('demo backend', () => {
  it('answers /api/me and /api/providers like a simple account on the tangent provider', async () => {
    const { api } = setup();
    await expect(api.me()).resolves.toMatchObject({ mode: 'simple', devMode: false });
    const [provider, ...others] = await api.providers();
    expect(others).toEqual([]);
    expect(provider).toMatchObject({ id: 'openrouter', defaultModel: 'smart', available: true });
    expect(provider!.models).toEqual([
      { id: 'smart', label: 'Smart' },
      { id: 'simple', label: 'Simple' },
    ]);
  });

  it('starts with the example lesson (main thread, a side question and a followed tangent)', async () => {
    const { api } = setup();
    const trees = await api.listTrees();
    expect(trees).toHaveLength(1);
    expect(trees[0]).toMatchObject({ branchCount: 3, messageCount: 8 });
    const detail = await api.getTree(trees[0]!.id);
    const side = detail.branches.find((b) => b.anchorQuote !== null)!;
    expect(side.parentBranchId).not.toBeNull();
    const point = detail.nodes.find((n) => n.id === side.branchPointNodeId)!;
    expect(point.content).toContain(side.anchorQuote!);
    // The followed tangent: titled after one of the first reply's tangents, asked as its first message.
    const tangent = detail.branches.find((b) => b.titleSource === 'user')!;
    expect(tangent.branchPointNodeId).toBe(point.id);
    expect(splitTangents(point.content).tangents.map((t) => t.title)).toContain(tangent.title);
    expect(detail.nodes.find((n) => n.branchId === tangent.id && n.role === 'user')?.content).toBe(
      tangent.title,
    );
    expect(detail.nodes.every((n) => n.status === 'complete')).toBe(true);
    const usage = await api.usage();
    expect(usage.entries.length).toBe(4);
  });

  it('creates a lesson, streams a reply over SSE, stores it, titles the lesson and charges for it', async () => {
    const { api } = setup({ seed: false });
    const detail = await api.createTree({ providerId: 'openrouter', model: 'smart' });
    expect(detail.tree.title).toBe('New conversation');
    expect(detail.tree.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);

    const res = await api.sendMessage(
      detail.tree.trunkBranchId,
      { content: 'Why is the sky blue?' },
      new AbortController().signal,
    );
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const stream = await events(res);
    const types = stream.map((e) => e.type);
    expect(types[0]).toBe('start');
    expect(types.at(-1)).toBe('done');
    expect(types.filter((t) => t === 'delta').length).toBeGreaterThan(10);
    expect(types.indexOf('usage')).toBeGreaterThan(types.lastIndexOf('delta'));
    expect(types.filter((t) => t === 'start' || t === 'done' || t === 'error')).toEqual([
      'start',
      'done',
    ]);

    const start = stream[0] as Extract<StreamEvent, { type: 'start' }>;
    const done = stream.at(-1) as Extract<StreamEvent, { type: 'done' }>;
    const text = stream.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('');
    expect(start.userNode.content).toBe('Why is the sky blue?');
    expect(start.assistantNode.status).toBe('streaming');
    expect(done.node).toMatchObject({
      id: start.assistantNode.id,
      status: 'complete',
      content: text,
    });
    expect(text.trimEnd()).toMatch(/<\/tangents>$/);

    const after = await api.getTree(detail.tree.id);
    const stored = after.nodes.find((n) => n.id === start.assistantNode.id)!;
    expect(stored).toMatchObject({ status: 'complete', content: text, model: 'smart' });
    expect(stored.usage?.outputTokens).toBeGreaterThan(0);
    // Auto-titled after the first reply, like production.
    expect(after.tree.title).not.toBe('New conversation');
    expect((await api.listTrees())[0]!.title).toBe(after.tree.title);

    const billing = await api.billing();
    expect(billing).toMatchObject({
      enabled: true,
      topUpsEnabled: false,
      membership: { required: false },
    });
    expect(billing.heldMicros).toBe(0);
    expect(billing.balanceMicros).toBeLessThan(DEMO_START_BALANCE_MICROS);
    expect(DEMO_START_BALANCE_MICROS - billing.balanceMicros).toBeLessThan(50_000);
    const usage = await api.usage();
    expect(usage.entries.map((e) => [e.purpose, e.status])).toEqual([
      ['title', 'settled'],
      ['reply', 'settled'],
    ]);
  });

  it('asks a side question with the parent path as context', async () => {
    const { api } = setup();
    const [lesson] = await api.listTrees();
    const detail = await api.getTree(lesson!.id);
    const reply = detail.nodes.find(
      (n) => n.role === 'assistant' && n.branchId === detail.tree.trunkBranchId,
    )!;
    const branch = await api.createBranch({
      fromNodeId: reply.id,
      contextMode: 'path',
      anchorQuote: 'a pineapple',
    });
    expect(branch).toMatchObject({
      parentBranchId: detail.tree.trunkBranchId,
      anchorQuote: 'a pineapple',
    });
    const plan = await api.getContext(branch.id, null, false);
    expect(plan.rendered.messages.map((m) => m.content)).toContain(reply.content);
    const stream = await events(
      await api.sendMessage(branch.id, { content: 'What?' }, new AbortController().signal),
    );
    expect(stream.at(-1)).toMatchObject({ type: 'done', node: { branchId: branch.id } });
    const updated = (stream.at(-1) as Extract<StreamEvent, { type: 'done' }>).branch;
    expect(updated.titleSource).toBe('auto');
  });

  it('cancels a running reply: the stream ends with an error and the partial reply is kept', async () => {
    const { api } = setup({
      seed: false,
      lorem: { sleep: undefined, minDelayMs: 5, maxDelayMs: 5 },
    });
    const tree = await api.createTree({});
    const res = await api.sendMessage(
      tree.tree.trunkBranchId,
      { content: 'Hi' },
      new AbortController().signal,
    );
    const seen: StreamEvent[] = [];
    for await (const e of readStreamEvents(res.body!)) {
      seen.push(e);
      if (seen.filter((x) => x.type === 'delta').length === 2) {
        await api.cancelNode((seen[0] as Extract<StreamEvent, { type: 'start' }>).assistantNode.id);
      }
    }
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ type: 'error', message: 'Cancelled', node: { status: 'error' } });
    const node = (await api.getTree(tree.tree.id)).nodes.find((n) => n.role === 'assistant')!;
    expect(node.status).toBe('error');
    expect(node.content.length).toBeGreaterThan(0);
    expect((await api.usage()).entries[0]).toMatchObject({
      status: 'unresolved',
      chargeMicros: null,
    });
    expect((await api.billing()).balanceMicros).toBe(DEMO_START_BALANCE_MICROS);
  });

  it('reconnects to a running reply with a snapshot, and replays a finished one', async () => {
    const { api } = setup({
      seed: false,
      lorem: { sleep: undefined, minDelayMs: 2, maxDelayMs: 2 },
    });
    const tree = await api.createTree({});
    const ctrl = new AbortController();
    const first = await api.sendMessage(tree.tree.trunkBranchId, { content: 'Hi' }, ctrl.signal);
    const reader = readStreamEvents(first.body!);
    const start = (await reader.next()).value as Extract<StreamEvent, { type: 'start' }>;
    await reader.next(); // one delta
    ctrl.abort(); // the reader goes away; the generation goes on
    await reader.return();

    const again = await events(
      await api.streamNode(start.assistantNode.id, new AbortController().signal),
    );
    expect(again[0]).toMatchObject({ type: 'snapshot', node: { id: start.assistantNode.id } });
    expect(again.at(-1)?.type).toBe('done');
    const done = again.at(-1) as Extract<StreamEvent, { type: 'done' }>;
    const snapshot = again[0] as Extract<StreamEvent, { type: 'snapshot' }>;
    const rest = again.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('');
    expect(snapshot.node.content + rest).toBe(done.node.content);

    const replay = await events(
      await api.streamNode(start.assistantNode.id, new AbortController().signal),
    );
    expect(replay.map((e) => e.type)).toEqual(['snapshot', 'done']);
  });

  it('answers unknown routes with a JSON 404 in the API error shape', async () => {
    const demoFetch = createDemoFetch({ storage: null });
    const res = await demoFetch('/api/nope', { method: 'GET' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'not_found', message: 'Not available in the demo' },
    });
    const { api } = setup();
    await expect(api.getTree('nope')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(api.createCheckout(500)).rejects.toBeInstanceOf(ApiError);
  });

  it('answers the pool routes with the pool off, so no pool UI shows and nothing is funded', async () => {
    const { api } = setup();
    await expect(api.poolStatus()).resolves.toMatchObject({ enabled: false });
    await expect(api.poolMe()).resolves.toMatchObject({
      available: false,
      personalAvailableMicros: DEMO_START_BALANCE_MICROS,
    });
    await expect(api.createCheckout(1000)).rejects.toBeInstanceOf(ApiError);
    // No impact snapshots either.
    await expect(api.poolImpact()).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(api.poolImpactWeeks()).resolves.toEqual({ weeks: [] });
  });

  it('rejects invalid bodies with a 400', async () => {
    const { api } = setup();
    await expect(api.createBranch({ fromNodeId: '' })).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
    });
  });

  it('answers 402 when the pretend credit is used up', async () => {
    const storage = memoryStorage();
    const { api } = setup({ storage });
    const tree = await api.createTree({});
    const saved = JSON.parse(storage.data.get('tangent.learn-demo.v1')!) as {
      balanceMicros: number;
    };
    storage.data.set('tangent.learn-demo.v1', JSON.stringify({ ...saved, balanceMicros: 0 }));
    const { api: next } = setup({ storage });
    await expect(
      next.sendMessage(tree.tree.trunkBranchId, { content: 'Hi' }, new AbortController().signal),
    ).rejects.toMatchObject({ status: 402, code: 'payment_required' });
  });

  it('mirrors the session to storage and restores it after a reload', async () => {
    const storage = memoryStorage();
    const { api } = setup({ storage, seed: false });
    const tree = await api.createTree({});
    await events(
      await api.sendMessage(
        tree.tree.trunkBranchId,
        { content: 'Hi' },
        new AbortController().signal,
      ),
    );
    await until(() => storage.data.has('tangent.learn-demo.v1'));

    const { api: reloaded } = setup({ storage });
    const detail = await reloaded.getTree(tree.tree.id);
    expect(detail.nodes.map((n) => n.status)).toEqual(['complete', 'complete']);
    expect((await reloaded.listTrees()).map((t) => t.id)).toEqual([tree.tree.id]); // not re-seeded
    expect((await reloaded.billing()).balanceMicros).toBeLessThan(DEMO_START_BALANCE_MICROS);
  });

  it('restores a session saved before funding was split from the provider', async () => {
    const storage = memoryStorage();
    const { api } = setup({ storage, seed: false });
    const tree = await api.createTree({});
    await events(
      await api.sendMessage(
        tree.tree.trunkBranchId,
        { content: 'Hi' },
        new AbortController().signal,
      ),
    );
    await until(() => storage.data.has('tangent.learn-demo.v1'));
    // Rewrite the saved session as an older build stored it: the legacy id, no funding.
    const saved = JSON.parse(storage.data.get('tangent.learn-demo.v1')!) as {
      branches: Record<string, unknown>[];
      nodes: Record<string, unknown>[];
    };
    const legacy = {
      ...saved,
      branches: saved.branches.map(({ funding: _f, ...b }) => ({ ...b, providerId: 'tangent' })),
      nodes: saved.nodes.map((n) => (n['providerId'] ? { ...n, providerId: 'tangent' } : n)),
    };
    storage.data.set('tangent.learn-demo.v1', JSON.stringify(legacy));

    const { api: reloaded } = setup({ storage });
    const detail = await reloaded.getTree(tree.tree.id);
    expect(detail.branches[0]).toMatchObject({ providerId: 'openrouter', funding: 'own-key' });
    expect(detail.nodes.find((n) => n.role === 'assistant')?.providerId).toBe('openrouter');
    // And it still sends.
    const more = await events(
      await reloaded.sendMessage(
        tree.tree.trunkBranchId,
        { content: 'Again' },
        new AbortController().signal,
      ),
    );
    expect(more.at(-1)?.type).toBe('done');
  });

  it('reviews a reply over SSE without storing anything', async () => {
    const { api } = setup();
    const [lesson] = await api.listTrees();
    const before = await api.getTree(lesson!.id);
    const reply = before.nodes.find((n) => n.role === 'assistant')!;
    const res = await api.reviewNode(
      reply.id,
      { providerId: 'openrouter', model: 'smart' },
      new AbortController().signal,
    );
    const seen: ReviewEvent[] = [];
    for await (const e of readSseEvents(res.body!, parseReviewEvent)) seen.push(e);
    expect(seen.some((e) => e.type === 'delta')).toBe(true);
    expect(seen.at(-1)).toMatchObject({ type: 'done', providerId: 'openrouter', model: 'smart' });
    expect((await api.getTree(lesson!.id)).nodes).toEqual(before.nodes);
  });

  it('serializes SSE frames like the Worker', () => {
    expect(sseFrame({ type: 'status', message: 'x' })).toBe(
      'event: status\ndata: {"type":"status","message":"x"}\n\n',
    );
  });
});

describe('power demo backend', () => {
  it('acts as a power account with no stored keys and no shares', async () => {
    const { api } = setup({ mode: 'power' });
    await expect(api.me()).resolves.toMatchObject({
      mode: 'power',
      builtInCredit: false,
      sharing: false,
      isAdmin: false,
      membership: { required: false },
      // Nothing needs a membership, so no power branch is ever read-only here.
      membershipNeededFor: [],
      featuredConversations: false,
    });
    // So "Create a copy in Learn" is never offered: the two demos stay apart.
    const [tree] = await api.listTrees();
    await expect(api.copyToLearn(tree!.id)).rejects.toMatchObject({
      status: 400,
      message: "Copying to Learn isn't available in the demo.",
    });
    await expect(api.keyStatus()).resolves.toEqual({
      enabled: false,
      hasKey: false,
      providers: [],
    });
    await expect(api.listShares()).resolves.toEqual([]);
    await expect(
      api.createShare({ treeId: 'x', scope: 'tree' } as Parameters<ApiClient['createShare']>[0]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(api.saveKey('openai', 'sk-x')).rejects.toMatchObject({ status: 400 });
  });

  it('starts conversations with the built-in prompt and is never out of credit', async () => {
    const storage = memoryStorage();
    const { api } = setup({ mode: 'power', storage, seed: false });
    const tree = await api.createTree({});
    expect(tree.tree.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    const saved = JSON.parse(storage.data.get('tangent.power-demo.v1')!) as object;
    storage.data.set('tangent.power-demo.v1', JSON.stringify({ ...saved, balanceMicros: 0 }));
    const { api: next } = setup({ mode: 'power', storage });
    const stream = await events(
      await next.sendMessage(
        tree.tree.trunkBranchId,
        { content: 'Hi' },
        new AbortController().signal,
      ),
    );
    expect(stream.at(-1)?.type).toBe('done');
    expect(storage.data.has('tangent.learn-demo.v1')).toBe(false);
  });

  it('saves a default system prompt in Settings, keeps it across a reload, and resets it', async () => {
    const storage = memoryStorage();
    const { api } = setup({ mode: 'power', storage, seed: false });
    await expect(api.settings()).resolves.toEqual({
      systemPrompt: null,
      defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    });
    await expect(api.updateSettings({ systemPrompt: 'Be terse.' })).resolves.toEqual({
      systemPrompt: 'Be terse.',
      defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    });
    expect((await api.createTree({})).tree.systemPrompt).toBe('Be terse.');
    expect((await api.createTree({ systemPrompt: 'Mine.' })).tree.systemPrompt).toBe('Mine.');

    const { api: next } = setup({ mode: 'power', storage });
    await expect(next.settings()).resolves.toMatchObject({ systemPrompt: 'Be terse.' });
    await expect(next.updateSettings({ systemPrompt: null })).resolves.toMatchObject({
      systemPrompt: null,
    });
    expect((await next.createTree({})).tree.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    await expect(next.updateSettings({ systemPrompt: 'x'.repeat(20_001) })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('backs up a conversation and imports it as a copy', async () => {
    const { api, backend } = setup({ mode: 'power' });
    const [lesson] = await api.listTrees();
    const res = await backend.fetch(api.backupUrl(lesson!.id));
    const backup = (await res.json()) as Parameters<ApiClient['importBackup']>[0];
    const copy = await api.importBackup(backup);
    expect(copy.tree.id).not.toBe(lesson!.id);
    expect(copy.nodes).toHaveLength(8);
    expect(await api.listTrees()).toHaveLength(2);
  });

  it("adapts a power backup imported into the Learn demo to Learn's provider, models, context and prompt", async () => {
    const power = setup({ mode: 'power' });
    const [tree] = await power.api.listTrees();
    const res = await power.backend.fetch(power.api.backupUrl(tree!.id));
    const backup = (await res.json()) as Parameters<ApiClient['importBackup']>[0];
    // As power could have made it: another provider, a summary branch, a custom prompt.
    const [trunk, ...rest] = backup.branches;
    const fromPower = {
      ...backup,
      tree: { ...backup.tree, systemPrompt: 'Talk like a pirate.' },
      branches: [
        { ...trunk!, providerId: 'anthropic', model: 'vendor-large' },
        ...rest.map((b) => ({ ...b, contextMode: 'summary' as const, funding: 'credit' as const })),
      ],
    };

    const learn = setup({ seed: false });
    const lesson = await learn.api.importBackup(fromPower);
    expect(lesson.tree.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(lesson.branches.map((b) => [b.providerId, b.contextMode, b.funding])).toEqual(
      lesson.branches.map(() => ['openrouter', 'path', 'own-key']),
    );
    expect(lesson.branches[0]!.model).toBe('smart');
    expect(lesson.branches.slice(1).map((b) => b.model)).toEqual(rest.map((b) => b.model));
    expect(lesson.nodes.map((n) => n.content)).toEqual(backup.nodes.map((n) => n.content));
    expect((await learn.api.listTrees()).map((t) => t.id)).toEqual([lesson.tree.id]);

    // Learn's Export (fetched through the API transport) imports back as the same lesson.
    const again = await learn.api.importBackup(await learn.api.backup(lesson.tree.id));
    expect(again.tree.id).not.toBe(lesson.tree.id);
    expect(again.branches.map((b) => [b.title, b.providerId, b.model, b.contextMode])).toEqual(
      lesson.branches.map((b) => [b.title, b.providerId, b.model, b.contextMode]),
    );
    expect(again.nodes.map((n) => n.content)).toEqual(lesson.nodes.map((n) => n.content));

    // The Power demo imports the same file as it is.
    const copy = await power.api.importBackup(fromPower);
    expect(copy.tree.systemPrompt).toBe('Talk like a pirate.');
    expect(copy.branches.map((b) => [b.providerId, b.contextMode])).toEqual(
      fromPower.branches.map((b) => [b.providerId, b.contextMode]),
    );
  });
});

function memoryStorage(): DemoStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}
