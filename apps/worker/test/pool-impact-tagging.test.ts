// The pool notice, its versioned acknowledgment and request-time topic
// tagging (docs/pool/PLAN.md §S8a; spec §9 "Consent" and "Tagging").
import {
  POOL_NOTICE_TEXT,
  POOL_NOTICE_VERSION,
  type ApiError,
  type Branch,
  type GenerateRequest,
  type LearnPayment,
  type PoolConsentResponse,
  type PoolMeResponse,
  type ProviderRegistry,
  type StreamEvent,
  type TreeDetail,
} from '@tangent/shared';
import { createProviderRegistry } from '@tangent/providers';
import { env as rawEnv } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteUser } from '../src/auth/delete-account.js';
import { grantCredit } from '../src/billing/ledger.js';
import { appConfig } from '../src/config.js';
import type { AccountContext, AppEnv } from '../src/env.js';
import { resolvePoolParams } from '../src/pool/params.js';
import {
  CLASSIFIER_SYSTEM_PROMPT,
  classifyPoolExchange,
  type TagOutcome,
} from '../src/pool/tagging.js';
import {
  isSensitive,
  isValidLeafTopicId,
  LEAF_TOPIC_IDS,
  SENSITIVE_TOPIC_ID,
  topicById,
  TOPICS,
} from '../src/pool/taxonomy.js';
import { simpleProviderConfig } from '../src/simple-mode.js';
import { simpleAccount, uniq } from './mocks/billing-helpers.js';
import { poolReadyUser, taggingSettled } from './pool-helpers.js';
import { authEnv, type CallInit } from './session-client.js';

const env = rawEnv as unknown as AppEnv;
/** The pool params of the test env (its price is a `MODEL_PRICES` entry: no D1 read). */
const BASE_PARAMS = await resolvePoolParams(env, null);

type User = Awaited<ReturnType<typeof poolReadyUser>>;

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return (text ? JSON.parse(text) : null) as T;
}

function events(text: string): StreamEvent[] {
  return text
    .split('\n\n')
    .map((frame) => frame.split('\n').find((l) => l.startsWith('data:')))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(5).trim()) as StreamEvent);
}

async function newTree(u: User, learn: LearnPayment = 'pool') {
  const detail = await json<TreeDetail>(
    await u.client.call('/api/trees', { method: 'POST', json: { title: 'T' }, learn }),
    201,
  );
  return { treeId: detail.tree.id, branchId: detail.branches[0]!.id };
}

function send(u: User, branchId: string, content: string, init: CallInit = {}, as?: AppEnv) {
  return u.client.call(
    `/api/branches/${branchId}/messages`,
    { method: 'POST', json: { content }, learn: 'pool', ...init },
    as,
  );
}

/** Sends and expects a completed reply; returns the stream's events. */
async function sendOk(
  u: User,
  branchId: string,
  content: string,
  init: CallInit = {},
): Promise<StreamEvent[]> {
  const res = await send(u, branchId, content, init);
  const text = await res.text();
  expect(res.status, text).toBe(200);
  const all = events(text);
  expect(all.at(-1)?.type, text).toBe('done');
  return all;
}

function consent(u: User, version: number, as?: AppEnv) {
  return u.client.call(
    '/api/pool/consent',
    { method: 'POST', json: { version }, learn: 'pool' },
    as,
  );
}

async function nodeCount(u: User, treeId: string): Promise<number> {
  const detail = await json<TreeDetail>(
    await u.client.call(`/api/trees/${treeId}`, { learn: 'pool' }),
  );
  return detail.nodes.length;
}

interface TagRow {
  branch_id: string;
  topic_id: string;
  branch_depth: number;
  created_at: string;
}

async function tagOf(branchId: string): Promise<TagRow | null> {
  return env.DB.prepare('SELECT * FROM pool_topic_tags WHERE branch_id = ?')
    .bind(branchId)
    .first<TagRow>();
}

/** Waits for the background tagging of `branchId` to store its tag. */
async function taggedAs(branchId: string): Promise<TagRow> {
  let row: TagRow | null = null;
  await vi.waitFor(
    async () => {
      row = await tagOf(branchId);
      expect(row).not.toBeNull();
    },
    { timeout: 5_000, interval: 20 },
  );
  return row!;
}

