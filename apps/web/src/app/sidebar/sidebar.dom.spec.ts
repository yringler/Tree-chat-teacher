import { TestBed } from '@angular/core/testing';
import {
  branch,
  detail,
  openTree,
  powerProviders,
  render,
  signIn,
  T,
} from '@tangent/web-shared/testing';
import { screen, within } from '@testing-library/dom';
import { describe, expect, it } from 'vitest';
import { TreeStore } from '../state/tree-store';
import { Sidebar } from './sidebar';

describe('Power: the sidebar', () => {
  it('calls the main thread that, whatever title it has stored, and renames only tangents', async () => {
    await render(Sidebar, {
      providers: powerProviders(TreeStore, {}),
      setup: () => {
        const store = TestBed.inject(TreeStore);
        signIn(store.account);
        store.trees.set([
          { id: 't1', title: 'Light', branchCount: 2, messageCount: 0, createdAt: T, updatedAt: T },
        ]);
        store.treesLoaded.set(true);
        openTree(
          store,
          detail(
            [],
            [
              branch('trunk', { title: 'Waves, renamed' }),
              branch('side', { parentBranchId: 'trunk', title: 'Particles' }),
            ],
          ),
        );
      },
    });
    const outline = screen.getByRole('tree', { name: 'Tangents' });
    expect(
      within(outline)
        .getAllByRole('treeitem')
        .map((li) => li.querySelector('.outline-title')?.textContent?.trim()),
    ).toEqual(['Main thread', 'Particles']);
    expect(
      within(outline)
        .getAllByRole('button', { name: /^Rename/ })
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Rename Particles']);
  });
});
