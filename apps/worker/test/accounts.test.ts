import {
  MODE_HEADER,
  PAYMENT_HEADER,
  type MeResponse,
  type ProviderConfig,
  type TreeDetail,
} from '@tangent/shared';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  accountRequest,
  DEV_ACCOUNT_ID,
  resolveAccount,
  withPoolParams,
  type AccountRequest,
} from '../src/auth/account.js';
import { callPayer, isPoolFunded, type AppEnv, type Identity } from '../src/env.js';
import { providerConfigs, providerEnv } from '../src/provider-configs.js';
import { creditRegistryFor, providersFor, registryFor } from '../src/registries.js';
import { BASE } from './http.js';
import { devPowerAccount } from './mocks/billing-helpers.js';

describe('accounts (dev bypass: one account)', () => {
  it('/api/me reports the account and new rows are stamped with it', async () => {
    const me = (await (await exports.default.fetch(`${BASE}/api/me`)).json()) as MeResponse;
    expect(me.accountId).toBe(DEV_ACCOUNT_ID);

    const res = await exports.default.fetch(
      new Request(`${BASE}/api/trees`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Owned' }),
      }),
    );
    const detail = (await res.json()) as TreeDetail;
    expect(detail.tree.accountId).toBe(DEV_ACCOUNT_ID);
    const row = await env.DB.prepare('SELECT account_id FROM trees WHERE id = ?1')
      .bind(detail.tree.id)
      .first<{ account_id: string }>();
    expect(row?.account_id).toBe(DEV_ACCOUNT_ID);
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

  it('dev bypass: default_simple in every mode', () => {
    expect(resolveAccount(withEnv(), dev, power)).toEqual({
      id: DEV_ACCOUNT_ID,
      mode: 'power',
      userId: null,
      billingAccountId: DEV_ACCOUNT_ID,
      creditOffered: true,
      operatorKeys: true,
    });
    expect(resolveAccount(withEnv(), dev, learn('own-key'))).toEqual({
      id: DEV_ACCOUNT_ID,
      mode: 'simple',
      userId: null,
      billingAccountId: DEV_ACCOUNT_ID,
      payer: 'own-key',
    });
  });

  it('every user gets one account u_<userId> in every mode, also their ledger', () => {
    expect(resolveAccount(withEnv(), user('someone@example.org'), power)).toEqual({
      id: 'u_usr1',
      mode: 'power',
      userId: 'usr1',
      billingAccountId: 'u_usr1',
      creditOffered: true,
      operatorKeys: false,
    });
    expect(resolveAccount(withEnv(), user('someone@example.org'), learn('own-key'))).toEqual({
      id: 'u_usr1',
      mode: 'simple',
      userId: 'usr1',
      billingAccountId: 'u_usr1',
      payer: 'own-key',
    });
  });

  it('power mode never gets the server keys for a signed-in user, only the dev bypass', () => {
    expect(resolveAccount(withEnv(), user('owner@example.com'), power)).toMatchObject({
      operatorKeys: false,
    });
    expect(resolveAccount(withEnv(), dev, power)).toMatchObject({ operatorKeys: true });
    // Learn has no server keys at all.
    expect(resolveAccount(withEnv(), dev, learn('credit'))).not.toHaveProperty('operatorKeys');
  });

  it('Learn is on credit only when asked for and offered, else on its own key', () => {
    const onCredit = (e: AppEnv) => resolveAccount(e, user('a@example.org'), learn('credit'));
    expect(onCredit(withEnv())).toMatchObject({ payer: 'credit' });
    expect(onCredit(withEnv({ PAYMENT_PROVIDER: 'polar' }))).toMatchObject({ payer: 'own-key' });
    // Without the operator's OpenRouter key there is nothing to sell.
    const realProvider = withEnv({ BUILT_IN_PROVIDER: '', BUILT_IN_API_KEY: '' });
    expect(onCredit(realProvider)).toMatchObject({ payer: 'own-key' });
    expect(
      onCredit({ ...realProvider, BUILT_IN_API_KEY: 'sk-or-operator' } as AppEnv),
    ).toMatchObject({ payer: 'credit' });
    // PERSONAL_CREDIT_ENABLED offers credit before payments are configured.
    expect(
      onCredit(withEnv({ PAYMENT_PROVIDER: 'polar', PERSONAL_CREDIT_ENABLED: 'true' })),
    ).toMatchObject({ payer: 'credit' });
  });

  it('Learn on the pool: pool-funded while the pool is on, for signed-in users only', async () => {
    const onPool = (e: AppEnv, who: Identity) =>
      withPoolParams(e, resolveAccount(e, who, learn('pool')), null);
    const pooled = await onPool(withEnv(), user('a@example.org'));
    expect(pooled).toMatchObject({ mode: 'simple', payer: 'pool', userId: 'usr1' });
    expect(isPoolFunded(pooled)).toBe(true);
    // Off, or the dev bypass (no user to cap): asked for, but nothing to spend.
    for (const [e, who] of [
      [withEnv({ POOL_ENABLED: 'false' }), user('a@example.org')],
      [withEnv(), dev],
    ] as const) {
      const unfunded = await onPool(e, who);
      expect(unfunded).toMatchObject({ payer: 'pool', pool: null });
      expect(callPayer(unfunded, 'credit')).toBe('own-key');
    }
    // Credit that runs short moves to the pool (billing/gate.ts), the same way.
    const credit = resolveAccount(withEnv(), user('a@example.org'), learn('credit'));
    expect(isPoolFunded(await withPoolParams(withEnv(), credit, null, true))).toBe(true);
  });

  it('power never uses the pool, whatever the payment header', () => {
    const pool: AccountRequest = { mode: 'power', payment: 'pool' };
    const account = resolveAccount(withEnv(), user('a@example.org'), pool);
    expect(account).toMatchObject({ mode: 'power' });
    expect(account).not.toHaveProperty('payer');
  });

  it('power has Tangent credit whenever it is offered, whatever the payment header', () => {
    const credit: AccountRequest = { mode: 'power', payment: 'credit' };
    const offered = (e: AppEnv, request: AccountRequest) =>
      callPayer(resolveAccount(e, user('a@example.org'), request), 'credit') === 'credit';
    expect(offered(withEnv(), power)).toBe(true);
    expect(offered(withEnv(), credit)).toBe(true);
    expect(offered(withEnv({ PAYMENT_PROVIDER: 'polar' }), power)).toBe(false);
    expect(offered(withEnv({ BUILT_IN_PROVIDER: '', BUILT_IN_API_KEY: '' }), power)).toBe(false);
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
        LEARN_NORMAL_MODEL: 'a/normal',
        LEARN_MAX_MODEL: 'b/max',
        BACKGROUND_MODEL: 'c/fast',
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

  it("the operator's PROVIDERS rule; without it, power's defaults are the three real endpoints", () => {
    expect(providerConfigs(withEnv()).some((c) => c.openModels)).toBe(false);
    const defaults = providerConfigs(withEnv({ PROVIDERS: '' }));
    expect(defaults.map((c) => c.id)).toEqual(['anthropic', 'openai', 'openrouter']);
    expect(defaults.some((c) => c.kind === 'fake')).toBe(false);
  });

  it('Tangent credit takes the operator key only, never a user key, in a registry of its own', () => {
    const identity = { userId: 'usr2', email: 'b@example.org', devMode: false };
    const account = resolveAccount(withEnv(), identity, { mode: 'power', payment: 'own-key' });
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
    const noCredit = { ...devPowerAccount(), userId: 'usr2', creditOffered: false };
    expect(creditRegistryFor(withEnv(), noCredit)).toBeNull();
    // Learn has one registry for every funding; it never has a credit registry.
    const learn = resolveAccount(withEnv(), identity, { mode: 'simple', payment: 'credit' });
    expect(creditRegistryFor(withEnv(), learn)).toBeNull();
  });
});

describe('provider secrets', () => {
  it('hands providers only the secrets their configs name', () => {
    const e = {
      ...env,
      BETTER_AUTH_SECRET: 'auth-secret',
      POLAR_ACCESS_TOKEN: 'polar-token',
      OPENROUTER_API_KEY: 'sk-or-server',
      CF_AIG_TOKEN: 'gw-token',
    } as AppEnv;
    const config: ProviderConfig = {
      id: 'gw',
      kind: 'openai-compatible',
      label: 'Gateway',
      baseUrl: 'https://gateway.test',
      apiKeySecret: 'OPENROUTER_API_KEY',
      extraHeaderSecrets: { 'cf-aig-authorization': 'CF_AIG_TOKEN' },
      defaultModel: 'm',
      models: [{ id: 'm', label: 'M' }],
    };
    expect(providerEnv(e, [config]).secrets).toEqual({
      OPENROUTER_API_KEY: 'sk-or-server',
      CF_AIG_TOKEN: 'gw-token',
    });
    expect(providerEnv(e, [config], undefined, new Set(['OPENROUTER_API_KEY'])).secrets).toEqual({
      CF_AIG_TOKEN: 'gw-token',
    });
    expect(providerEnv(e, []).secrets).toEqual({});
  });
});
