// Reports from a share page (src/http/report-page.tsx, src/share/reports.ts):
// the form, what a report stores and records, and what it sets off at once
// (taking the link down, a legal hold, an alert), without telling the owner why.
import type { MeResponse, ShareSummary, TreeDetail } from '@tangent/shared';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { createD1Repositories } from '../src/db/d1-repositories.js';
import type { AppEnv } from '../src/env.js';
import { makeNode } from './fixtures.js';
import { BASE, ok } from './http.js';
import { RESEND_ORIGIN } from './mocks/resend.js';
import { authEnv, client } from './session-client.js';

function reportEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return authEnv({ SHARING: 'everyone', SHARE_MIN_ACCOUNT_AGE_MS: '0', ...overrides });
}

let emailSeq = 0;
async function newUser(e: AppEnv) {
  const c = client(e);
  const email = `report${++emailSeq}-${Math.random().toString(36).slice(2, 8)}@example.org`;
  await c.signIn(email);
  const me = await ok<MeResponse>(await c.call('/api/me'));
  return { ...c, id: me.userId! };
}
type User = Awaited<ReturnType<typeof newUser>>;

/** A user's link to a two-message conversation whose question holds `marker`. */
async function publish(e: AppEnv, marker = 'REPORTED-QUESTION') {
  const owner = await newUser(e);
  const detail = await ok<TreeDetail>(
    await owner.call('/api/trees', { method: 'POST', json: { title: 'Shared' } }),
    201,
  );
  const trunk = detail.branches[0]!;
  const q = makeNode(trunk, 0, null, { role: 'user', content: marker });
  const a = makeNode(trunk, 1, q.id, { role: 'assistant', content: 'An answer' });
  await createD1Repositories(env.DB).trees.appendNodes([q, a], new Date().toISOString());
  const share = await ok<ShareSummary>(
    await owner.call(
      '/api/shares',
      { method: 'POST', json: { treeId: detail.tree.id, scope: 'tree' } },
      e,
    ),
    201,
  );
  return { owner, share };
}

interface ReportFields {
  category?: string;
  details?: string;
  email?: string;
  'cf-turnstile-response'?: string;
}

