import { TestBed } from '@angular/core/testing';
import type { BillingSummary, Branch, MeResponse, ProviderInfo } from '@tangent/shared';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { branch, detail, provider, provideAnyRoute, render } from '../testing';
import { ToastStore } from '../ui/toasts';
import { KeysDialog } from './keys-dialog';
import { PowerConversationStore, type PowerApi } from './power-conversation-store';

/** Power's store with no app around it. */
class Store extends PowerConversationStore {
  fail(): void {}
  protected notify(): void {}
  protected keysSettled(): void {}
  protected movedToCredit(_branch: Branch): void {}
}

const PROVIDERS: ProviderInfo[] = [
  provider({ id: 'anthropic', kind: 'anthropic', label: 'Anthropic' }),
  provider({ available: false, keySource: null }),
  provider({
    label: 'Tangent credit',
    funding: 'credit',
    acceptsUserKey: false,
    keySource: 'server',
  }),
];

async function open(opts: { builtInCredit?: boolean; keysEnabled?: boolean } = {}) {
  const api = {
    billing: vi.fn(
      async () =>
        ({ availableMicros: 1_500_000, markupBps: 1000, openRouterFeeBps: 550 }) as BillingSummary,
    ),
    saveKey: vi.fn(async (_provider: string, _key: string) => undefined),
    forgetKey: vi.fn(async (_provider?: string) => undefined),
    keyStatus: vi.fn(async () => ({ enabled: true, hasKey: true, providers: ['anthropic'] })),
    providers: vi.fn(async () => PROVIDERS),
  };
  const store = new Store(
    api as Partial<PowerApi> as PowerApi,
    { navigate: vi.fn() },
    {
      tree: 'conversation',
      branch: 'branch',
      link: 'link',
      linked: { created: 'Messages linked', existing: 'Already linked' },
    },
  );
  store.account.me.set({ builtInCredit: opts.builtInCredit ?? true } as MeResponse);
  store.account.providers.set(PROVIDERS);
  store.account.keyStatus.set({
    enabled: opts.keysEnabled ?? true,
    hasKey: true,
    providers: ['anthropic'],
  });
  const r = await render(KeysDialog, {
    providers: [{ provide: PowerConversationStore, useValue: store }, provideAnyRoute()],
  });
  const closed = vi.fn();
  r.component.closed.subscribe(closed);
  return { ...r, api, store, closed, user: userEvent.setup() };
}

describe('Keys & credit dialog', () => {
  it('lists each provider that takes a key, and the credit with its balance', async () => {
    const d = await open();
    screen.getByRole('dialog', { name: 'Keys & credit' });
    await vi.waitFor(() => expect(screen.getByText('$1.50 available')).toBeTruthy());
    expect(d.api.billing).toHaveBeenCalledTimes(1);
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('.key-name')?.textContent?.trim())).toEqual([
      'Anthropic',
      'OpenRouter · also used by Learn',
      'Tangent credit',
    ]);
    expect(within(rows[0]!).getByText('your key')).toBeTruthy();
    expect(within(rows[1]!).getByText('no key')).toBeTruthy();
    expect(within(rows[2]!).getByRole('link', { name: 'Add credit' }).getAttribute('href')).toBe(
      '/billing',
    );
  });

  it('saves a key for the first provider without one, clearing the field before the request', async () => {
    const d = await open();
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Provider' });
    expect(select.value).toBe('openrouter');
    const field = screen.getByLabelText<HTMLInputElement>('API key');
    await d.user.type(field, '  sk-or-123  ');
    d.api.saveKey.mockImplementationOnce(async () => {
      // The key lives only in this call: the field is already empty.
      expect(field.value).toBe('');
    });
    await d.user.click(screen.getByRole('button', { name: 'Save key' }));
    await vi.waitFor(() => expect(d.api.saveKey).toHaveBeenCalledWith('openrouter', 'sk-or-123'));
    await vi.waitFor(() =>
      expect(TestBed.inject(ToastStore).toasts()[0]?.text).toBe('OpenRouter key saved'),
    );
  });

  it("forgets one provider's key from its row, or every key at once", async () => {
    const d = await open();
    await d.user.click(screen.getByRole('button', { name: 'Forget' }));
    await vi.waitFor(() => expect(d.api.forgetKey).toHaveBeenCalledWith('anthropic'));
    await d.user.click(screen.getByRole('button', { name: 'Forget all keys' }));
    await vi.waitFor(() => expect(d.api.forgetKey).toHaveBeenLastCalledWith(undefined));
  });

  it('without the built-in provider: just API keys, and no balance asked for', async () => {
    const d = await open({ builtInCredit: false });
    screen.getByRole('dialog', { name: 'API keys' });
    expect(screen.queryByText('Tangent credit')).toBeNull();
    expect(d.api.billing).not.toHaveBeenCalled();
  });

  it("where the server can't store keys, says so and asks for none", async () => {
    await open({ keysEnabled: false });
    expect(screen.getByText(/isn't set up to store your own API keys/)).toBeTruthy();
    expect(screen.queryByLabelText('API key')).toBeNull();
  });

  it('opened by a send refused for want of a key: says so and carries the branch on credit', async () => {
    const d = await open();
    d.store.detail.set(detail([], [branch('trunk', { title: 'Light' })]));
    d.store.blockedSends.set([{ branchId: 'trunk', content: 'Why?' }]);
    const resume = vi.spyOn(d.store, 'resumeOnCredit').mockResolvedValue(true);
    await d.fixture.whenStable();
    await d.user.click(screen.getByRole('button', { name: 'Continue on Tangent credit' }));
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('Close closes it, and nothing waits on it any more', async () => {
    const d = await open();
    d.store.blockedSends.set([{ branchId: 'trunk', content: 'Why?' }]);
    await d.user.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(d.closed).toHaveBeenCalledTimes(1);
    d.fixture.destroy();
    expect(d.store.blockedSends()).toEqual([]);
  });
});
