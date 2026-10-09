import '@angular/compiler'; // JIT: the component metadata and the DI below.
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { Branch, TreeDetail, UpdateBranchRequest } from '@tangent/shared';
import { ApiClient, ComposerController, ToastStore } from '@tangent/web-shared';
import * as fixtures from '@tangent/web-shared/testing';
import { branch } from '@tangent/web-shared/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasStore } from '../state/canvas-store';
import { UiStore } from '../state/ui-store';
import { BranchSettings } from './branch-settings';

/** Lane `b` off the trunk's reply, on Tangent credit and Max's model, unless `over` says otherwise. */
const lane = (over: Partial<Branch> = {}): Branch =>
  branch('b', {
    parentBranchId: 'trunk',
    branchPointNodeId: 'a1',
    title: 'Branch: A wave.',
    model: 'max-model',
    funding: 'credit',
    ...over,
  });

/** The tree with its trunk and lane `b`. */
const detail = (b: Branch): TreeDetail =>
  fixtures.detail([], [lane({ id: 'trunk', parentBranchId: null, branchPointNodeId: null }), b]);

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
        { provide: ComposerController },
        { provide: ToastStore },
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
