import {
  DEFAULT_ACCOUNT_ID,
  MODE_HEADER,
  PAYMENT_HEADER,
  type MeResponse,
  type TreeDetail,
} from '@tangent/shared';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  accountRequest,
  DEV_SIMPLE_ACCOUNT_ID,
  resolveAccount,
  type AccountRequest,
} from '../src/auth/account.js';
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
  const withEnv = (overrides: Partial<AppEnv> = {}) =>
    ({ ...env, ...overrides }) as AppEnv;
  const user = (email: string) => ({ userId: 'usr1', email, devMode: false });
  const dev = { userId: null, email: null, devMode: true };
  const power: AccountRequest = { mode: 'power', payment: 'own-key' };
  const learn = (payment: AccountRequest['payment']): AccountRequest => ({ mode: 'simple', payment });

  it('dev bypass: the default account for power, default_simple for Learn', () => {
    expect(resolveAccount(withEnv(), dev, power)).toEqual({
      id: DEFAULT_ACCOUNT_ID,
      mode: 'power',
      userId: null,
      operatorKeys: true,
    });
    expect(resolveAccount(withEnv(), dev, learn('own-key'))).toEqual({
      id: DEV_SIMPLE_ACCOUNT_ID,
      mode: 'simple',
      userId: null,
      operatorKeys: false,
    });
  });

  it('every user gets p_<userId> for power and u_<userId> for Learn', () => {
    expect(resolveAccount(withEnv(), user('someone@example.org'), power)).toEqual({
      id: 'p_usr1',
      mode: 'power',
      userId: 'usr1',
      operatorKeys: false,
    });
    expect(resolveAccount(withEnv(), user('someone@example.org'), learn('own-key'))).toEqual({
      id: 'u_usr1',
      mode: 'simple',
      userId: 'usr1',
      operatorKeys: false,
    });
  });

  it('power mode never gets the server keys for a signed-in user, only the dev bypass', () => {
    expect(resolveAccount(withEnv(), user('owner@example.com'), power).operatorKeys).toBe(false);
    expect(resolveAccount(withEnv(), dev, power).operatorKeys).toBe(true);
  });

  it('Learn is on paid credit only when asked for and offered', () => {
    expect(resolveAccount(withEnv(), user('a@example.org'), learn('credit')).operatorKeys).toBe(true);
    for (const off of [{ STRIPE_SECRET_KEY: '' }, { STRIPE_WEBHOOK_SECRET: '' }]) {
      expect(
        resolveAccount(withEnv(off), user('a@example.org'), learn('credit')).operatorKeys,
      ).toBe(false);
    }
    // Without the operator's OpenRouter key there is nothing to sell.
    const realProvider = withEnv({ SIMPLE_PROVIDER: '', OPENROUTER_SIMPLE_API_KEY: '' });
    expect(resolveAccount(realProvider, user('a@example.org'), learn('credit')).operatorKeys).toBe(
      false,
    );
    expect(
      resolveAccount(
        { ...realProvider, OPENROUTER_SIMPLE_API_KEY: 'sk-or-operator' } as AppEnv,
        user('a@example.org'),
        learn('credit'),
      ).operatorKeys,
    ).toBe(true);
  });

  it('reads the mode and payment headers, defaulting to power and own-key', () => {
    expect(accountRequest(new Headers())).toEqual({ mode: 'power', payment: 'own-key' });
    expect(
      accountRequest(new Headers({ [MODE_HEADER]: 'simple', [PAYMENT_HEADER]: 'credit' })),
    ).toEqual({ mode: 'simple', payment: 'credit' });
    expect(
      accountRequest(new Headers({ [MODE_HEADER]: 'Simple', [PAYMENT_HEADER]: 'free' })),
    ).toEqual({ mode: 'power', payment: 'own-key' });
  });
});
