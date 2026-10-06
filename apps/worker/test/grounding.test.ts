import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { groundingAllowance, groundingSettings, searchesToday } from '../src/billing/grounding.js';
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
      GROUNDING_MAX_RESULTS: '99',
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

  it('defaults to auto with 5 Exa results, and turns an unknown policy off', () => {
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
    expect(groundingSettings({ ...env, GROUNDING: 'sometimes' } as AppEnv, 'power').policy).toBe(
      'off',
    );
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
    const account = simpleAccount();
    const capped = { ...env, GROUNDING_AUTO_DAILY_CAP: '2' } as AppEnv;
    const allow = groundingAllowance(capped, account);
    expect(await allow('tangent')).toBe(true);
    await searched(account.billingAccountId);
    await searched(account.billingAccountId);
    expect(await allow('tangent')).toBe(false);
    expect(await allow('openrouter')).toBe(true);
    expect(
      await groundingAllowance(
        { ...capped, GROUNDING_AUTO_DAILY_CAP: '0' } as AppEnv,
        account,
      )('tangent'),
    ).toBe(true);
    expect(await groundingAllowance(capped, powerAccount())('tangent')).toBe(true);
  });
});
