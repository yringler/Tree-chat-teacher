import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector, runInInjectionContext } from '@angular/core';
import { Router } from '@angular/router';
import type { MeResponse, ProviderInfo } from '@tangent/shared';
import { ApiClient } from '@tangent/web-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TreeStore } from '../state/tree-store';
import { SettingsStore } from '../state/settings-store';
import { UiStore } from '../state/ui-store';
import { ApiKeys } from './api-keys';

function provider(id: string, over: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id,
    kind: 'openai-compatible',
    label: id,
    models: [],
    defaultModel: 'm',
    openModels: true,
    available: false,
    acceptsUserKey: true,
    keySource: null,
    ...over,
  };
}

/** The dialog's protected view state, read the way its template does. */
interface View {
  credit(): boolean;
  keyProviders(): ProviderInfo[];
  provider(): string;
}

function open(builtInCredit: boolean) {
  const api = { billing: vi.fn(async () => ({ availableMicros: 1_000_000 })) };
  const injector = Injector.create({
    providers: [
      { provide: TreeStore },
      { provide: UiStore },
      { provide: SettingsStore },
      { provide: ApiClient, useValue: api },
      { provide: Router, useValue: {} },
    ],
  });
  const store = injector.get(TreeStore);
  store.me.set({ builtInCredit } as MeResponse);
  store.providers.set([
    provider('openrouter'),
    provider('openrouter', {
      label: 'Tangent credit',
      funding: 'credit',
      acceptsUserKey: false,
      available: true,
    }),
  ]);
  const dialog = runInInjectionContext(injector, () => new ApiKeys());
  dialog.ngOnInit();
  return { view: dialog as unknown as View, api, store };
}

describe('Keys & credit dialog', () => {
  afterEach(() => vi.restoreAllMocks());

  it('loads the credit when the built-in provider is offered, and keeps it out of the key rows', async () => {
    const d = open(true);
    expect(d.view.credit()).toBe(true);
    expect(d.view.keyProviders().map((p) => p.id)).toEqual(['openrouter']);
    expect(d.view.provider()).toBe('openrouter');
    expect(d.api.billing).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(d.store.billing()?.availableMicros).toBe(1_000_000));
  });

  it('shows no credit row and asks for no balance otherwise', () => {
    const d = open(false);
    expect(d.view.credit()).toBe(false);
    expect(d.api.billing).not.toHaveBeenCalled();
  });
});
