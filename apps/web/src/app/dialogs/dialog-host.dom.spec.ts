import { TestBed } from '@angular/core/testing';
import { detail, openTree, powerProviders, render, signIn } from '@tangent/web-shared/testing';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { DialogHost } from './dialog-host';

async function host() {
  const api = {
    listShares: vi.fn(async () => []),
    keyStatus: vi.fn(async () => ({ enabled: true, hasKey: false, providers: [] })),
  };
  const r = await render(DialogHost, {
    providers: powerProviders(TreeStore, api),
    setup: () => signIn(TestBed.inject(TreeStore).account),
  });
  return {
    ...r,
    api,
    store: TestBed.inject(TreeStore),
    dialogs: TestBed.inject(UiStore).dialogs,
    user: userEvent.setup(),
  };
}

/** The open dialogs' headings, in the order they are on the page. */
const open = () =>
  screen
    .queryAllByRole('dialog')
    .map((d) => within(d).getByRole('heading', { level: 2 }).textContent);

describe('DialogHost', () => {
  it('renders the open dialogs in stack order, the one opened last on top', async () => {
    const h = await host();
    h.dialogs.open({ kind: 'keys', provider: null });
    h.dialogs.open({ kind: 'shortcuts' });
    await h.fixture.whenStable();
    expect(open()).toEqual(['API keys', 'Keyboard shortcuts']);
    // Opening one again moves it to the top.
    h.dialogs.open({ kind: 'keys', provider: null });
    await h.fixture.whenStable();
    expect(open()).toEqual(['Keyboard shortcuts', 'API keys']);
  });

  it('closing one leaves the others', async () => {
    const h = await host();
    h.dialogs.open({ kind: 'shortcuts' });
    h.dialogs.open({ kind: 'keys', provider: null });
    await h.fixture.whenStable();
    const keys = screen.getAllByRole('dialog')[1]!;
    await h.user.click(within(keys).getAllByRole('button', { name: 'Close' })[0]!);
    expect(open()).toEqual(['Keyboard shortcuts']);
    expect(h.dialogs.isOpen('keys')).toBe(false);
  });

  it('a conversation’s dialogs wait for its tree', async () => {
    const h = await host();
    h.dialogs.open({ kind: 'share' });
    await h.fixture.whenStable();
    expect(open()).toEqual([]);
    openTree(h.store, detail());
    await h.fixture.whenStable();
    expect(open()).toEqual(['Share']);
    expect(h.api.listShares).toHaveBeenCalledTimes(1);
  });
});
