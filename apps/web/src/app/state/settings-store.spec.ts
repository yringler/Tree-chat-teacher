import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector } from '@angular/core';
import type { SettingsResponse, UpdateSettingsRequest } from '@tangent/shared';
import { ApiClient, ApiError } from '@tangent/web-shared';
import { accountSettings } from '@tangent/web-shared/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  generationLimits,
  parseInputTokens,
  parseOutputTokens,
  savedChoice,
  SettingsStore,
} from './settings-store';

const NORMAL = { providerId: 'openrouter', funding: 'credit', model: 'a/normal' } as const;

function setup(saved: SettingsResponse = accountSettings()) {
  let current = saved;
  const api = {
    settings: vi.fn(async (): Promise<SettingsResponse> => current),
    updateSettings: vi.fn(async (req: UpdateSettingsRequest): Promise<SettingsResponse> => {
      const { tiers, walkthroughDone: _w, ...rest } = req;
      current = { ...current, ...rest, tiers: { ...current.tiers, ...tiers } };
      return current;
    }),
  };
  const injector = Injector.create({
    providers: [{ provide: SettingsStore }, { provide: ApiClient, useValue: api }],
  });
  return { store: injector.get(SettingsStore), api };
}

describe('SettingsStore', () => {
  it('holds the defaults until the account’s settings load, then those', async () => {
    const { store, api } = setup(
      accountSettings({
        systemPrompt: 'Mine.',
        tiers: { normal: NORMAL, max: null },
        maxOutputTokens: 8192,
        inputOverflow: 'truncate',
      }),
    );
    expect(store.loaded()).toBe(false);
    expect(store.settings()).toEqual(DEFAULT_SETTINGS);
    await Promise.all([store.load(), store.load()]);
    await store.load();
    expect(api.settings).toHaveBeenCalledOnce();
    expect(store.loaded()).toBe(true);
    expect(store.settings()).toEqual({
      ...DEFAULT_SETTINGS,
      tiers: { normal: NORMAL, max: null },
      maxOutputTokens: 8192,
      inputOverflow: 'truncate',
    });
    expect(store.prompt()).toEqual({ saved: 'Mine.', builtIn: 'Be a tutor.' });
  });

  it('tries again after a failed load', async () => {
    const { store, api } = setup();
    api.settings.mockRejectedValueOnce(new ApiError(0, 'network', 'Network error'));
    await expect(store.load()).rejects.toThrow('Network error');
    expect(store.loaded()).toBe(false);
    await store.load();
    expect(api.settings).toHaveBeenCalledTimes(2);
    expect(store.loaded()).toBe(true);
  });

  it('saves to the account and takes its answer', async () => {
    const { store, api } = setup();
    await store.load();
    await store.save({ maxInputTokens: 32_000 });
    expect(api.updateSettings).toHaveBeenCalledExactlyOnceWith({ maxInputTokens: 32_000 });
    expect(store.settings().maxInputTokens).toBe(32_000);
  });

  it('a failed save changes nothing', async () => {
    const { store, api } = setup();
    await store.load();
    api.updateSettings.mockRejectedValueOnce(new ApiError(400, 'bad_request', 'No.'));
    await expect(store.save({ maxInputTokens: 32_000 })).rejects.toThrow('No.');
    expect(store.settings()).toEqual(DEFAULT_SETTINGS);
    // The next save still goes.
    await store.save({ maxOutputTokens: 4096 });
    expect(store.settings().maxOutputTokens).toBe(4096);
  });

  it('a save waits for the load, so the load’s answer never puts the old values back', async () => {
    const { store, api } = setup();
    let answer = (_res: SettingsResponse): void => undefined;
    api.settings.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const loading = store.load();
    const saving = store.save({ maxOutputTokens: 4096 });
    await new Promise((resolve) => setTimeout(resolve));
    expect(api.updateSettings).not.toHaveBeenCalled();
    answer(accountSettings());
    await Promise.all([loading, saving]);
    expect(store.settings().maxOutputTokens).toBe(4096);
  });

  it('saves one after another, so the last answer is the last save’s', async () => {
    const { store, api } = setup();
    await store.load();
    const order: string[] = [];
    api.updateSettings.mockImplementation(async (req) => {
      order.push(JSON.stringify(req));
      await new Promise((resolve) => setTimeout(resolve, req.reviewer ? 5 : 0));
      return accountSettings({ reviewer: req.reviewer ?? null });
    });
    await Promise.all([store.save({ reviewer: NORMAL }), store.save({ reviewer: null })]);
    expect(order).toEqual([JSON.stringify({ reviewer: NORMAL }), '{"reviewer":null}']);
    expect(store.settings().reviewer).toBeNull();
  });
});

describe('savedChoice', () => {
  it('names who pays, the user’s own key when the choice doesn’t say', () => {
    expect(savedChoice({ providerId: 'anthropic', model: 'm' })).toEqual({
      providerId: 'anthropic',
      funding: 'own-key',
      model: 'm',
    });
    expect(savedChoice(NORMAL)).toEqual(NORMAL);
  });
});

describe('the reply limit (maxOutputTokens)', () => {
  it('drops anything a send would be refused for', () => {
    for (const bad of [255, 128_001, 4096.5, '4096', true, -1, Number.NaN])
      expect(parseOutputTokens(bad), String(bad)).toBeNull();
    expect(parseOutputTokens(256)).toBe(256);
    expect(parseOutputTokens(128_000)).toBe(128_000);
  });
});

describe('the input limit (maxInputTokens, inputOverflow)', () => {
  it('drops anything a send would be refused for', () => {
    for (const bad of [999, 2_000_001, 60_000.5, '60000', false, Number.POSITIVE_INFINITY])
      expect(parseInputTokens(bad), String(bad)).toBeNull();
    expect(parseInputTokens(1000)).toBe(1000);
    expect(parseInputTokens(2_000_000)).toBe(2_000_000);
  });

  it('sends only what differs from the server’s defaults', () => {
    expect(generationLimits(DEFAULT_SETTINGS)).toEqual({});
    expect(
      generationLimits({
        ...DEFAULT_SETTINGS,
        maxOutputTokens: 8192,
        maxInputTokens: 60_000,
        inputOverflow: 'truncate',
      }),
    ).toEqual({ maxOutputTokens: 8192, maxInputTokens: 60_000, inputOverflow: 'truncate' });
    expect(generationLimits({ ...DEFAULT_SETTINGS, maxInputTokens: 32_000 })).toEqual({
      maxInputTokens: 32_000,
    });
  });
});
