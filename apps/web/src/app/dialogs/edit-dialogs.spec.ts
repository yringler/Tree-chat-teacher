import '@angular/compiler'; // JIT: the component metadata and the DI below.
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { Branch, ChatNode, Tree, TreeDetail, UpdateBranchRequest } from '@tangent/shared';
import { ApiClient, ToastStore } from '@tangent/web-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsStore } from '../state/settings-store';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { BranchSettings } from './branch-settings';
import { TreeSettings } from './tree-settings';

const at = '2026-10-01T00:00:00.000Z';

const tree: Tree = {
  id: 't1',
  accountId: 'p_1',
  title: 'New conversation',
  systemPrompt: null,
  trunkBranchId: 'trunk',
  createdAt: at,
  updatedAt: at,
};

function branch(over: Partial<Branch> = {}): Branch {
  return {
    id: 'trunk',
    treeId: 't1',
    parentBranchId: null,
    branchPointNodeId: null,
    contextMode: 'path',
    anchorQuote: null,
    title: 'Main thread',
    titleSource: 'default',
    isPrivate: false,
    providerId: 'openrouter',
    model: 'a/b',
    funding: 'credit',
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

const reply: ChatNode = {
  id: 'a1',
  treeId: 't1',
  branchId: 'trunk',
  parentId: null,
  seq: 0,
  role: 'assistant',
  content: 'A wave.',
  status: 'complete',
  error: null,
  providerId: null,
  model: null,
  usage: null,
  createdAt: at,
};

const side = branch({
  id: 'side',
  parentBranchId: 'trunk',
  branchPointNodeId: 'a1',
  title: 'Branch: A wave.',
});

function detail(): TreeDetail {
  return { tree, branches: [branch(), side], nodes: [reply], links: [] };
}

function setup() {
  const api = {
    updateBranch: vi.fn(async (id: string, req: UpdateBranchRequest) => ({
      ...(id === 'side' ? side : branch()),
      ...req,
    })),
    updateTree: vi.fn(async (_id: string, req: Partial<Tree>) => ({ ...tree, ...req })),
  };
  const injector = Injector.create({
    providers: [
      { provide: TreeStore },
      { provide: UiStore },
      { provide: ToastStore },
      { provide: SettingsStore },
      { provide: ApiClient, useValue: api },
      { provide: Router, useValue: { navigate: vi.fn(async () => true) } },
    ],
  });
  const store = injector.get(TreeStore);
  const ui = injector.get(UiStore);
  store.detail.set(detail());
  store.setRoute('t1', 'side', null);
  return { api, store, ui, injector };
}

describe('Branch settings', () => {
  afterEach(() => vi.restoreAllMocks());

  function open(s: ReturnType<typeof setup>) {
    const live = signal(side);
    const d = runInInjectionContext(s.injector, () => new BranchSettings());
    // The dialog host binds the live selected branch.
    Object.defineProperty(d, 'branch', { value: live });
    d.ngOnInit();
    s.ui.branchSettingsOpen.set(true);
    return { d, live };
  }

  it('a title given by a reply while open is not reverted (nor pinned) by Save', async () => {
    const s = setup();
    const { d, live } = open(s);
    live.set({ ...side, title: 'Light as a wave', titleSource: 'auto' });
    d['isPrivate'].set(true);
    await d['save']();
    expect(s.api.updateBranch).toHaveBeenCalledWith('side', { isPrivate: true });
  });

  it('saves to the branch it was opened on', async () => {
    const s = setup();
    const { d, live } = open(s);
    live.set(branch());
    d['title'].set('Waves');
    await d['save']();
    expect(s.api.updateBranch).toHaveBeenCalledWith('side', { title: 'Waves' });
  });

  it('closes when the selection moves to another branch (Back, a link), not on a focus change', () => {
    const s = setup();
    open(s);
    s.store.setRoute('t1', 'side', 'a1');
    expect(s.ui.branchSettingsOpen()).toBe(true);
    s.store.setRoute('t1', null, null);
    expect(s.ui.branchSettingsOpen()).toBe(false);
  });
});

describe('Conversation settings', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a title given by the first reply while open is not reverted by Save', async () => {
    const s = setup();
    const live = signal(tree);
    const d = runInInjectionContext(s.injector, () => new TreeSettings());
    Object.defineProperty(d, 'tree', { value: live });
    d.ngOnInit();
    live.set({ ...tree, title: 'Light as a wave' });
    d['systemPrompt'].set('Be brief.');
    await d['save']();
    expect(s.api.updateTree).toHaveBeenCalledWith('t1', { systemPrompt: 'Be brief.' });
  });
});
