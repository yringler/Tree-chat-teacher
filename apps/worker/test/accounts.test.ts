import { DEFAULT_PROVIDER_CONFIGS } from '@tangent/providers';
import {
  MODE_HEADER,
  OWN_KEY_HEADER,
  PAYMENT_HEADER,
  type MeResponse,
  type Payer,
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
import {
  chatService,
  chatSettingsFor,
  creditRegistryFor,
  providersFor,
  registryFor,
} from '../src/registries.js';
import {
  LEARN_ANTHROPIC_BACKGROUND_MODEL,
  LEARN_ANTHROPIC_REPLY_MODEL,
} from '../src/simple-mode.js';
import { makeTree, makeTrunk } from './fixtures.js';
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
  const power: AccountRequest = { mode: 'power', payment: 'own-key', ownKey: 'openrouter' };
  const learn = (
    payment: AccountRequest['payment'],
    ownKey: AccountRequest['ownKey'] = 'openrouter',
  ): AccountRequest => ({ mode: 'simple', payment, ownKey });

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
      ownKey: 'openrouter',
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
      ownKey: 'openrouter',
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
    const pool: AccountRequest = { ...power, payment: 'pool' };
    const account = resolveAccount(withEnv(), user('a@example.org'), pool);
    expect(account).toMatchObject({ mode: 'power' });
    expect(account).not.toHaveProperty('payer');
  });

  it('power has Tangent credit whenever it is offered, whatever the payment header', () => {
    const credit: AccountRequest = { ...power, payment: 'credit' };
    const offered = (e: AppEnv, request: AccountRequest) =>
      callPayer(resolveAccount(e, user('a@example.org'), request), 'credit') === 'credit';
    expect(offered(withEnv(), power)).toBe(true);
    expect(offered(withEnv(), credit)).toBe(true);
    expect(offered(withEnv({ PAYMENT_PROVIDER: 'polar' }), power)).toBe(false);
    expect(offered(withEnv({ BUILT_IN_PROVIDER: '', BUILT_IN_API_KEY: '' }), power)).toBe(false);
  });

  it('reads the mode, payment and own-key headers, defaulting to power, own-key and OpenRouter', () => {
    const openrouter = { ownKey: 'openrouter' };
    expect(accountRequest(new Headers())).toEqual({
      mode: 'power',
      payment: 'own-key',
      ...openrouter,
    });
    expect(
      accountRequest(new Headers({ [MODE_HEADER]: 'simple', [PAYMENT_HEADER]: 'credit' })),
    ).toEqual({ mode: 'simple', payment: 'credit', ...openrouter });
    expect(
      accountRequest(new Headers({ [MODE_HEADER]: 'Simple', [PAYMENT_HEADER]: 'free' })),
    ).toEqual({ mode: 'power', payment: 'own-key', ...openrouter });
    expect(
      accountRequest(new Headers({ [MODE_HEADER]: 'simple', [PAYMENT_HEADER]: 'pool' })),
    ).toEqual({ mode: 'simple', payment: 'pool', ...openrouter });
    expect(
      accountRequest(new Headers({ [MODE_HEADER]: 'simple', [OWN_KEY_HEADER]: 'anthropic' })),
    ).toEqual({ mode: 'simple', payment: 'own-key', ownKey: 'anthropic' });
    // An unknown key is OpenRouter, as no header is: the worst it does is ask for that key.
    for (const value of ['Anthropic', 'openai', 'fake', ''])
      expect(
        accountRequest(new Headers({ [MODE_HEADER]: 'simple', [OWN_KEY_HEADER]: value })),
      ).toMatchObject(openrouter);
  });

  it("Learn's own key is the one asked for where the deployment offers it, else OpenRouter", () => {
    const who = user('a@example.org');
    const withAnthropic = withEnv({ PROVIDERS: JSON.stringify([LEARN_ANTHROPIC]) });
    expect(resolveAccount(withAnthropic, who, learn('own-key', 'anthropic'))).toMatchObject({
      payer: 'own-key',
      ownKey: 'anthropic',
    });
    // The test env's PROVIDERS has no `anthropic` endpoint: nothing to reply through.
    expect(resolveAccount(withEnv(), who, learn('own-key', 'anthropic'))).toMatchObject({
      ownKey: 'openrouter',
    });
    // The power defaults have one.
    expect(
      resolveAccount(withEnv({ PROVIDERS: '' }), who, learn('own-key', 'anthropic')),
    ).toMatchObject({ ownKey: 'anthropic' });
  });
});

/** Power's Anthropic endpoint, as an operator configures it (here on the mock upstream). */
const LEARN_ANTHROPIC = {
  id: 'anthropic',
  kind: 'anthropic',
  label: 'Anthropic',
  baseUrl: 'https://llm.test',
  apiKeySecret: 'ANTHROPIC_API_KEY',
  defaultModel: 'claude-opus-5-5',
  models: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ],
};

