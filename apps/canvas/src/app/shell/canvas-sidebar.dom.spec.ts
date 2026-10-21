import { TestBed } from '@angular/core/testing';
import { DEMO_MODE } from '@tangent/web-shared';
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
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LayoutStore } from '../layout/layout-store';
import { CanvasStore } from '../state/canvas-store';
import { UiStore } from '../state/ui-store';
import { CanvasSidebar } from './canvas-sidebar';

/** The sidebar, signed in, with one conversation open: its main thread and one lane off it. */
async function sidebar(opts: { demo?: boolean } = {}) {
  await render(CanvasSidebar, {
    providers: [
      ...powerProviders(CanvasStore, {}),
      ...(opts.demo ? [{ provide: DEMO_MODE, useValue: true }] : []),
    ],
    setup: () => {
      const store = TestBed.inject(CanvasStore);
      signIn(store.account);
      store.trees.set([
        { id: 't1', title: 'Light', branchCount: 2, messageCount: 3, createdAt: T, updatedAt: T },
      ]);
      store.treesLoaded.set(true);
      openTree(
        store,
        detail(
          [],
          [
            branch('trunk', { title: 'Light' }),
            branch('side', {
              parentBranchId: 'trunk',
              title: 'Tangent: Particles',
              titleSource: 'default',
            }),
          ],
        ),
      );
    },
  });
  const store = TestBed.inject(CanvasStore);
  return {
    store,
    ui: TestBed.inject(UiStore),
    geo: TestBed.inject(LayoutStore),
    user: userEvent.setup(),
  };
}

function foot(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.sidebar-foot');
  if (!el) throw new Error('no sidebar foot');
  return el;
}

describe('Canvas: the sidebar', () => {
  it('lists the conversations, the open one’s lanes as an outline, and the account entries', async () => {
    await sidebar();
    const list = screen.getByRole('navigation', { name: 'Conversations' });
    const row = within(list).getByRole('link', { name: /^Light/ });
    expect(row.querySelector('.count')?.getAttribute('title')).toBe('2 lanes, 3 messages');
    const outline = screen.getByRole('tree', { name: 'Lanes' });
    expect(
      within(outline)
        .getAllByRole('treeitem')
        .map((li) => li.querySelector('.outline-title')?.textContent?.trim()),
    ).toEqual(['Light', 'Particles']);
    expect([...foot().querySelectorAll('a, button')].map((el) => el.textContent?.trim())).toEqual([
      'Shares',
      'Keys',
      'Billing',
      'Import backup',
      'Account',
    ]);
    // Power's pages: a full page load from /canvas/.
    expect(within(foot()).getByRole('link', { name: 'Shares' }).getAttribute('href')).toBe(
      '/shares',
    );
    expect(within(foot()).getByRole('link', { name: 'Billing' }).getAttribute('href')).toBe(
      '/billing',
    );
  });

  it('opens Keys and Account in Canvas’s dialogs', async () => {
    const s = await sidebar();
    await s.user.click(within(foot()).getByRole('button', { name: 'Keys' }));
    expect(s.ui.dialogs.get('keys')).toBeDefined();
    await s.user.click(within(foot()).getByRole('button', { name: 'Account' }));
    expect(s.ui.dialogs.get('account')).toBeDefined();
  });

  it('selects a lane picked in the outline, and moves the canvas back to it when picked again', async () => {
    const s = await sidebar();
    const go = vi.spyOn(s.store, 'go').mockImplementation(() => undefined);
    const centerOn = vi.spyOn(s.geo, 'centerOn').mockImplementation(() => undefined);
    const outline = screen.getByRole('tree', { name: 'Lanes' });

    // Another lane: selecting it is enough, the canvas page follows the selection.
    await s.user.click(within(outline).getByRole('button', { name: /^Particles/ }));
    expect(go).toHaveBeenCalledWith('side');
    expect(centerOn).not.toHaveBeenCalled();

    // The selected one: the selection doesn't change, so the sidebar moves the canvas itself.
    await s.user.click(within(outline).getByRole('button', { name: /^Light/ }));
    expect(centerOn).toHaveBeenCalledWith('trunk');
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('offers only Import backup and Leave the demo in the demo', async () => {
    await sidebar({ demo: true });
    expect([...foot().querySelectorAll('a, button')].map((el) => el.textContent?.trim())).toEqual([
      'Import backup',
      'Leave the demo',
    ]);
    expect(within(foot()).getByRole('link', { name: 'Leave the demo' }).getAttribute('href')).toBe(
      '/welcome',
    );
  });
});
