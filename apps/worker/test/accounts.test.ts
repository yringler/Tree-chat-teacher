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
import { creditRegistryFor, providerConfigs, providersFor, registryFor } from '../src/services.js';

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
    const list = (await (await exports.default.fetch(`${BASE}/api/trees`)).json()) as {
      id: string;
    }[];
    expect(list.some((t) => t.id === 'foreign-tree')).toBe(false);
    expect((await exports.default.fetch(`${BASE}/api/trees/foreign-tree`)).status).toBe(404);
  });
});

describe('resolveAccount', () => {
  const withEnv = (overrides: Partial<AppEnv> = {}) => ({ ...env, ...overrides }) as AppEnv;
  const user = (email: string) => ({ userId: 'usr1', email, devMode: false });
  const dev = { userId: null, email: null, devMode: true };
  const power: AccountRequest = { mode: 'power', payment: 'own-key' };
  const learn = (payment: AccountRequest['payment']): AccountRequest => ({
    mode: 'simple',
    payment,
  });

  it('dev bypass: the default account for power, default_simple for Learn', () => {
    expect(resolveAccount(withEnv(), dev, power)).toEqual({
      id: DEFAULT_ACCOUNT_ID,
      mode: 'power',
      userId: null,
      billingAccountId: DEV_SIMPLE_ACCOUNT_ID,
      builtIn: true,
      operatorKeys: true,
      funding: 'personal',
    });
    expect(resolveAccount(withEnv(), dev, learn('own-key'))).toEqual({
      id: DEV_SIMPLE_ACCOUNT_ID,
      mode: 'simple',
      userId: null,
      billingAccountId: DEV_SIMPLE_ACCOUNT_ID,
      builtIn: false,
      operatorKeys: false,
      funding: 'own-key',
    });
  });

  it('every user gets p_<userId> for power and u_<userId> for Learn, one ledger u_<userId>', () => {
    expect(resolveAccount(withEnv(), user('someone@example.org'), power)).toEqual({
      id: 'p_usr1',
      mode: 'power',
      userId: 'usr1',
      billingAccountId: 'u_usr1',
      builtIn: true,
      operatorKeys: false,
      funding: 'personal',
    });
    expect(resolveAccount(withEnv(), user('someone@example.org'), learn('own-key'))).toEqual({
      id: 'u_usr1',
      mode: 'simple',
      userId: 'usr1',
      billingAccountId: 'u_usr1',
      builtIn: false,
      operatorKeys: false,
      funding: 'own-key',
    });
  });

  it('power mode never gets the server keys for a signed-in user, only the dev bypass', () => {
    expect(resolveAccount(withEnv(), user('owner@example.com'), power).operatorKeys).toBe(false);
    expect(resolveAccount(withEnv(), dev, power).operatorKeys).toBe(true);
    expect(resolveAccount(withEnv(), user('a@example.org'), learn('credit')).operatorKeys).toBe(
      false,
    );
  });

  it('Learn is on the built-in provider only when asked for and offered', () => {
    expect(resolveAccount(withEnv(), user('a@example.org'), learn('credit')).builtIn).toBe(true);
    for (const off of [{ PAYMENT_PROVIDER: 'polar' }]) {
      expect(resolveAccount(withEnv(off), user('a@example.org'), learn('credit')).builtIn).toBe(
        false,
      );
    }
    // Without the operator's OpenRouter key there is nothing to sell.
    const realProvider = withEnv({ SIMPLE_PROVIDER: '', OPENROUTER_SIMPLE_API_KEY: '' });
    expect(resolveAccount(realProvider, user('a@example.org'), learn('credit')).builtIn).toBe(
      false,
    );
    expect(
      resolveAccount(
        { ...realProvider, OPENROUTER_SIMPLE_API_KEY: 'sk-or-operator' } as AppEnv,
        user('a@example.org'),
        learn('credit'),
      ).builtIn,
    ).toBe(true);
  });

  it('Learn on the pool: pool-funded while the pool is on, for signed-in users only', () => {
    const pooled = resolveAccount(withEnv(), user('a@example.org'), learn('pool'));
    expect(pooled).toMatchObject({ mode: 'simple', funding: 'pool', builtIn: true });
    // Off, or the dev bypass (no user to cap): pool funding, but nothing to spend.
    for (const [e, who] of [
      [withEnv({ POOL_ENABLED: 'false' }), user('a@example.org')],
      [withEnv(), dev],
    ] as const) {
      expect(resolveAccount(e, who, learn('pool'))).toMatchObject({
        funding: 'pool',
        builtIn: false,
      });
    }
    // Credit is personal where it is offered, else the user's own key.
    expect(resolveAccount(withEnv(), user('a@example.org'), learn('credit')).funding).toBe(
      'personal',
    );
    expect(
      resolveAccount(withEnv({ PAYMENT_PROVIDER: 'polar' }), user('a@example.org'), learn('credit'))
        .funding,
    ).toBe('own-key');
    // PERSONAL_CREDIT_ENABLED offers credit before payments are configured.
    expect(
      resolveAccount(
        withEnv({ PAYMENT_PROVIDER: 'polar', PERSONAL_CREDIT_ENABLED: 'true' }),
        user('a@example.org'),
        learn('credit'),
      ),
    ).toMatchObject({ funding: 'personal', builtIn: true });
  });

  it('power never uses the pool, whatever the payment header', () => {
    const pool: AccountRequest = { mode: 'power', payment: 'pool' };
    expect(resolveAccount(withEnv(), user('a@example.org'), pool)).toMatchObject({
      mode: 'power',
      funding: 'personal',
    });
  });

  it('power has the built-in provider whenever it is offered, whatever the payment header', () => {
    const credit: AccountRequest = { mode: 'power', payment: 'credit' };
    expect(resolveAccount(withEnv(), user('a@example.org'), power).builtIn).toBe(true);
    expect(resolveAccount(withEnv(), user('a@example.org'), credit).builtIn).toBe(true);
    expect(
      resolveAccount(withEnv({ PAYMENT_PROVIDER: 'polar' }), user('a@example.org'), power).builtIn,
    ).toBe(false);
    const realProvider = withEnv({ SIMPLE_PROVIDER: '', OPENROUTER_SIMPLE_API_KEY: '' });
    expect(resolveAccount(realProvider, user('a@example.org'), power).builtIn).toBe(false);
  });

  it('reads the mode and payment headers, defaulting to power and own-key', () => {
    expect(accountRequest(new Headers())).toEqual({ mode: 'power', payment: 'own-key' });
    expect(
      accountRequest(new Headers({ [MODE_HEADER]: 'simple', [PAYMENT_HEADER]: 'credit' })),
    ).toEqual({ mode: 'simple', payment: 'credit' });
    expect(
      accountRequest(new Headers({ [MODE_HEADER]: 'Simple', [PAYMENT_HEADER]: 'free' })),
    ).toEqual({ mode: 'power', payment: 'own-key' });
    expect(
      accountRequest(new Headers({ [MODE_HEADER]: 'simple', [PAYMENT_HEADER]: 'pool' })),
    ).toEqual({ mode: 'simple', payment: 'pool' });
  });
});