describe("Learn on the learner's own Anthropic key", () => {
  const e = {
    ...env,
    PROVIDERS: JSON.stringify([LEARN_ANTHROPIC]),
    ANTHROPIC_API_KEY: 'sk-ant-goodSERVER',
  } as AppEnv;
  const who = { userId: 'usr3', email: 'c@example.org', devMode: false };
  const onKey = (ownKey: 'openrouter' | 'anthropic', payment: Payer = 'own-key') =>
    resolveAccount(e, who, { mode: 'simple', payment, ownKey });

  it('the fixed models come from the Anthropic defaults', () => {
    const anthropic = DEFAULT_PROVIDER_CONFIGS.find((c) => c.id === 'anthropic')!;
    const ids = anthropic.models.map((m) => m.id);
    expect(ids).toContain(LEARN_ANTHROPIC_REPLY_MODEL);
    expect(ids).toContain(LEARN_ANTHROPIC_BACKGROUND_MODEL);
    expect(LEARN_ANTHROPIC_REPLY_MODEL).toMatch(/sonnet/);
    expect(LEARN_ANTHROPIC_BACKGROUND_MODEL).toMatch(/haiku/);
  });

  it("replies on power's Anthropic endpoint with the user's key, on Sonnet only, never the operator's key", () => {
    const keys = { anthropic: 'sk-ant-goodUSER', openrouter: 'sk-or-user' };
    const registry = registryFor(e, onKey('anthropic'), keys);
    expect(registry.list()).toEqual([
      expect.objectContaining({
        id: 'anthropic',
        defaultModel: LEARN_ANTHROPIC_REPLY_MODEL,
        models: [{ id: LEARN_ANTHROPIC_REPLY_MODEL, label: 'Claude Sonnet 5.5' }],
        openModels: false,
        keySource: 'user',
        available: true,
      }),
    ]);
    expect(providersFor(e, onKey('anthropic'), keys).map((p) => p.id)).toEqual(['anthropic']);
    // Without the user's key it is unavailable: ANTHROPIC_API_KEY is never the fallback.
    expect(registryFor(e, onKey('anthropic')).list()[0]).toMatchObject({
      available: false,
      keySource: null,
    });
    // On OpenRouter, credit or the pool, Learn keeps its built-in provider.
    expect(
      registryFor(e, onKey('openrouter'), keys)
        .list()
        .map((p) => p.id),
    ).toEqual(['openrouter']);
    expect(
      registryFor(e, onKey('anthropic', 'credit'), keys)
        .list()
        .map((p) => p.id),
    ).toEqual(['openrouter']);
  });

  it('every branch replies on Sonnet whatever it stores; titles and summaries run on Haiku', () => {
    const account = onKey('anthropic');
    const chat = chatService(e, account, { apiKeys: { anthropic: 'sk-ant-goodUSER' } });
    const tree = makeTree();
    for (const [providerId, model] of [
      ['openrouter', 'deepseek/deepseek-v4.1-flash'],
      ['anthropic', 'claude-opus-5-5'],
      ['anthropic', LEARN_ANTHROPIC_BACKGROUND_MODEL],
    ] as const)
      expect(
        chat.runnableBranch(makeTrunk(tree, { providerId, model, funding: 'credit' })),
      ).toMatchObject({
        providerId: 'anthropic',
        model: LEARN_ANTHROPIC_REPLY_MODEL,
        funding: 'own-key',
      });
    expect(chatSettingsFor(e, account)).toMatchObject({
      summaryProviderId: 'anthropic',
      summaryModel: LEARN_ANTHROPIC_BACKGROUND_MODEL,
      summaryEffort: null,
      autoTitle: true,
    });
    // On OpenRouter (or credit), the background model as before.
    expect(chatSettingsFor(e, onKey('openrouter')).summaryProviderId).toBe('openrouter');
    expect(chatSettingsFor(e, onKey('anthropic', 'credit')).summaryProviderId).toBe('openrouter');
  });
});

describe('power provider configs', () => {
  const withEnv = (overrides: Partial<AppEnv> = {}) => ({ ...env, ...overrides }) as AppEnv;

  it('the default OpenRouter config lists the suggested models first and takes any model', () => {
    const openrouter = providerConfigs(
      withEnv({
        PROVIDERS: '',
        LEARN_NORMAL_MODEL: 'a/normal',
        POWER_MAX_MODEL: 'b/max',
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
    const account = resolveAccount(withEnv(), identity, {
      mode: 'power',
      payment: 'own-key',
      ownKey: 'openrouter',
    });
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
    const learn = resolveAccount(withEnv(), identity, {
      mode: 'simple',
      payment: 'credit',
      ownKey: 'openrouter',
    });
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