function postReport(
  reporter: ReturnType<typeof client> | User,
  token: string,
  fields: ReportFields,
  headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' },
) {
  return reporter.call(`/s/${token}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, ...headers },
    body: new URLSearchParams({ 'cf-turnstile-response': 'pass', ...fields }).toString(),
  });
}

interface ReportRow {
  id: string;
  share_id: string;
  share_token: string;
  owner_account_id: string;
  category: string;
  details: string;
  reporter_email: string | null;
  reporter_key: string | null;
  reporter_user_id: string | null;
  resolution: string;
}

async function reportsOf(shareId: string): Promise<ReportRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM share_reports WHERE share_id = ? ORDER BY created_at, rowid',
  )
    .bind(shareId)
    .all<ReportRow>();
  return results;
}

async function auditOf(shareId: string) {
  const { results } = await env.DB.prepare(
    `SELECT kind, actor, actor_user_id, subject_user_id, report_id, data
     FROM audit_events WHERE share_id = ? AND kind IN ('report_received', 'share_takedown')
     ORDER BY at, rowid`,
  )
    .bind(shareId)
    .all<{
      kind: string;
      actor: string;
      actor_user_id: string | null;
      subject_user_id: string | null;
      report_id: string | null;
      data: string;
    }>();
  return results;
}

async function takedownOf(shareId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT takedown FROM shares WHERE id = ?')
    .bind(shareId)
    .first<{ takedown: string | null }>();
  return row?.takedown ?? null;
}

describe('the report form', () => {
  it('is linked from the share page, kept out of search, and shows Turnstile', async () => {
    const e = reportEnv();
    const { share } = await publish(e);
    const anon = client(e);
    const viewer = await (await anon.call(`/s/${share.token}`)).text();
    expect(viewer).toContain(`href="${BASE}/s/${share.token}/report"`);

    const res = await anon.call(`/s/${share.token}/report`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('content-security-policy')).toContain("form-action 'self'");
    const html = await res.text();
    expect(html).toContain('<meta name="robots" content="noindex"');
    expect(html).toContain(`action="/s/${share.token}/report"`);
    expect(html).toContain('data-action="share-report"');
    expect(html).toContain('name="details"');
    expect(html).not.toContain('REPORTED-QUESTION');
  });

  it('answers for an unknown, revoked or taken-down link as for a gone one', async () => {
    const e = reportEnv();
    const { owner, share } = await publish(e);
    const anon = client(e);
    const gone = async (token: string) => {
      const page = await anon.call(`/s/${token}/report`);
      const post = await postReport(anon, token, { category: 'other', details: 'x' });
      return [page.status, post.status, await page.text()] as const;
    };
    const [status, postStatus, unknownPage] = await gone('no-such-token');
    expect([status, postStatus]).toEqual([410, 410]);

    await env.DB.prepare("UPDATE shares SET takedown = 'removed' WHERE id = ?")
      .bind(share.id)
      .run();
    expect(await gone(share.token)).toEqual([410, 410, unknownPage]);
    await env.DB.prepare('UPDATE shares SET takedown = NULL WHERE id = ?').bind(share.id).run();
    await ok(await owner.call(`/api/shares/${share.id}/revoke`, { method: 'POST' }, e));
    expect(await gone(share.token)).toEqual([410, 410, unknownPage]);
    expect(await reportsOf(share.id)).toEqual([]);
  });

  it('refuses a cross-origin post, a failed check and bad fields, storing nothing', async () => {
    const e = reportEnv();
    const { share } = await publish(e);
    const anon = client(e);
    const cross = await postReport(
      anon,
      share.token,
      { category: 'other', details: 'x' },
      { 'sec-fetch-site': 'cross-site' },
    );
    expect(cross.status).toBe(403);

    const refused = async (fields: ReportFields) => {
      const res = await postReport(anon, share.token, fields);
      expect(res.status).toBe(400);
      return /role="alert">([^<]*)</.exec(await res.text())?.[1];
    };
    expect(await refused({ category: 'other', details: 'x', 'cf-turnstile-response': 'no' })).toBe(
      'That check didn’t go through. Please try again.',
    );
    expect(await refused({ details: 'x' })).toContain('Choose');
    expect(await refused({ category: 'spam', details: 'x' })).toContain('Choose');
    expect(await refused({ category: 'other', details: '   ' })).toContain('Say what is wrong');
    expect(await refused({ category: 'other', details: 'x'.repeat(4001) })).toContain('4,000');
    expect(await refused({ category: 'other', details: 'x', email: 'not-an-email' })).toContain(
      'email',
    );
    // The form keeps what was typed.
    const res = await postReport(anon, share.token, { details: 'KEEP-THIS', email: 'a@b.org' });
    const html = await res.text();
    expect(html).toContain('KEEP-THIS');
    expect(html).toContain('value="a@b.org"');
    expect(await reportsOf(share.id)).toEqual([]);
  });
});

describe('filing a report', () => {
  it('stores the report and audits it without its text; "other" leaves the link up', async () => {
    const e = reportEnv();
    const { owner, share } = await publish(e);
    const anon = client(e);
    const res = await postReport(anon, share.token, {
      category: 'other',
      details: 'REPORT-DETAILS',
      email: ' reporter@example.org ',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('received your report');

    const [report, ...more] = await reportsOf(share.id);
    expect(more).toEqual([]);
    expect(report).toMatchObject({
      share_token: share.token,
      owner_account_id: share.accountId,
      category: 'other',
      details: 'REPORT-DETAILS',
      reporter_email: 'reporter@example.org',
      reporter_user_id: null,
      resolution: 'pending',
    });
    expect(report!.reporter_key).toMatch(/^n:[0-9a-f]{16}$/);
    const audit = await auditOf(share.id);
    expect(audit).toEqual([
      {
        kind: 'report_received',
        actor: 'reporter',
        actor_user_id: null,
        subject_user_id: owner.id,
        report_id: report!.id,
        data: JSON.stringify({ category: 'other' }),
      },
    ]);
    expect(await takedownOf(share.id)).toBeNull();
    expect((await anon.call(`/s/${share.token}`)).status).toBe(200);
  });

  it('takes a copyright report down for review; the owner sees only "unavailable" and can only delete', async () => {
    const e = reportEnv();
    const { owner, share } = await publish(e);
    const anon = client(e);
    expect((await anon.call(`/s/${share.token}`)).status).toBe(200);
    const signedIn = await newUser(e);
    expect(
      (await postReport(signedIn, share.token, { category: 'copyright', details: 'Mine' })).status,
    ).toBe(200);

    const [report] = await reportsOf(share.id);
    expect(report).toMatchObject({
      reporter_user_id: signedIn.id,
      reporter_key: `u:${signedIn.id}`,
    });
    expect(await takedownOf(share.id)).toBe('pending_review');
    const audit = await auditOf(share.id);
    expect(audit.map((r) => [r.kind, r.actor, r.actor_user_id, r.report_id])).toEqual([
      ['report_received', 'reporter', signedIn.id, report!.id],
      ['share_takedown', 'system', null, report!.id],
    ]);
    expect(JSON.parse(audit[1]!.data)).toEqual({ takedown: 'pending_review', version: 1 });

    const page = await anon.call(`/s/${share.token}`);
    expect(page.status).toBe(410);
    expect(await page.text()).not.toContain('REPORTED-QUESTION');
    expect((await anon.call(`/s/${share.token}/data.json`)).status).toBe(410);

    const listed = await ok<ShareSummary[]>(await owner.call('/api/shares', {}, e));
    expect(listed).toEqual([expect.objectContaining({ id: share.id, state: 'unavailable' })]);
    const body = JSON.stringify(listed);
    expect(body).not.toContain('takedown');
    expect(body).not.toContain('pending_review');
    expect(body).not.toContain('copyright');
    const republish = await owner.call(`/api/shares/${share.id}/republish`, { method: 'POST' }, e);
    expect(republish.status).toBe(410);
    expect(JSON.stringify(await republish.json())).not.toContain('report');
    const edit = await owner.call(
      `/api/shares/${share.id}`,
      { method: 'PATCH', json: { title: 'Back up' } },
      e,
    );
    expect(edit.status).toBe(410);
    expect((await owner.call(`/api/shares/${share.id}`, { method: 'DELETE' }, e)).status).toBe(204);
    // The report outlives the share.
    expect(await reportsOf(share.id)).toHaveLength(1);
  });

  it('takes defamation down once two different reporters agree', async () => {
    const e = reportEnv();
    const { share } = await publish(e);
    const first = client(e, { ip: '203.0.113.7' });
    const same = client(e, { ip: '203.0.113.7' });
    const report = (c: ReturnType<typeof client>, category = 'defamation') =>
      postReport(c, share.token, { category, details: 'False claims' });

    expect((await report(first)).status).toBe(200);
    expect((await report(same)).status).toBe(200);
    expect((await report(client(e), 'other')).status).toBe(200);
    expect(await takedownOf(share.id)).toBeNull();

    expect((await report(client(e, { ip: '203.0.113.8' }), 'harassment_privacy')).status).toBe(200);
    expect(await takedownOf(share.id)).toBe('pending_review');
    expect((await auditOf(share.id)).filter((r) => r.kind === 'share_takedown')).toHaveLength(1);
  });

  it('holds and alerts on a CSAM report, without the content or the reporter in the alert', async () => {
    const legal = `legal-${crypto.randomUUID()}@example.org`;
    const e = reportEnv({
      LEGAL_CONTACT_EMAIL: legal,
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test',
      EMAIL_FROM: 'Tangent <alerts@example.com>',
    });
    const marker = `CSAM-REPORTED-${crypto.randomUUID().slice(0, 8)}`;
    const { owner, share } = await publish(e, marker);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await postReport(client(e), share.token, {
      category: 'csam',
      details: 'REPORTER-TEXT',
      email: 'witness@example.org',
    });
    expect(res.status).toBe(200);
    vi.restoreAllMocks();

    const [report] = await reportsOf(share.id);
    expect(await takedownOf(share.id)).toBe('pending_review');
    const hold = await env.DB.prepare('SELECT * FROM legal_holds WHERE report_id = ?')
      .bind(report!.id)
      .first<{ id: string; reason: string; share_id: string; subject_user_id: string }>();
    expect(hold).toMatchObject({ reason: 'csam', share_id: share.id, subject_user_id: owner.id });
    const { results } = await env.DB.prepare(
      "SELECT data FROM legal_hold_items WHERE hold_id = ? AND kind = 'snapshot' ORDER BY chunk",
    )
      .bind(hold!.id)
      .all<{ data: string }>();
    expect(results.map((r) => r.data).join('')).toContain(marker);

    const mail = (await (
      await fetch(`${RESEND_ORIGIN}/__mock/emails?to=${encodeURIComponent(legal)}`)
    ).json()) as { subject: string; text: string }[];
    expect(mail).toHaveLength(1);
    expect(mail[0]!.text).toContain(report!.id);
    expect(mail[0]!.text).toContain(hold!.id);
    const sent = JSON.stringify(mail);
    expect(sent).not.toContain(marker);
    expect(sent).not.toContain('REPORTER-TEXT');
    expect(sent).not.toContain('witness@example.org');
  });

  it('holds and alerts on a violent or illegal report too', async () => {
    const legal = `legal-${crypto.randomUUID()}@example.org`;
    const e = reportEnv({
      LEGAL_CONTACT_EMAIL: legal,
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test',
      EMAIL_FROM: 'Tangent <alerts@example.com>',
    });
    const { share } = await publish(e);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await postReport(client(e), share.token, { category: 'violent_or_illegal', details: 'Threat' });
    vi.restoreAllMocks();

    expect(await takedownOf(share.id)).toBe('pending_review');
    const hold = await env.DB.prepare('SELECT reason FROM legal_holds WHERE share_id = ?')
      .bind(share.id)
      .first<{ reason: string }>();
    expect(hold?.reason).toBe('violent_or_illegal');
    const mail = (await (
      await fetch(`${RESEND_ORIGIN}/__mock/emails?to=${encodeURIComponent(legal)}`)
    ).json()) as { subject: string }[];
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toContain('violent or illegal');
  });
});