describe('power provider configs', () => {
  const withEnv = (overrides: Partial<AppEnv> = {}) => ({ ...env, ...overrides }) as AppEnv;

  it('the default OpenRouter config lists the suggested models first and takes any model', () => {
    const openrouter = providerConfigs(
      withEnv({
        PROVIDERS: '',
        SIMPLE_NORMAL_MODEL: 'a/normal',
        SIMPLE_MAX_MODEL: 'b/max',
        SIMPLE_FAST_MODEL: 'c/fast',
      }),
    ).find((c) => c.id === 'openrouter')!;
    expect(openrouter.openModels).toBe(true);
    expect(openrouter.defaultModel).toBe('a/normal');
    expect(openrouter.models.slice(0, 2)).toEqual([
      { id: 'a/normal', label: 'Normal (suggested)', tier: 'normal' },
      { id: 'b/max', label: 'Max (suggested)', tier: 'max' },
    ]);
    // The background model is no tier, so it isn't suggested.
    expect(openrouter.models.some((m) => m.id === 'c/fast')).toBe(false);
    // The previous entries are kept after them.
    expect(openrouter.models.length).toBeGreaterThan(2);
  });

  it("the operator's PROVIDERS rule, and may not claim the legacy built-in id", () => {
    expect(providerConfigs(withEnv()).some((c) => c.openModels)).toBe(false);
    const claim = JSON.stringify([
      { id: 'tangent', kind: 'fake', label: 'Mine', defaultModel: 'x', models: [] },
    ]);
    expect(() => providerConfigs(withEnv({ PROVIDERS: claim }))).toThrow(/reserved id "tangent"/);
  });

  it('Tangent credit takes the operator key only, never a user key, in a registry of its own', () => {
    const account = resolveAccount(
      withEnv(),
      { userId: 'usr2', email: 'b@example.org', devMode: false },
      { mode: 'power', payment: 'own-key' },
    );
    const keys = { openrouter: 'sk-user', tangent: 'sk-user', ant: 'sk-ant-good' };
    const credit = creditRegistryFor(withEnv(), account)!;
    expect(credit.list()).toEqual([
      expect.objectContaining({ id: 'openrouter', available: true, acceptsUserKey: false }),
    ]);
    // The own-key registry never holds the operator's endpoint: only the configured providers.
    const own = registryFor(withEnv(), account, keys);
    expect(own.list().map((p) => p.id)).toEqual(['fake', 'slow', 'ant']);
    expect(own.list().find((p) => p.id === 'ant')?.keySource).toBe('user');
    expect(providersFor(withEnv(), account, keys).at(-1)).toMatchObject({
      id: 'openrouter',
      funding: 'credit',
      acceptsUserKey: false,
    });
    expect(creditRegistryFor(withEnv(), { ...account, builtIn: false })).toBeNull();
    // Learn has one registry for every funding; it never has a credit registry.
    expect(creditRegistryFor(withEnv(), { ...account, mode: 'simple' })).toBeNull();
  });
});
