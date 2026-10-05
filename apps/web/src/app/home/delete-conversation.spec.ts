import '@angular/compiler'; // JIT: the component metadata and the DI below.
import { Injector, runInInjectionContext } from '@angular/core';
import { Router } from '@angular/router';
import type { TreeSummary } from '@tangent/shared';
import { ApiClient, ApiError, DEMO_MODE } from '@tangent/web-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TreeSettings } from '../dialogs/tree-settings';
import { Sidebar } from '../sidebar/sidebar';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { HomePage } from './home-page';

/** Template of a JIT-compiled component (the decorator's metadata). */
function templateOf(type: object): string {
  const annotations = (type as { __annotations__?: { template?: string }[] }).__annotations__;
  return annotations?.[0]?.template ?? '';
}

/** A listed conversation's markup, from `start` to the end of its `<li>`. */
function rowOf(template: string, start: string): string {
  const from = template.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  return template.slice(from, template.indexOf('</li>', from));
}

function tree(id: string, title: string): TreeSummary {
  return {
    id,
    title,
    branchCount: 1,
    messageCount: 2,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  } as TreeSummary;
}

/** What the lists call: `remove` on the home page (a summary) and in the sidebar (id, title). */
interface HomeView {
  remove(t: TreeSummary): void;
}
interface SidebarView {
  remove(treeId: string, title: string): void;
}

function setup() {
  const api = { deleteTree: vi.fn(async (): Promise<void> => undefined) };
  const router = { navigate: vi.fn(async () => true) };
  const injector = Injector.create({
    providers: [
      { provide: TreeStore },
      { provide: UiStore },
      { provide: ApiClient, useValue: api },
      { provide: Router, useValue: router },
      { provide: DEMO_MODE, useValue: false },
    ],
  });
  const store = injector.get(TreeStore);
  const ui = injector.get(UiStore);
  store.trees.set([tree('t1', 'Sky colour'), tree('t2', 'Tides')]);
  store.treesLoaded.set(true);
  // HomePage's constructor starts an effect, which needs Angular's change-detection
  // scheduler (absent here); `remove` only reads the store, so the page gets just that.
  const home = Object.assign(Object.create(HomePage.prototype) as HomeView, { store });
  const sidebar = runInInjectionContext(injector, () => new Sidebar()) as unknown as SidebarView;
  return { api, router, store, ui, home, sidebar };
}

describe('Delete on each listed conversation (as in Learn)', () => {
  const confirm = vi.fn(() => true);

  beforeEach(() => {
    vi.useFakeTimers();
    confirm.mockReset().mockReturnValue(true);
    vi.stubGlobal('confirm', confirm);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('the home page renders Delete beside every conversation card, outside its link', () => {
    const t = templateOf(HomePage);
    expect(t).toContain('@for (t of store.trees(); track t.id)');
    const row = rowOf(t, '<li class="tree-row">');
    // The link closes before the button, so a click on Delete never opens the conversation.
    expect(row.indexOf('</a>')).toBeGreaterThan(-1);
    expect(row.indexOf('</a>')).toBeLessThan(row.indexOf('<button'));
    expect(row).toContain('type="button"');
    expect(row).toContain(`[attr.aria-label]="'Delete ' + t.title"`);
    expect(row).toContain('title="Delete conversation"');
    expect(row).toContain('(click)="remove(t)"');
    expect(row).toContain('<app-icon name="trash" />');
    // Not hidden while read-only (it generates nothing) nor in the demo (its backend deletes).
    expect(t.indexOf('<section class="home-list">')).toBeGreaterThan(t.indexOf('@if (readOnly()'));
    expect(t).not.toContain('demo');
  });

  it('the sidebar renders Delete beside every conversation link, outside it', () => {
    const t = templateOf(Sidebar);
    const row = rowOf(t, '<div class="tree-row"');
    expect(row.indexOf('</a>')).toBeLessThan(row.indexOf('<button'));
    expect(row).toContain('<span class="row-actions">');
    expect(row).toContain(`[attr.aria-label]="'Delete ' + title"`);
    expect(row).toContain('title="Delete conversation"');
    expect(row).toContain('(click)="remove(t.id, title)"');
    // The title shown (the open tree's may be renamed since the list loaded).
    expect(t).toContain(
      '@let title = current ? (store.detail()?.tree?.title ?? t.title) : t.title;',
    );
    expect(t.indexOf('class="tree-row"')).toBeLessThan(t.indexOf('@if (!demo)'));
  });

  it('asks with the same words as the settings dialog, then deletes and drops the row', async () => {
    const s = setup();
    s.home.remove(tree('t1', 'Sky colour'));
    expect(confirm).toHaveBeenCalledWith(
      'Delete “Sky colour” with all its branches and messages? Its shares stop working. This cannot be undone.',
    );
    await vi.waitFor(() => expect(s.store.trees().map((t) => t.id)).toEqual(['t2']));
    expect(s.api.deleteTree).toHaveBeenCalledWith('t1');
    expect(s.ui.toasts().map((t) => t.text)).toEqual(['Conversation deleted']);
    // Not the open conversation: nothing navigates.
    expect(s.router.navigate).not.toHaveBeenCalled();
    expect(templateOf(TreeSettings)).toContain('Delete conversation');
  });

  it('cancelling does nothing', async () => {
    const s = setup();
    confirm.mockReturnValue(false);
    s.home.remove(tree('t1', 'Sky colour'));
    s.sidebar.remove('t2', 'Tides');
    await vi.advanceTimersByTimeAsync(0);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(s.api.deleteTree).not.toHaveBeenCalled();
    expect(s.store.trees()).toHaveLength(2);
    expect(s.router.navigate).not.toHaveBeenCalled();
    expect(s.ui.toasts()).toEqual([]);
  });

  it('deleting the open conversation from the sidebar goes home', async () => {
    const s = setup();
    s.store.selectedTreeId.set('t2');
    s.sidebar.remove('t2', 'Tides');
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('“Tides”'));
    await vi.waitFor(() => expect(s.router.navigate).toHaveBeenCalledWith(['/']));
    expect(s.store.trees().map((t) => t.id)).toEqual(['t1']);
  });

  it('a failed delete keeps the row and shows the error toast', async () => {
    const s = setup();
    s.api.deleteTree.mockRejectedValueOnce(new ApiError(500, 'internal', 'Something broke'));
    s.home.remove(tree('t1', 'Sky colour'));
    await vi.waitFor(() => expect(s.ui.toasts()).toHaveLength(1));
    expect(s.ui.toasts()[0]).toMatchObject({ kind: 'error' });
    expect(s.store.trees()).toHaveLength(2);
    expect(s.router.navigate).not.toHaveBeenCalled();
  });
});
