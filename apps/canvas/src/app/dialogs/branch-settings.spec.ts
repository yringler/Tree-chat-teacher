import '@angular/compiler'; // JIT: the component metadata and the DI below.
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { Branch, TreeDetail, UpdateBranchRequest } from '@tangent/shared';
import { ApiClient } from '@tangent/web-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasStore } from '../state/canvas-store';
import { UiStore } from '../state/ui-store';
import { BranchSettings } from './branch-settings';

const T = '2026-01-01T00:00:00.000Z';

function lane(over: Partial<Branch> = {}): Branch {
  return {
    id: 'b',
    treeId: 't1',
    parentBranchId: 'trunk',
    branchPointNodeId: 'a1',
    contextMode: 'path',
    anchorQuote: null,
    title: 'Branch: A wave.',
    titleSource: 'default',
    isPrivate: false,
    providerId: 'openrouter',
    model: 'smart-model',
    funding: 'credit',
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

function detail(b: Branch): TreeDetail {
  return {
    tree: {
      id: 't1',
      accountId: 'u_1',
      title: 'Light',
      systemPrompt: null,
      trunkBranchId: 'trunk',
      createdAt: T,
      updatedAt: T,
    },
    branches: [lane({ id: 'trunk', parentBranchId: null, branchPointNodeId: null }), b],
    nodes: [],
    links: [],
  };
}

describe('Canvas lane settings', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a title given by a reply while open is not reverted (nor pinned) by Save', async () => {
    const api = {
      updateBranch: vi.fn(async (_id: string, req: UpdateBranchRequest) => ({ ...lane(), ...req })),
    };
    const injector = Injector.create({
      providers: [
        { provide: CanvasStore },
        { provide: UiStore },
        { provide: ApiClient, useValue: api },
        { provide: Router, useValue: { navigate: vi.fn(async () => true) } },
      ],
    });
    const store = injector.get(CanvasStore);
    store.detail.set(detail(lane()));
    const d = runInInjectionContext(injector, () => new BranchSettings());
    Object.defineProperty(d, 'state', { value: signal({ branchId: 'b' }) });
    d.ngOnInit();

    store.detail.set(detail(lane({ title: 'Light as a wave', titleSource: 'auto' })));
    d['isPrivate'].set(true);
    await d['save']();
    expect(api.updateBranch).toHaveBeenCalledWith('b', { isPrivate: true });
  });
});
