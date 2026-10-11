// Publish-time screening (src/share/moderation.ts) against the classifier
// mock (test/mocks/moderation.ts): what is sent, what is refused and how, the
// CSAM path (hold and alert), failing closed, and running without a key.
import type { ApiError, MeResponse, ShareSummary, TreeDetail } from '@tangent/shared';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createD1Repositories } from '../src/db/d1-repositories.js';
import type { AppEnv } from '../src/env.js';
import { OpenAIModeration } from '../src/share/moderation.js';
import { makeNode } from './fixtures.js';
import { ok } from './http.js';
import { MODERATION_ORIGIN } from './mocks/moderation.js';
import { RESEND_ORIGIN } from './mocks/resend.js';
import { authEnv, client } from './session-client.js';

const REFUSED = "This conversation can't be shared.";

let emailSeq = 0;
async function newUser(e: AppEnv) {
  const c = client(e);
  const email = `mod${++emailSeq}-${Math.random().toString(36).slice(2, 8)}@example.org`;
  await c.signIn(email);
  const me = await ok<MeResponse>(await c.call('/api/me'));
  return { ...c, id: me.userId! };
}
type User = Awaited<ReturnType<typeof newUser>>;

/** A tree with one question and one answer. */
async function seedTree(u: User, e: AppEnv, question: string, answer: string): Promise<string> {
  const detail = await ok<TreeDetail>(
    await u.call('/api/trees', { method: 'POST', json: { title: 'Screened' } }, e),
    201,
  );
  const trunk = detail.branches[0]!;
  const q = makeNode(trunk, 0, null, { role: 'user', content: question });
  const a = makeNode(trunk, 1, q.id, { role: 'assistant', content: answer });
  await createD1Repositories(env.DB).trees.appendNodes([q, a], new Date().toISOString());
  return detail.tree.id;
}

/** A unique marker, so a test finds its own requests in the mocks. */
const marker = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}`;

async function classified(contains: string): Promise<string[][]> {
  const res = await fetch(
    `${MODERATION_ORIGIN}/__mock/moderation?contains=${encodeURIComponent(contains)}`,
  );
  return (await res.json()) as string[][];
}

interface ScreenRow {
  share_id: string;
  hold_id: string | null;
  actor: string;
  data: string;
}

async function screenRows(userId: string): Promise<ScreenRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT share_id, hold_id, actor, data FROM audit_events
     WHERE subject_user_id = ? AND kind = 'share_screened' ORDER BY at, rowid`,
  )
    .bind(userId)
    .all<ScreenRow>();
  return results;
}

async function refusal(res: Response): Promise<{ status: number } & ApiError['error']> {
  return { status: res.status, ...((await res.json()) as ApiError).error };
}

const create = (u: User, e: AppEnv, treeId: string, title?: string) =>
  u.call('/api/shares', { method: 'POST', json: { treeId, scope: 'tree', title } }, e);

