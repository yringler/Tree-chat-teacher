import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { groundingAllowance, groundingSettings, searchesToday } from '../src/billing/grounding.js';
import { ConfigError } from '../src/config.js';
import type { AppEnv } from '../src/env.js';
import { insertUsage, powerAccount, simpleAccount } from './mocks/billing-helpers.js';

const env = rawEnv as unknown as AppEnv;

async function searched(accountId: string, createdAt = new Date().toISOString()): Promise<void> {
  const id = await insertUsage(env, { accountId, status: 'settled', purpose: 'reply', createdAt });
  await env.DB.prepare('UPDATE usage_events SET web_searches = 1 WHERE id = ?1').bind(id).run();
}

describe('grounding settings', () => {
  it('reads the vars, ignoring the branch setting in Learn only', () => {
    const e = {
      ...env,
      GROUNDING: 'explicit',
      GROUNDING_MAX_RESULTS: '25',
      GROUNDING_ENGINE: 'parallel',
    } as AppEnv;
    expect(groundingSettings(e, 'simple')).toEqual({
      policy: 'explicit',
      maxResults: 25,
      maxUses: 1,
      engine: 'parallel',
      ignoreBranchSetting: true,
    });
    expect(groundingSettings(e, 'power').ignoreBranchSetting).toBe(false);
  });

  it('defaults to auto with 5 Exa results, and refuses an unknown policy or too many results', () => {
    const empty = {
      ...env,
      GROUNDING: '',
      GROUNDING_MAX_RESULTS: '',
      GROUNDING_ENGINE: '',
    } as AppEnv;
    expect(groundingSettings(empty, 'power')).toMatchObject({
      policy: 'auto',
      maxResults: 5,
      engine: 'exa',
    });
    for (const bad of [{ GROUNDING: 'sometimes' }, { GROUNDING_MAX_RESULTS: '99' }])
      expect(() => groundingSettings({ ...env, ...bad } as AppEnv, 'power')).toThrow(ConfigError);
  });
});

describe('daily cap on automatic searches', () => {
  it('counts only today’s searching replies on the ledger', async () => {
    const account = simpleAccount();
    await searched(account.billingAccountId);
    await searched(account.billingAccountId, '2020-01-01T00:00:00.000Z');
    await insertUsage(env, {
      accountId: account.billingAccountId,
      status: 'settled',
      purpose: 'reply',
    });
    expect(await searchesToday(env, account.billingAccountId)).toBe(1);
  });

  it('stops automatic searches on credit at the cap, never on own keys; 0 = no cap', async () => {
    const credit = { providerId: 'openrouter', funding: 'credit' } as const;
    const ownKey = { providerId: 'openrouter', funding: 'own-key' } as const;
    const capped = { ...env, GROUNDING_AUTO_DAILY_CAP: '2' } as AppEnv;

    const learn = simpleAccount();
    const allow = groundingAllowance(capped, learn);
    expect(await allow(credit)).toBe(true);
    await searched(learn.billingAccountId);
    await searched(learn.billingAccountId);
    expect(await allow(credit)).toBe(false);
    const uncapped = { ...capped, GROUNDING_AUTO_DAILY_CAP: '0' } as AppEnv;
    expect(await groundingAllowance(uncapped, learn)(credit)).toBe(true);

    // Power: the cap applies to branches on Tangent credit, not to the user's own key.
    const power = powerAccount();
    await searched(power.billingAccountId);
    await searched(power.billingAccountId);
    expect(await groundingAllowance(capped, power)(credit)).toBe(false);
    expect(await groundingAllowance(capped, power)(ownKey)).toBe(true);
  });
});
