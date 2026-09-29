import { DEFAULT_ACCOUNT_ID, type MeResponse, type TreeDetail } from '@tangent/shared';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const BASE = 'https://tangent.example.com';

describe('accounts (single-user default)', () => {
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
