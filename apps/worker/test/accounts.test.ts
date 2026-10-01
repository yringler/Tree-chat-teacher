import { DEFAULT_ACCOUNT_ID, type MeResponse, type TreeDetail } from '@tangent/shared';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { resolveAccount } from '../src/auth/account.js';
import type { AppEnv } from '../src/env.js';

const BASE = 'https://tangent.example.com';

describe('accounts (dev bypass: the default account)', () => {
  it('migration seeds the built-in default account', async () => {
    const row = await env.DB.prepare('SELECT id, name FROM accounts WHERE id = ?1')
      .bind(DEFAULT_ACCOUNT_ID)
      .first<{ id: string; name: string }>();
    expect(row).toEqual({ id: DEFAULT_ACCOUNT_ID, name: 'Default account' });
  });

  it('/api/me reports the account and new rows are stamped with it', async () => {
    const me = (await (await exports.default.fetch(`${BASE}/api/me`)).json()) as MeResponse;
    expect(me.accountId).toBe(DEFAULT_ACCOUNT_ID);

    const res = await exports.default.fetch(
      new Request(`${BASE}/api/trees`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Owned' }),
      }),
    );
    const detail = (await res.json()) as TreeDetail;
    expect(detail.tree.accountId).toBe(DEFAULT_ACCOUNT_ID);
    const row = await env.DB.prepare('SELECT account_id FROM trees WHERE id = ?1')
      .bind(detail.tree.id)
      .first<{ account_id: string }>();
    expect(row?.account_id).toBe(DEFAULT_ACCOUNT_ID);
  });

  it('trees owned by another account are invisible and 404', async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO trees (id, account_id, title, trunk_branch_id, created_at, updated_at)
         VALUES ('foreign-tree', 'someone-else', 'Not yours', 'foreign-trunk', 'x', 'x')`,
      ),
    ]);
    const list = (await (await exports.default.fetch(`${BASE}/api/trees`)).json()) as { id: string }[];
    expect(list.some((t) => t.id === 'foreign-tree')).toBe(false);
    expect((await exports.default.fetch(`${BASE}/api/trees/foreign-tree`)).status).toBe(404);
  });
});

describe('resolveAccount', () => {
  const withEnv = (overrides: Partial<AppEnv>) => ({ ...env, ALLOWED_EMAILS: 'owner@example.com', ...overrides }) as AppEnv;
  const user = (email: string) => ({ userId: 'usr1', email, devMode: false });

  it('dev bypass and allowlisted emails act as the shared default power account', () => {
    expect(resolveAccount(withEnv({}), { userId: null, email: null, devMode: true })).toEqual({
      id: DEFAULT_ACCOUNT_ID,
      mode: 'power',
      userId: null,
    });
    for (const open of ['true', 'false']) {
      expect(resolveAccount(withEnv({ OPEN_SIGNUP: open }), user('Owner@example.com'))).toEqual({
        id: DEFAULT_ACCOUNT_ID,
        mode: 'power',
        userId: 'usr1',
      });
    }
  });

  it('other users get a personal simple account only while OPEN_SIGNUP=true', () => {
    expect(resolveAccount(withEnv({ OPEN_SIGNUP: 'true' }), user('someone@example.org'))).toEqual({
      id: 'u_usr1',
      mode: 'simple',
      userId: 'usr1',
    });
    for (const open of ['false', '', 'TRUE', '1']) {
      expect(() => resolveAccount(withEnv({ OPEN_SIGNUP: open }), user('someone@example.org'))).toThrow(
        expect.objectContaining({ code: 'forbidden' }),
      );
    }
  });
});
