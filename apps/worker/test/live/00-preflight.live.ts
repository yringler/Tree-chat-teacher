// Before anything spends: the harness runs with production's provider and price vars,
// and the OpenRouter key has a limit and room for the whole budget. Only then does the
// host open the budget (`arm`), so a failed preflight stops every paid call.
import { describe, expect, it } from 'vitest';
import { LIVE_HARNESS_BINDINGS, PRODUCTION_ONLY_VARS } from './bindings.js';
import { arm, BAD_KEYS, liveKey, liveSettings, observe, postFooter, scenario } from './harness.js';

const KEY_URL = 'https://openrouter.ai/api/v1/key';

/** `GET /api/v1/key`'s `data`, the fields the preflight and postflight read. */
export interface KeyInfo {
  usage: number;
  limit: number | null;
  limitRemaining: number | null;
}

/** The key's limit and usage; fails on a field that moved or changed type. */
export async function keyInfo(): Promise<KeyInfo> {
  const key = liveKey('BUILT_IN_API_KEY');
  if (!key) throw new Error('no OpenRouter key');
  const res = await fetch(KEY_URL, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`GET /api/v1/key: HTTP ${res.status}`);
  const body: unknown = await res.json();
  const data =
    typeof body === 'object' && body !== null && 'data' in body ? (body.data as unknown) : null;
  if (typeof data !== 'object' || data === null) throw new Error('GET /api/v1/key: no data');
  const field = (name: string): unknown => (data as Record<string, unknown>)[name];
  const usage = field('usage');
  const limit = field('limit');
  const remaining = field('limit_remaining');
  if (typeof usage !== 'number') throw new Error('GET /api/v1/key: data.usage is not a number');
  if (limit !== null && typeof limit !== 'number')
    throw new Error('GET /api/v1/key: data.limit is neither a number nor null');
  if (remaining !== null && typeof remaining !== 'number')
    throw new Error('GET /api/v1/key: data.limit_remaining is neither a number nor null');
  return { usage, limit, limitRemaining: remaining };
}

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

  // Key checks: `PROVIDER_KINDS['openai-compatible'].verifyRequest` asks `GET {baseUrl}/models`.
  scenario('a wrong key on the key check endpoints', 'openrouter', async () => {
    const headers = { authorization: `Bearer ${BAD_KEYS.openrouter}` };
    const models = await fetch('https://openrouter.ai/api/v1/models', { headers });
    await models.body?.cancel();
    const key = await fetch(KEY_URL, { headers });
    await key.body?.cancel();
    const answer = `GET /api/v1/models answers ${models.status}, GET /api/v1/key answers ${key.status}`;
    await postFooter({ probes: { 'Wrong OpenRouter key': answer } });
    const failures: string[] = [];
    if (models.ok)
      failures.push(
        'GET /api/v1/models accepts a wrong key, so a key check against it passes any key',
      );
    if (key.ok) failures.push('GET /api/v1/key accepts a wrong key');
    return { model: null, failures, warnings: [], notes: [answer] };
  });
});
