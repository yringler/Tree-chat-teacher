// The checks every generating route makes before it calls a provider
// (`assertGenerationAllowed`, byok/guard.ts), and how the legacy built-in id
// reads as a summary provider (`chatSettingsFor`, services.ts): the branches the
// API suites rarely reach.
import { KeyRequiredError, ValidationError } from '@tangent/core';
import type { ProviderInfo, ProviderRegistry } from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { assertGenerationAllowed } from '../src/byok/guard.js';
import type { AccountContext, AppEnv } from '../src/env.js';
import { chatSettingsFor } from '../src/services.js';

const env = rawEnv as unknown as AppEnv;

function registry(...entries: Partial<ProviderInfo>[]): ProviderRegistry {
  const infos = entries.map((e): ProviderInfo => ({
    id: 'p',
    kind: 'openai-compatible',
    label: 'Provider',
    models: [{ id: 'm', label: 'M' }],
    defaultModel: 'm',
    openModels: false,
    available: true,
    acceptsUserKey: true,
    keySource: 'user',
    ...e,
  }));
  return {
    get: () => undefined,
    list: () => infos,
    defaultProviderId: () => infos[0]!.id,
  };
}

const check =
  (r: ProviderRegistry | null, opts?: Parameters<typeof assertGenerationAllowed>[3]) => () =>
    assertGenerationAllowed(r, 'p', 'm', opts);

describe('assertGenerationAllowed', () => {
  it('passes an available provider and an allowed model', () => {
    expect(check(registry({}))).not.toThrow();
  });

  it('a credit route where credit is not offered (no registry) is a 400, not a missing key', () => {
    expect(check(null)).toThrow(
      new ValidationError('Tangent credit is not offered on this server'),
    );
  });

  it('a provider the registry lacks is "Unknown provider"', () => {
    expect(check(registry({ id: 'other' }))).toThrow(new ValidationError('Unknown provider "p"'));
  });

  it('asks for the user key, by the provider label or the given key label', () => {
    const noKey = registry({ available: false, keySource: null, label: 'Tangent' });
    expect(check(noKey)).toThrow(KeyRequiredError);
    expect(check(noKey)).toThrow('Add your Tangent API key to continue this conversation.');
    expect(check(noKey, { keyLabel: 'OpenRouter' })).toThrow(
      'Add your OpenRouter API key to continue this conversation.',
    );
  });

  it('a missing server key on a metered route, or a provider that takes no user key, is a configuration error', () => {
    const noKey = registry({ available: false, keySource: null, label: 'Tangent' });
    expect(check(noKey, { userKeys: false })).toThrow(
      new ValidationError('Tangent is not configured on this server'),
    );
    const serverOnly = registry({ available: false, acceptsUserKey: false, label: 'Tangent' });
    expect(check(serverOnly)).toThrow(
      new ValidationError('Tangent is not configured on this server'),
    );
    // A user key that is set but unusable isn't asked for again.
    const badUserKey = registry({ available: false, keySource: 'user', label: 'Tangent' });
    expect(check(badUserKey)).toThrow(ValidationError);
  });

  it('refuses a model the provider does not list, unless it takes any model id', () => {
    const r = registry({ models: [{ id: 'x', label: 'X' }] });
    expect(check(r)).toThrow(new ValidationError('Model "m" is not enabled for Provider'));
    expect(check(registry({ models: [], openModels: true }))).not.toThrow();
  });
});

describe('chatSettingsFor: SUMMARY_PROVIDER_ID', () => {
  const power: AccountContext = {
    id: 'p_settings',
    mode: 'power',
    userId: 'settings',
    billingAccountId: 'u_settings',
    builtIn: true,
    operatorKeys: false,
    funding: 'personal',
  };
  const settings = (id: string) =>
    chatSettingsFor({ ...env, SUMMARY_PROVIDER_ID: id } as AppEnv, power);

  it('the legacy `tangent` (Tangent credit) means no summary provider, so summaries never cost credit', () => {
    expect(settings('tangent').summaryProviderId).toBeNull();
    expect(settings(' tangent ').summaryProviderId).toBeNull();
  });

  it('any other id is kept, and blank is none', () => {
    expect(settings('ant').summaryProviderId).toBe('ant');
    expect(settings('openrouter').summaryProviderId).toBe('openrouter');
    expect(settings('  ').summaryProviderId).toBeNull();
  });
});
