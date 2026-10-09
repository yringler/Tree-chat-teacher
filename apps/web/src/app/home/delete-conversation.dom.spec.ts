import type { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import type { TreeSummary } from '@tangent/shared';
import { ApiError, ToastStore } from '@tangent/web-shared';
import {
  detail,
  membership,
  openTree,
  powerProviders,
  render,
  signIn,
  T,
} from '@tangent/web-shared/testing';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TreeSettings } from '../dialogs/tree-settings';
import { Sidebar } from '../sidebar/sidebar';
import { TreeStore } from '../state/tree-store';
import { HomePage } from './home-page';

function tree(id: string, title: string): TreeSummary {
  return { id, title, branchCount: 1, messageCount: 2, createdAt: T, updatedAt: T };
}

const QUESTION = (title: string) =>
  `Delete “${title}” with all its branches and messages? Its shares stop working. This cannot be undone.`;

/** `type` over the conversations "Sky colour" (t1) and "Tides" (t2); `open`: t2 is open, renamed "Tides, again". */
async function list<C>(type: Type<C>, opts: { open?: boolean; lapsed?: boolean } = {}) {
  const api = { deleteTree: vi.fn(async (_id: string): Promise<void> => undefined) };
  const r = await render(type, {
    providers: powerProviders(TreeStore, api),
    setup: () => {
      const store = TestBed.inject(TreeStore);
      signIn(store.account, {
        membership: opts.lapsed ? membership({ status: 'inactive' }) : undefined,
      });
      store.trees.set([tree('t1', 'Sky colour'), tree('t2', 'Tides')]);
      store.treesLoaded.set(true);
      if (opts.open)
        openTree(store, detail([], undefined, [], { id: 't2', title: 'Tides, again' }));
    },
    ...(type === TreeSettings ? { inputs: { tree: detail().tree } } : {}),
  });
  const store = TestBed.inject(TreeStore);
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  return {
    ...r,
    api,
    store,
    navigate,
    toasts: TestBed.inject(ToastStore),
    user: userEvent.setup(),
  };
}

const titles = (s: TreeStore) => s.trees().map((t) => t.title);

describe('Delete on each listed conversation', () => {
  const confirm = vi.fn(() => true);

  beforeEach(() => {
    confirm.mockReset().mockReturnValue(true);
    vi.stubGlobal('confirm', confirm);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('the home page: Delete beside each card, outside its link; it asks, deletes and drops the row', async () => {
    const h = await list(HomePage);
    const remove = screen.getByRole('button', { name: 'Delete Sky colour' });
    const card = screen.getByRole('link', { name: /Sky colour/ });
    expect(card.getAttribute('href')).toBe('/t/t1');
    expect(card.contains(remove)).toBe(false);
    await h.user.click(remove);
    expect(confirm).toHaveBeenCalledWith(QUESTION('Sky colour'));
    await vi.waitFor(() => expect(titles(h.store)).toEqual(['Tides']));
    expect(h.api.deleteTree).toHaveBeenCalledWith('t1');
    expect(screen.queryByRole('button', { name: 'Delete Sky colour' })).toBeNull();
    expect(h.toasts.toasts().map((t) => t.text)).toEqual(['Conversation deleted']);
    // Not the open conversation: nothing navigates.
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('cancelling does nothing', async () => {
    const h = await list(HomePage);
    confirm.mockReturnValue(false);
    await h.user.click(screen.getByRole('button', { name: 'Delete Tides' }));
    expect(h.api.deleteTree).not.toHaveBeenCalled();
    expect(titles(h.store)).toEqual(['Sky colour', 'Tides']);
  });

  it('stays while nothing can be generated: deleting generates nothing', async () => {
    await list(HomePage, { lapsed: true });
    screen.getByRole('region', { name: /membership/ });
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    screen.getByRole('button', { name: 'Delete Sky colour' });
  });

  it('a failed delete keeps the row and says why', async () => {
    const h = await list(HomePage);
    h.api.deleteTree.mockRejectedValueOnce(new ApiError(500, 'internal', 'Something broke'));
    await h.user.click(screen.getByRole('button', { name: 'Delete Sky colour' }));
    await vi.waitFor(() => expect(h.toasts.toasts()[0]).toMatchObject({ kind: 'error' }));
    expect(titles(h.store)).toEqual(['Sky colour', 'Tides']);
  });

  it('the sidebar: Delete beside each link, named as shown (the open one may be renamed)', async () => {
    const s = await list(Sidebar, { open: true });
    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    const open = within(nav).getByRole('link', { name: /Tides, again/ });
    expect(open.getAttribute('aria-current')).toBe('true');
    const remove = within(nav).getByRole('button', { name: 'Delete Tides, again' });
    expect(open.contains(remove)).toBe(false);
    within(nav).getByRole('button', { name: 'Delete Sky colour' });

    // Deleting the open conversation goes home.
    await s.user.click(remove);
    expect(confirm).toHaveBeenCalledWith(QUESTION('Tides, again'));
    await vi.waitFor(() => expect(s.navigate).toHaveBeenCalledWith(['/']));
    expect(titles(s.store)).toEqual(['Sky colour']);
  });

  it('the conversation’s settings ask the same', async () => {
    const t = await list(TreeSettings, { open: true });
    confirm.mockReturnValue(false);
    await t.user.click(screen.getByRole('button', { name: 'Delete conversation' }));
    expect(confirm).toHaveBeenCalledWith(QUESTION('Light'));
  });
});