interface UsageRow {
  account_id: string;
  funding: string;
  user_id: string | null;
  branch_id: string | null;
  purpose: string;
  status: string;
  hold_micros: number;
  charge_micros: number | null;
  settle_reason: string | null;
}

async function taggingRowsOf(userId: string): Promise<UsageRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM usage_events WHERE user_id = ? AND purpose = 'tagging' ORDER BY created_at, id`,
  )
    .bind(userId)
    .all<UsageRow>();
  return results;
}

async function columnsOf(table: string): Promise<{ name: string; type: string }[]> {
  const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{
    name: string;
    type: string;
  }>();
  return results.map(({ name, type }) => ({ name, type }));
}

/** Every text value of every row of `table`, joined: what a marker scan reads. */
async function textOf(table: string): Promise<string> {
  const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>();
  return results
    .flatMap((row) => Object.values(row).filter((v): v is string => typeof v === 'string'))
    .join('\n');
}

// ---- Direct calls of the classifier, with a recording provider under the real pool meter

/** A pool-funded Learn account on `poolId`. */
function poolAccount(poolId: string, userId = uniq('user')): AccountContext {
  return {
    ...simpleAccount(userId),
    funding: 'pool',
    pool: { ...BASE_PARAMS, accountId: poolId },
  };
}

/**
 * The pool's `tangent` config, as a fake answering `output` to anything, with
 * every request it receives recorded.
 */
function recordingProviders(output: string): {
  providers: ProviderRegistry;
  requests: GenerateRequest[];
} {
  const requests: GenerateRequest[] = [];
  const inner = createProviderRegistry(
    [
      {
        ...simpleProviderConfig(env),
        kind: 'fake',
        options: { chunkSize: 3, costUsd: 0.000_05, responses: { '': output } },
      },
    ],
    { secrets: {} },
  );
  return {
    requests,
    providers: {
      get(id) {
        const provider = inner.get(id);
        if (!provider) return provider;
        return {
          ...provider,
          id: provider.id,
          kind: provider.kind,
          label: provider.label,
          models: () => provider.models(),
          defaultModel: () => provider.defaultModel(),
          capabilities: (m) => provider.capabilities(m),
          stream: (request) => {
            requests.push(request);
            return provider.stream(request);
          },
        };
      },
      list: () => inner.list(),
      defaultProviderId: () => inner.defaultProviderId(),
    },
  };
}

/** Runs `classifyPoolExchange` to the end of its background work. */
async function classify(
  account: AccountContext,
  branchId: string,
  message: string,
  output: string,
): Promise<{ outcome: TagOutcome; requests: GenerateRequest[] }> {
  const { providers, requests } = recordingProviders(output);
  const pending: Promise<unknown>[] = [];
  const outcome = await classifyPoolExchange(
    env,
    account,
    {
      treeId: uniq('tree'),
      branchId,
      poolExchangeUserMessage: message,
      defer: (p) => pending.push(p),
    },
    { providers },
  );
  await Promise.all(pending);
  return { outcome, requests };
}

/** A real (trunk) branch of a fresh pool user's tree, on a funded pool of its own. */
async function poolBranch() {
  const u = await poolReadyUser();
  const { branchId } = await newTree(u);
  return { u, branchId, account: poolAccount(u.poolId, u.userId) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the pool notice', () => {
  it('blocks pool requests until the current notice version is acknowledged (spec test)', async () => {
    const u = await poolReadyUser({ consent: false });
    const { treeId, branchId } = await newTree(u);

    const me = await json<PoolMeResponse>(await u.client.call('/api/pool/me', { learn: 'pool' }));
    expect(me).toMatchObject({ consentVersion: null, currentNoticeVersion: POOL_NOTICE_VERSION });

    // Before consent: 403 with the version to acknowledge, nothing written, nothing reserved.
    const refused = await json<ApiError>(await send(u, branchId, 'Hi'), 403);
    expect(refused.error).toMatchObject({
      code: 'pool_consent_required',
      consent: { currentVersion: POOL_NOTICE_VERSION },
    });
    expect(await nodeCount(u, treeId)).toBe(0);
    const resolve = await u.client.call(`/api/branches/${branchId}/context?resolve=true`, {
      learn: 'pool',
    });
    expect((await json<ApiError>(resolve, 403)).error.code).toBe('pool_consent_required');
    const { results } = await env.DB.prepare('SELECT 1 FROM usage_events WHERE account_id = ?')
      .bind(u.poolId)
      .all();
    expect(results).toEqual([]);

    // After acknowledging v1: the send goes through.
    const before = Date.now();
    const ack = await json<PoolConsentResponse>(await consent(u, POOL_NOTICE_VERSION));
    expect(ack.version).toBe(POOL_NOTICE_VERSION);
    await sendOk(u, branchId, 'Hi');

    // The record: user, time, version; nothing else.
    expect((await columnsOf('pool_consents')).map((c) => c.name)).toEqual([
      'user_id',
      'notice_version',
      'acknowledged_at',
    ]);
    const row = await env.DB.prepare('SELECT * FROM pool_consents WHERE user_id = ?')
      .bind(u.userId)
      .first<{ user_id: string; notice_version: number; acknowledged_at: string }>();
    expect(row).toEqual({
      user_id: u.userId,
      notice_version: POOL_NOTICE_VERSION,
      acknowledged_at: ack.acknowledgedAt,
    });
    expect(Date.parse(row!.acknowledged_at)).toBeGreaterThanOrEqual(before - 1_000);
    expect(Date.parse(row!.acknowledged_at)).toBeLessThanOrEqual(Date.now());

    // A repeat keeps the first acknowledgment.
    expect(await json<PoolConsentResponse>(await consent(u, POOL_NOTICE_VERSION))).toEqual(ack);
  });

  it('asks again after a version bump, and accepts only the current version', async () => {
    const u = await poolReadyUser();
    const { branchId } = await newTree(u);
    await sendOk(u, branchId, 'Hi');

    // The notice text changed: version 2 (a test seam raises the code constant).
    const v2 = authEnv({ POOL_ACCOUNT_ID: u.poolId, POOL_NOTICE_VERSION: '2' });
    expect(appConfig(v2).pool.noticeVersion).toBe(2);
    const refused = await json<ApiError>(await send(u, branchId, 'Again', {}, v2), 403);
    expect(refused.error).toMatchObject({
      code: 'pool_consent_required',
      consent: { currentVersion: 2 },
    });
    expect(
      await json<PoolMeResponse>(await u.client.call('/api/pool/me', { learn: 'pool' }, v2)),
    ).toMatchObject({ consentVersion: 1, currentNoticeVersion: 2 });

    // The outdated text is no acknowledgment of the new one; nor is a version that doesn't exist.
    expect((await json<ApiError>(await consent(u, 1, v2), 409)).error.code).toBe('conflict');
    expect((await json<ApiError>(await consent(u, 3, v2), 409)).error.code).toBe('conflict');
    expect((await json<ApiError>(await consent(u, 0, v2), 400)).error.code).toBe('bad_request');

    await json<PoolConsentResponse>(await consent(u, 2, v2));
    const ok = await send(u, branchId, 'Again', {}, v2);
    const text = await ok.text();
    expect(ok.status, text).toBe(200);
    const { results } = await env.DB.prepare(
      'SELECT notice_version FROM pool_consents WHERE user_id = ? ORDER BY notice_version',
    )
      .bind(u.userId)
      .all<{ notice_version: number }>();
    expect(results.map((r) => r.notice_version)).toEqual([1, 2]);
  });

  it('applies to the pool only: personal credit needs no acknowledgment', async () => {
    const u = await poolReadyUser({ consent: false });
    await grantCredit(env.DB, {
      accountId: `u_${u.userId}`,
      kind: 'adjustment',
      amountMicros: 1_000_000,
      providerRef: null,
    });
    const { branchId } = await newTree(u, 'credit');
    await sendOk(u, branchId, 'Hi', { learn: 'credit' });
  });

  it('is plain language, and the copy rule holds', () => {
    expect(POOL_NOTICE_TEXT).toContain('Your questions are never shown');
    expect(POOL_NOTICE_TEXT).not.toMatch(/donat|tax[- ]?deductible/i);
  });
});

describe('request-time topic tagging', () => {
  it('tags a pool exchange with its leaf topic and the branch depth; the cost is a pool row outside the caps', async () => {
    const u = await poolReadyUser();
    const { branchId } = await newTree(u);
    const done = await sendOk(u, branchId, 'How did the Senate work? [topic:history.ancient-rome]');
    const tag = await taggedAs(branchId);
    expect(tag).toMatchObject({ topic_id: 'history.ancient-rome', branch_depth: 0 });
    await taggingSettled(u.poolId, 1);
    const [row, ...more] = await taggingRowsOf(u.userId);
    expect(more).toEqual([]);
    expect(row).toMatchObject({
      account_id: u.poolId,
      funding: 'pool',
      branch_id: branchId,
      status: 'settled',
      settle_reason: 'cost',
    });
    expect(row!.charge_micros).toBeGreaterThan(0);
    expect(row!.charge_micros).toBeLessThanOrEqual(row!.hold_micros);

    // A branch one level down gets its own tag, at depth 1.
    const last = done.at(-1)!;
    const replyId = last.type === 'done' ? last.node.id : '';
    const child = await json<Branch>(
      await u.client.call('/api/branches', {
        method: 'POST',
        json: { fromNodeId: replyId },
        learn: 'pool',
      }),
      201,
    );
    await sendOk(u, child.id, 'And the consuls? [topic:history.ancient-rome]');
    expect(await taggedAs(child.id)).toMatchObject({
      topic_id: 'history.ancient-rome',
      branch_depth: 1,
    });

    // The free tier's 3 replies a day (vitest.config.ts) still fit after 2 classifications:
    // tagging counts toward no one's caps. The caps' spend leaves tagging out too.
    await taggingSettled(u.poolId, 2);
    const { branchId: third } = await newTree(u);
    await sendOk(u, third, 'Third');
    const me = await json<PoolMeResponse>(await u.client.call('/api/pool/me', { learn: 'pool' }));
    expect(me.caps.usedRequests).toBe(3);
    const { spend } = (await env.DB.prepare(
      `SELECT SUM(CASE WHEN status = 'pending' THEN hold_micros ELSE charge_micros END) AS spend
         FROM usage_events WHERE account_id = ? AND user_id = ? AND purpose <> 'tagging'`,
    )
      .bind(u.poolId, u.userId)
      .first<{ spend: number }>())!;
    expect(me.caps.usedSpendMicros).toBe(spend);
  });

  it('stores a sensitive topic as the sentinel, never its id', async () => {
    const u = await poolReadyUser();
    const { branchId } = await newTree(u);
    await sendOk(u, branchId, 'Is this rash serious? [topic:health.conditions]');
    expect((await taggedAs(branchId)).topic_id).toBe(SENSITIVE_TOPIC_ID);
    const { results } = await env.DB.prepare(
      "SELECT 1 FROM pool_topic_tags WHERE topic_id LIKE 'health%'",
    ).all();
    expect(results).toEqual([]);
  });

  it('never tags conversations on personal credit or the user’s own key (spec test)', async () => {
    const u = await poolReadyUser();
    await grantCredit(env.DB, {
      accountId: `u_${u.userId}`,
      kind: 'adjustment',
      amountMicros: 1_000_000,
      providerRef: null,
    });
    const personal = await newTree(u, 'credit');
    await sendOk(u, personal.branchId, 'Paid [topic:math.algebra]', { learn: 'credit' });
    const ownKey = await newTree(u, 'own-key');
    await sendOk(u, ownKey.branchId, 'Mine [topic:math.algebra]', { learn: 'own-key' });
    // A pool send afterwards is tagged, so the background work of the sends before it is done.
    const pooled = await newTree(u);
    await sendOk(u, pooled.branchId, 'Pooled [topic:history.ancient-rome]');
    await taggedAs(pooled.branchId);
    await taggingSettled(u.poolId, 1);

    expect(await tagOf(personal.branchId)).toBeNull();
    expect(await tagOf(ownKey.branchId)).toBeNull();
    const tagging = await taggingRowsOf(u.userId);
    expect(tagging.map((r) => r.branch_id)).toEqual([pooled.branchId]);
    const { results } = await env.DB.prepare(
      "SELECT 1 FROM usage_events WHERE account_id = ? AND purpose = 'tagging'",
    )
      .bind(`u_${u.userId}`)
      .all();
    expect(results).toEqual([]);
  });

  it('classifies only the pool exchange of a mixed branch, never its earlier personal messages', async () => {
    const u = await poolReadyUser();
    await grantCredit(env.DB, {
      accountId: `u_${u.userId}`,
      kind: 'adjustment',
      amountMicros: 1_000_000,
      providerRef: null,
    });
    const { branchId } = await newTree(u, 'credit');
    // `[any-topic:math.algebra]` makes the fake answer math.algebra whenever it is in ANY message
    // sent (and ahead of `[topic:…]`), so if the classifier were sent this earlier personal message
    // the branch would be tagged math.algebra instead of the pool exchange's own topic.
    const markerA = `MARKER-A-${uniq('m')}`;
    await sendOk(u, branchId, `${markerA} [any-topic:math.algebra]`, { learn: 'credit' });
    const poolReply = await sendOk(u, branchId, 'Now on the pool [topic:history.ancient-rome]');
    // Control: the pool chat reply itself is sent the whole branch, so it does see the marker.
    const replyText = poolReply.map((e) => (e.type === 'delta' ? e.text : '')).join('');
    expect(replyText).toBe('math.algebra');
    expect((await taggedAs(branchId)).topic_id).toBe('history.ancient-rome');
  });

  it("sends the classifier the pool exchange's message and the fixed prompt, nothing else", async () => {
    const { account, branchId } = await poolBranch();
    const { requests } = await classify(
      account,
      branchId,
      'Now on the pool [topic:history.ancient-rome]',
      'history.ancient-rome',
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: 'simple',
      system: CLASSIFIER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: 'Now on the pool [topic:history.ancient-rome]' }],
      maxOutputTokens: appConfig(env).impact.classifierMaxOutputTokens,
      usageTag: { purpose: 'tagging', branchId, nodeId: null },
    });
  });

  it('stores no query text anywhere: the tag columns, the consent and usage rows, the logs (spec test)', async () => {
    expect(await columnsOf('pool_topic_tags')).toEqual([
      { name: 'branch_id', type: 'TEXT' },
      { name: 'topic_id', type: 'TEXT' },
      { name: 'branch_depth', type: 'INTEGER' },
      { name: 'created_at', type: 'TEXT' },
    ]);

    const logged: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
    }
    const marker = `SECRET-QUESTION-${uniq('q')}`;
    const u = await poolReadyUser();
    const { branchId } = await newTree(u);
    await sendOk(u, branchId, `${marker} [topic:history.ancient-rome]`);
    await taggedAs(branchId);
    // The direct path too: a valid answer, a rejected one and a refused call.
    const direct = await poolBranch();
    expect((await classify(direct.account, direct.branchId, marker, 'math.algebra')).outcome).toBe(
      'tagged',
    );
    const other = await poolBranch();
    expect((await classify(other.account, other.branchId, marker, `${marker}`)).outcome).toBe(
      'rejected',
    );
    const empty = poolAccount(uniq('pool'));
    expect((await classify(empty, other.branchId, marker, 'math.algebra')).outcome).toBe('failed');
    await taggingSettled(u.poolId, 1);

    for (const table of ['pool_topic_tags', 'pool_consents', 'usage_events'])
      expect(await textOf(table), table).not.toContain(marker);
    expect(logged.join('\n')).not.toContain(marker);
    expect(logged.some((l) => l.includes('"event":"pool_tag"'))).toBe(true);
  });

  it('rejects classifier output that is not a valid leaf topic id: nothing is stored (spec test)', async () => {
    const outputs = [
      'Roman history',
      'history.ancient-rome extra',
      'history.ancient-carthage',
      'history', // a parent: never a tag, so parents are never named because of their children
      SENSITIVE_TOPIC_ID,
      '',
    ];
    for (const output of outputs) {
      const { account, branchId } = await poolBranch();
      const { outcome, requests } = await classify(account, branchId, 'A question', output);
      expect(outcome, output).toBe('rejected');
      expect(requests).toHaveLength(1);
      expect(await tagOf(branchId), output).toBeNull();
    }
    // Surrounding whitespace is not free text.
    const { account, branchId } = await poolBranch();
    expect((await classify(account, branchId, 'A question', '  math.algebra\n')).outcome).toBe(
      'tagged',
    );
    expect(await tagOf(branchId)).toMatchObject({ topic_id: 'math.algebra', branch_depth: 0 });
  });

  it('charges the classification to the pool through reserve and settle; an empty pool skips it quietly', async () => {
    const { account, branchId } = await poolBranch();
    const { outcome } = await classify(account, branchId, 'x'.repeat(10_000), 'math.algebra');
    expect(outcome).toBe('tagged');
    const [row, ...more] = await taggingRowsOf(account.userId!);
    expect(more).toEqual([]);
    expect(row).toMatchObject({
      account_id: account.pool!.accountId,
      funding: 'pool',
      status: 'settled',
      settle_reason: 'cost',
    });
    // Reserved at the worst case of the truncated input (the whole message alone would hold
    // over 10,000 µ$ at the tests' 1 µ$ per token) and the classifier's output cap.
    expect(row!.hold_micros).toBeLessThan(10_000);
    expect(row!.charge_micros).toBeLessThanOrEqual(row!.hold_micros);

    // The branch has its tag: a later exchange is not classified again.
    const again = await classify(account, branchId, 'More', 'math.algebra');
    expect(again).toEqual({ outcome: 'exists', requests: [] });

    // An empty pool refuses the reservation: no call, no row, no tag, no error.
    const broke = poolAccount(uniq('pool'));
    const other = await poolBranch();
    const refused = await classify(broke, other.branchId, 'A question', 'math.algebra');
    expect(refused).toEqual({ outcome: 'failed', requests: [] });
    expect(await tagOf(other.branchId)).toBeNull();
    expect(await taggingRowsOf(broke.userId!)).toEqual([]);
  });

  it('skips accounts the pool does not fund', async () => {
    const { branchId } = await poolBranch();
    const personal = await classify(simpleAccount(), branchId, 'Q', 'math.algebra');
    expect(personal).toEqual({ outcome: 'skipped', requests: [] });
    expect(await tagOf(branchId)).toBeNull();
  });

  it('deletes the user’s consents and the tags of their pool branches with the account', async () => {
    const u = await poolReadyUser();
    const { branchId } = await newTree(u);
    await sendOk(u, branchId, 'Q [topic:math.algebra]');
    await taggedAs(branchId);
    await taggingSettled(u.poolId, 1);
    await deleteUser(env, u.userId);
    expect(await tagOf(branchId)).toBeNull();
    const { results } = await env.DB.prepare('SELECT 1 FROM pool_consents WHERE user_id = ?')
      .bind(u.userId)
      .all();
    expect(results).toEqual([]);
  });
});

describe('the topic taxonomy', () => {
  it('is a two-level tree of well-formed, unique ids; the classifier may answer leaves only', () => {
    const ids = TOPICS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TOPICS) {
      if (t.parent === null) expect(t.id).toMatch(/^[a-z0-9-]+$/);
      else {
        expect(t.id.startsWith(`${t.parent}.`)).toBe(true);
        expect(t.id).toMatch(/^[a-z0-9-]+\.[a-z0-9-]+$/);
        expect(topicById(t.parent)?.parent).toBeNull();
      }
    }
    for (const root of TOPICS.filter((t) => t.parent === null)) {
      expect(isValidLeafTopicId(root.id)).toBe(false);
      expect(TOPICS.some((t) => t.parent === root.id)).toBe(true);
    }
    expect(isValidLeafTopicId('history.ancient-rome')).toBe(true);
    expect(isValidLeafTopicId(' history.ancient-rome')).toBe(false);
    expect(isValidLeafTopicId(SENSITIVE_TOPIC_ID)).toBe(false);
    expect([...LEAF_TOPIC_IDS].every((id) => CLASSIFIER_SYSTEM_PROMPT.includes(id))).toBe(true);
  });

  it('flags the sensitive roots, and every child inherits it', () => {
    const roots = [
      'health',
      'mental-health',
      'sexuality',
      'legal',
      'personal-finance',
      'religious-doubt',
    ];
    expect(
      TOPICS.filter((t) => t.parent === null && t.sensitive)
        .map((t) => t.id)
        .sort(),
    ).toEqual([...roots].sort());
    for (const t of TOPICS) {
      const root = t.parent ?? t.id;
      expect(isSensitive(t.id), t.id).toBe(roots.includes(root));
    }
    expect(isSensitive('health.conditions')).toBe(true);
    expect(isSensitive('mental-health.anxiety')).toBe(true);
    expect(isSensitive('social-sciences.psychology')).toBe(false);
    expect(isSensitive(SENSITIVE_TOPIC_ID)).toBe(true);
  });
});
