import { TestBed } from '@angular/core/testing';
import type { Branch, ProviderInfo, Tree, TreeDetail, UpdateBranchRequest } from '@tangent/shared';
import * as fixtures from '@tangent/web-shared/testing';
import {
  node,
  openTree,
  powerProviders,
  provider,
  render,
  signIn,
} from '@tangent/web-shared/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { BranchSettings } from './branch-settings';
import { DialogHost } from './dialog-host';
import { TreeSettings } from './tree-settings';

const CREDIT: ProviderInfo = provider({
  label: 'Tangent credit',
  acceptsUserKey: false,
  keySource: 'server',
  funding: 'credit',
});

/** The trunk "Main thread" on Tangent credit, unless `over` says otherwise. */
const branch = (over: Partial<Branch> = {}): Branch =>
  fixtures.branch('trunk', { title: 'Main thread', funding: 'credit', ...over });

const reply = node('a1', { content: 'A wave.' });

const side = branch({
  id: 'side',
  parentBranchId: 'trunk',
  branchPointNodeId: 'a1',
  title: 'Branch: A wave.',
});

function detail(): TreeDetail {
  return fixtures.detail([reply], [branch(), side], [], { title: 'New conversation' });
}

const tree: Tree = detail().tree;

/**
 * `type` rendered with `inputs`, on tree t1 open at branch `side`, for a
 * member offered Tangent credit; saves answer with what they were sent.
 */
async function open<T>(type: new () => T, inputs: Record<string, unknown> = {}) {
  const api = {
    updateBranch: vi.fn(async (id: string, req: UpdateBranchRequest) => ({
      ...(id === 'side' ? side : branch()),
      ...req,
    })),
    updateTree: vi.fn(async (_id: string, req: Partial<Tree>) => ({ ...tree, ...req })),
  };
  const r = await render(type, {
    inputs,
    providers: powerProviders(TreeStore, api),
    setup: () => {
      const store = TestBed.inject(TreeStore);
      signIn(store.account, { providers: [provider(), CREDIT], builtInCredit: true });
      openTree(store, detail(), 'side');
    },
  });
  return {
    ...r,
    api,
    store: TestBed.inject(TreeStore),
    dialogs: TestBed.inject(UiStore).dialogs,
    user: userEvent.setup(),
  };
}

describe('Branch settings', () => {
  it('a title given by a reply while open is not reverted (nor pinned) by Save', async () => {
    const d = await open(BranchSettings, { branch: side });
    await d.set({ branch: { ...side, title: 'Light as a wave', titleSource: 'auto' } });
    await d.user.click(screen.getByRole('checkbox', { name: /^Private/ }));
    await d.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(d.api.updateBranch).toHaveBeenCalledWith('side', { isPrivate: true });
  });

  it('saves to the branch it was opened on', async () => {
    const d = await open(BranchSettings, { branch: side });
    await d.set({ branch: branch() });
    const title = screen.getByRole('textbox', { name: /^Title/ });
    await d.user.clear(title);
    await d.user.type(title, 'Waves');
    await d.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(d.api.updateBranch).toHaveBeenCalledWith('side', { title: 'Waves' });
  });

  it('closes when the selection moves to another branch (Back, a link), not on a focus change', async () => {
    const d = await open(DialogHost);
    d.dialogs.open({ kind: 'branch-settings' });
    await d.fixture.whenStable();
    screen.getByRole('dialog', { name: 'Branch settings' });
    d.store.setRoute('t1', 'side', 'a1');
    await d.fixture.whenStable();
    screen.getByRole('dialog', { name: 'Branch settings' });
    d.store.setRoute('t1', null, null);
    await d.fixture.whenStable();
    expect(d.dialogs.isOpen('branch-settings')).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Conversation settings', () => {
  it('a title given by the first reply while open is not reverted by Save', async () => {
    const d = await open(TreeSettings, { tree });
    await d.set({ tree: { ...tree, title: 'Light as a wave' } });
    await d.user.type(screen.getByRole('textbox', { name: /^System prompt/ }), 'Be brief.');
    await d.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(d.api.updateTree).toHaveBeenCalledWith('t1', { systemPrompt: 'Be brief.' });
  });
});
