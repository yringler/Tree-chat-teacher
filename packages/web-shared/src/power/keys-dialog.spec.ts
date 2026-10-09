import '@angular/compiler'; // JIT: lets the component below construct without the Angular CLI.
import { Injector, runInInjectionContext } from '@angular/core';
import type { BillingSummary, Branch, MeResponse, ProviderInfo } from '@tangent/shared';
import { describe, expect, it, vi } from 'vitest';
import { ToastStore } from '../ui/toasts';
import { creditFeeSentence, KeysDialog } from './keys-dialog';
import { PowerConversationStore, type PowerApi } from './power-conversation-store';

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

/** Power's store with no app around it. */
class Store extends PowerConversationStore {
  fail(): void {}
  protected notify(): void {}
  protected keysSettled(): void {}
  protected movedToCredit(_branch: Branch): void {}
}

/** The dialog's view state, read the way its template does. */
class View extends KeysDialog {
  get state() {
    return { credit: this.credit(), keys: this.keyProviders(), provider: this.provider() };
  }
}

function open(builtInCredit: boolean) {
  const api = {
    billing: vi.fn(async () => ({ availableMicros: 1_000_000 }) as BillingSummary),
  } satisfies Partial<PowerApi>;
  const router = { navigate: vi.fn(async () => true) };
  // Only `billing` is called: the dialog reads everything else from the store's signals.
  const store = new Store(api as Partial<PowerApi> as PowerApi, router, {
    tree: 'conversation',
    branch: 'branch',
    link: 'link',
    linked: { created: 'Messages linked', existing: 'Already linked' },
  });
  store.account.me.set({ builtInCredit } as MeResponse);
  store.account.providers.set([
    provider('anthropic', { available: true }),
    provider('openrouter'),
    provider('openrouter', {
      label: 'Tangent credit',
      funding: 'credit',
      acceptsUserKey: false,
      available: true,
    }),
  ]);
  const injector = Injector.create({
    providers: [{ provide: PowerConversationStore, useValue: store }, { provide: ToastStore }],
  });
  const dialog = runInInjectionContext(injector, () => new View());
  dialog.ngOnInit();
  return { dialog, api, store };
}

describe('Keys & credit dialog', () => {
  it('loads the credit when the built-in provider is offered, and keeps it out of the key rows', async () => {
    const d = open(true);
    expect(d.dialog.state.credit).toBe(true);
    expect(d.dialog.state.keys.map((p) => p.id)).toEqual(['anthropic', 'openrouter']);
    // The first provider without a key.
    expect(d.dialog.state.provider).toBe('openrouter');
    expect(d.api.billing).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(d.store.account.billing()?.availableMicros).toBe(1_000_000));
  });

  it('shows no credit row and asks for no balance otherwise', () => {
    const d = open(false);
    expect(d.dialog.state.credit).toBe(false);
    expect(d.api.billing).not.toHaveBeenCalled();
  });

  it('says what a credit call costs in one sentence', () => {
    expect(creditFeeSentence({ openRouterFeeBps: 550, markupBps: 1000 })).toBe(
      "Each call costs the model's OpenRouter price + 5.5% OpenRouter fee + 10%, taken from your credit.",
    );
  });
});
