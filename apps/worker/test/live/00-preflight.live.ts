// Before anything spends: the harness runs with production's provider and price vars,
// and the OpenRouter key has a limit and room for the whole budget. Only then does the
// host open the budget (`arm`), so a failed preflight stops every paid call.
import { verifyApiKey } from '@tangent/providers';
import { OPENROUTER_PROVIDER_ID } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { learnKeyConfig, providerEnv } from '../../src/provider-configs.js';
import { LIVE_HARNESS_BINDINGS, PRODUCTION_ONLY_VARS } from './bindings.js';
import {
  arm,
  BAD_KEYS,
  env,
  keyInfo,
  liveSettings,
  observe,
  postFooter,
  scenario,
} from './harness.js';

describe('preflight', () => {
  it('runs with every provider and price var as deployed', async () => {
    const overridden = PRODUCTION_ONLY_VARS.filter((name) => name in LIVE_HARNESS_BINDINGS);
    await observe({
      scenario: 'harness sets no production var',
      adapter: '–',
      model: null,
      servedBy: null,
      tokens: null,
      reportedUsd: null,
      recomputedUsd: null,
      status: overridden.length === 0 ? 'PASS' : 'FAIL',
      notes: overridden,
    });
    expect(overridden).toEqual([]);
  });

  scenario('key has a limit and room for the budget', 'openrouter', async () => {
    const settings = await liveSettings();
    const info = await keyInfo();
    await postFooter({ keyUsageStartUsd: info.usage, keyLimitUsd: info.limit });
    const failures: string[] = [];
    const warnings: string[] = [];
    if (info.limit === null) {
      if (settings.allowUnlimitedKey)
        warnings.push('the key has no credit limit (TANGENT_LIVE_ALLOW_UNLIMITED_KEY=1)');
      else
        failures.push(
          'the key has no credit limit: give it one at openrouter.ai/settings/keys, or set TANGENT_LIVE_ALLOW_UNLIMITED_KEY=1',
        );
    }
    if (info.limitRemaining !== null && info.limitRemaining < settings.budgetUsd)
      failures.push(
        `the key has $${info.limitRemaining.toFixed(2)} left, under the $${settings.budgetUsd.toFixed(2)} budget`,
      );
    if (failures.length === 0) await arm();
    return {
      model: null,
      failures,
      warnings,
      notes: [
        `usage $${info.usage.toFixed(4)}, limit ${info.limit ?? 'none'}, remaining ${info.limitRemaining ?? '–'}`,
      ],
    };
  });

  // Saving an OpenRouter key runs this check: a wrong key must be refused there.
  scenario('a wrong key on the key check', 'openrouter', async () => {
    const config = learnKeyConfig(env, OPENROUTER_PROVIDER_ID);
    if (!config) throw new Error('no OpenRouter key config');
    const check = await verifyApiKey(config, BAD_KEYS.openrouter, providerEnv(env, [config]));
    const answer = `verifyApiKey on ${config.baseUrl ?? 'the default endpoint'} answers ${check}`;
    await postFooter({ probes: { 'Wrong OpenRouter key': answer } });
    const failures =
      check === 'rejected' ? [] : ['the key check does not reject a wrong OpenRouter key'];
    return { model: null, failures, warnings: [], notes: [answer] };
  });
});
