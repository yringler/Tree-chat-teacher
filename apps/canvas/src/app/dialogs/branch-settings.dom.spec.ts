import { TestBed } from '@angular/core/testing';
import type { Branch, TreeDetail, UpdateBranchRequest } from '@tangent/shared';
import * as fixtures from '@tangent/web-shared/testing';
import { branch, openTree, powerProviders, render, signIn } from '@tangent/web-shared/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CanvasStore } from '../state/canvas-store';
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
  it('a title given by a reply while open is not reverted (nor pinned) by Save', async () => {
    const api = {
      updateBranch: vi.fn(async (_id: string, req: UpdateBranchRequest) => ({ ...lane(), ...req })),
    };
    const r = await render(BranchSettings, {
      inputs: { state: { branchId: 'b' } },
      providers: powerProviders(CanvasStore, api),
      setup: () => {
        const store = TestBed.inject(CanvasStore);
        signIn(store.account);
        openTree(store, detail(lane()), 'b');
      },
    });
    const store = TestBed.inject(CanvasStore);
    store.detail.set(detail(lane({ title: 'Light as a wave', titleSource: 'auto' })));
    await r.fixture.whenStable();
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: /^Private/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.updateBranch).toHaveBeenCalledWith('b', { isPrivate: true });
  });
});