describe('publish-time screening', () => {
  afterEach(() => vi.restoreAllMocks());

  it("screens the user's and the AI's messages and the titles, and records the scores only", async () => {
    const e = authEnv();
    const user = await newUser(e);
    const q = marker('ASKED');
    const treeId = await seedTree(user, e, q, `${q} ANSWERED`);
    const share = await ok<ShareSummary>(await create(user, e, treeId, `${q} TITLE`), 201);

    const [inputs, ...rest] = await classified(q);
    expect(rest).toEqual([]);
    expect(inputs).toEqual(expect.arrayContaining([q, `${q} ANSWERED`, `${q} TITLE`]));

    const [row] = await screenRows(user.id);
    expect(row).toMatchObject({ share_id: share.id, actor: 'system', hold_id: null });
    expect(JSON.parse(row!.data)).toMatchObject({ trigger: 'create', verdict: 'allow' });
    expect(row!.data).not.toContain(q);
  });

  it('refuses a flagged reply with a generic message and stores nothing', async () => {
    const e = authEnv();
    const user = await newUser(e);
    const treeId = await seedTree(user, e, 'A question', 'An answer [mod-violent]');
    const res = await create(user, e, treeId);
    expect(await refusal(res)).toEqual({ status: 403, code: 'forbidden', message: REFUSED });
    expect(await ok<ShareSummary[]>(await user.call('/api/shares', {}, e))).toEqual([]);

    const [row] = await screenRows(user.id);
    expect(JSON.parse(row!.data)).toMatchObject({ verdict: 'block', reasons: ['violence'] });
  });

  it('screens a new title and a republish, keeping the published snapshot when refused', async () => {
    const e = authEnv();
    const user = await newUser(e);
    const treeId = await seedTree(user, e, 'Fine question', 'Fine answer');
    const share = await ok<ShareSummary>(await create(user, e, treeId), 201);

    const retitle = await user.call(
      `/api/shares/${share.id}`,
      { method: 'PATCH', json: { title: 'Title [mod-violent]' } },
      e,
    );
    expect(await refusal(retitle)).toMatchObject({ status: 403, message: REFUSED });

    const trunk = (await ok<TreeDetail>(await user.call(`/api/trees/${treeId}`, {}, e)))
      .branches[0]!;
    const repos = createD1Repositories(env.DB);
    const nodes = await repos.trees.listNodes(treeId);
    const later = makeNode(trunk, 2, nodes.at(-1)!.id, {
      role: 'user',
      content: 'Later [mod-violent]',
    });
    await repos.trees.appendNodes([later], new Date().toISOString());
    const republish = await user.call(`/api/shares/${share.id}/republish`, { method: 'POST' }, e);
    expect(await refusal(republish)).toMatchObject({ status: 403, message: REFUSED });

    const [after] = await ok<ShareSummary[]>(await user.call('/api/shares', {}, e));
    expect(after).toMatchObject({ version: 1, title: null });
    const page = await client(e).call(`/s/${share.token}`);
    expect(await page.text()).not.toContain('Later');
    expect((await screenRows(user.id)).map((r) => JSON.parse(r.data) as unknown)).toMatchObject([
      { trigger: 'create', verdict: 'allow' },
      { trigger: 'title', verdict: 'block' },
      { trigger: 'republish', verdict: 'block' },
    ]);
  });

  it('holds and alerts on possible CSAM, refusing exactly as for anything else', async () => {
    const legal = `legal-${crypto.randomUUID()}@example.org`;
    const e = authEnv({
      LEGAL_CONTACT_EMAIL: legal,
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test',
      EMAIL_FROM: 'Tangent <alerts@example.com>',
    });
    const user = await newUser(e);
    const q = marker('CSAM-QUESTION');
    const treeId = await seedTree(user, e, `${q} [mod-csam]`, 'An answer');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await refusal(await create(user, e, treeId))).toEqual({
      status: 403,
      code: 'forbidden',
      message: REFUSED,
    });
    expect(await ok<ShareSummary[]>(await user.call('/api/shares', {}, e))).toEqual([]);

    const [row] = await screenRows(user.id);
    expect(JSON.parse(row!.data)).toMatchObject({ trigger: 'create', verdict: 'csam_flag' });
    const hold = await env.DB.prepare('SELECT * FROM legal_holds WHERE id = ?')
      .bind(row!.hold_id)
      .first<{ reason: string; share_id: string; subject_user_id: string }>();
    expect(hold).toMatchObject({
      reason: 'csam',
      share_id: row!.share_id,
      subject_user_id: user.id,
    });
    const { results } = await env.DB.prepare(
      "SELECT data FROM legal_hold_items WHERE hold_id = ? AND kind = 'snapshot' ORDER BY chunk",
    )
      .bind(row!.hold_id)
      .all<{ data: string }>();
    expect(results.map((r) => r.data).join('')).toContain(q);

    const mail = (await (
      await fetch(`${RESEND_ORIGIN}/__mock/emails?to=${encodeURIComponent(legal)}`)
    ).json()) as { text: string; html: string }[];
    expect(mail).toHaveLength(1);
    expect(mail[0]!.text).toContain(row!.share_id);
    expect(mail[0]!.text).toContain(row!.hold_id!);
    expect(mail[0]!.text).toContain(user.id);
    expect(JSON.stringify(mail)).not.toContain(q);
  });

  it('fails closed when the classifier errors or answers something else', async () => {
    const e = authEnv();
    const user = await newUser(e);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const flag of ['[mod-down]', '[mod-garbled]']) {
      const treeId = await seedTree(user, e, `Question ${flag}`, 'Answer');
      expect(await refusal(await create(user, e, treeId))).toEqual({
        status: 502,
        code: 'provider_error',
        message: 'Sharing is temporarily unavailable.',
      });
    }
    const events = error.mock.calls.map(
      (c) => (JSON.parse(String(c[0])) as { event: string }).event,
    );
    expect(events).toEqual(['share_screen_failed', 'share_screen_failed']);
    expect(await ok<ShareSummary[]>(await user.call('/api/shares', {}, e))).toEqual([]);
  });

  it('refuses a conversation too long to screen', async () => {
    const e = authEnv();
    const user = await newUser(e);
    const treeId = await seedTree(user, e, 'x'.repeat(400_001), 'Answer');
    expect(await refusal(await create(user, e, treeId))).toMatchObject({
      status: 400,
      message: 'This conversation is too long to share; share a part of it.',
    });
  });
});

describe('without a classifier', () => {
  afterEach(() => vi.restoreAllMocks());

  it('treats SHARING=everyone as allowlist, and lets admins publish unscreened', async () => {
    const signup = authEnv();
    const admin = await newUser(signup);
    const user = await newUser(signup);
    const e = authEnv({ MODERATION_API_KEY: '', ADMIN_USER_IDS: admin.id });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect((await ok<MeResponse>(await user.call('/api/me', {}, e))).sharing).toBe(false);
    const q = marker('UNSCREENED');
    const userTree = await seedTree(user, e, q, 'Answer');
    expect((await create(user, e, userTree)).status).toBe(403);
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
      '{"event":"sharing_moderation_missing"}',
    );

    const adminTree = await seedTree(admin, e, q, 'Answer');
    await ok<ShareSummary>(await create(admin, e, adminTree), 201);
    expect(await classified(q)).toEqual([]);
    expect(await screenRows(admin.id)).toEqual([]);
  });
});

describe('OpenAIModeration', () => {
  it('sends the inputs with the key and gives up after its timeout', async () => {
    const seen: RequestInit[] = [];
    const provider = new OpenAIModeration({
      apiKey: 'mod-key',
      timeoutMs: 10,
      fetch: (_url, init) => {
        seen.push(init!);
        return new Promise((_, reject) =>
          init!.signal!.addEventListener('abort', () => reject(new Error('timed out'))),
        );
      },
    });
    await expect(provider.classify(['a', 'b'])).rejects.toThrow('timed out');
    expect(new Headers(seen[0]!.headers).get('authorization')).toBe('Bearer mod-key');
    expect((JSON.parse(String(seen[0]!.body)) as { input: string[] }).input).toEqual(['a', 'b']);
  });
});
