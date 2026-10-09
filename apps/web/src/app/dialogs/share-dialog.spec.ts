import '@angular/compiler'; // JIT: the component metadata and the DI below.
import { Injector, runInInjectionContext } from '@angular/core';
import { Router } from '@angular/router';
import type {
  Branch,
  ChatNode,
  CreateShareRequest,
  ShareSummary,
  TreeDetail,
} from '@tangent/shared';
import { ApiClient, ApiError, DEMO_MODE, ToastStore } from '@tangent/web-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareCard } from '../shares/share-card';
import { shareBranchTitle, sharesOfTree } from '../shares/share-list';
import { TreeStore } from '../state/tree-store';
import { SettingsStore } from '../state/settings-store';
import { UiStore } from '../state/ui-store';
import { ShareDialog } from './share-dialog';

/** Template of a JIT-compiled component (the decorator's metadata). */
function templateOf(type: object): string {
  const annotations = (type as { __annotations__?: { template?: string }[] }).__annotations__;
  return annotations?.[0]?.template ?? '';
}

const at = '2026-10-01T00:00:00.000Z';

function share(id: string, over: Partial<ShareSummary> = {}): ShareSummary {
  return {
    id,
    token: `tok-${id}`,
    accountId: 'p_1',
    treeId: 't1',
    scope: 'tree',
    targetNodeId: null,
    includeAncestors: false,
    mode: 'snapshot',
    title: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: at,
    updatedAt: at,
    publishedAt: at,
    version: 1,
    viewCount: 0,
    treeTitle: 'Primes',
    url: `https://tangent.example/s/tok-${id}`,
    state: 'active',
    ...over,
  };
}

/** Tree t1: the trunk (n1, n2) and a side branch "Twin primes" (n3) off n2. */
function detail(): TreeDetail {
  const branch = (over: Partial<Branch>): Branch => ({
    id: 'trunk',
    treeId: 't1',
    parentBranchId: null,
    branchPointNodeId: null,
    contextMode: 'path',
    anchorQuote: null,
    title: 'Main thread',
    titleSource: 'default',
    isPrivate: false,
    providerId: 'fake',
    model: 'fake-1',
    funding: 'own-key',
    createdAt: at,
    updatedAt: at,
    ...over,
  });
  const node = (over: Partial<ChatNode>): ChatNode => ({
    id: 'n1',
    treeId: 't1',
    branchId: 'trunk',
    parentId: null,
    seq: 0,
    role: 'user',
    content: 'What is a prime?',
    status: 'complete',
    error: null,
    providerId: null,
    model: null,
    usage: null,
    createdAt: at,
    ...over,
  });
  return {
    tree: {
      id: 't1',
      accountId: 'p_1',
      title: 'Primes',
      systemPrompt: null,
      trunkBranchId: 'trunk',
      createdAt: at,
      updatedAt: at,
    },
    branches: [
      branch({}),
      branch({
        id: 'side',
        parentBranchId: 'trunk',
        branchPointNodeId: 'n2',
        title: 'Twin primes',
        titleSource: 'user',
      }),
    ],
    nodes: [
      node({}),
      node({ id: 'n2', parentId: 'n1', seq: 1, role: 'assistant', content: 'A number…' }),
      node({ id: 'n3', branchId: 'side', parentId: 'n2', seq: 0, content: 'And twins?' }),
    ],
    links: [],
  };
}

/** What the tests call on the dialog (protected in the component). */
interface DialogView {
  loading(): boolean;
  loadError(): string | null;
  rows(): { share: ShareSummary; branch: string | null }[];
  load(): Promise<void>;
  create(): Promise<void>;
  replace(s: ShareSummary): void;
  drop(id: string): void;
  created(): ShareSummary | null;
}
interface CardView {
  revoke(): Promise<boolean>;
  republish(): Promise<boolean>;
  remove(): Promise<boolean>;
}

function setup(list: ShareSummary[]) {
  const api = {
    listShares: vi.fn(async (): Promise<ShareSummary[]> => list),
    createShare: vi.fn(async (req: CreateShareRequest) =>
      share('new', { scope: req.scope, mode: req.mode ?? 'snapshot', createdAt: at }),
    ),
    revokeShare: vi.fn(async (id: string) =>
      share(id, { ...list.find((s) => s.id === id), state: 'revoked', revokedAt: at }),
    ),
    republishShare: vi.fn(async (id: string) => share(id, { version: 2 })),
    deleteShare: vi.fn(async (_id: string) => undefined),
  };
  const injector = Injector.create({
    providers: [
      { provide: TreeStore },
      { provide: UiStore },
      { provide: ToastStore },
      { provide: SettingsStore },
      { provide: ApiClient, useValue: api },
      { provide: Router, useValue: { navigate: vi.fn(async () => true) } },
      { provide: DEMO_MODE, useValue: false },
    ],
  });
  const store = injector.get(TreeStore);
  const ui = injector.get(UiStore);
  const toasts = injector.get(ToastStore);
  store.selectedTreeId.set('t1');
  store.detail.set(detail());
  const open = () =>
    runInInjectionContext(injector, () => new ShareDialog()) as unknown as DialogView;
  /** A row's card, wired to `dialog` as the template wires it. */
  const card = (s: ShareSummary, dialog: DialogView) => {
    const c = runInInjectionContext(injector, () => new ShareCard());
    Object.defineProperty(c, 'share', { value: () => s });
    c.changed.subscribe((u) => dialog.replace(u));
    c.deleted.subscribe((id) => dialog.drop(id));
    return c as unknown as CardView;
  };
  return { api, store, ui, toasts, open, card };
}

describe('share list helpers', () => {
  it('keeps one conversation’s shares, in order', () => {
    const list = [share('a'), share('b', { treeId: 't2' }), share('c')];
    expect(sharesOfTree(list, 't1').map((s) => s.id)).toEqual(['a', 'c']);
    expect(sharesOfTree(list, 't3')).toEqual([]);
  });

  it('names the branch a subtree or path share starts from or ends in', () => {
    const s = setup([]);
    const index = s.store.index();
    expect(shareBranchTitle(share('a'), index)).toBeNull();
    expect(shareBranchTitle(share('b', { scope: 'path', targetNodeId: 'n3' }), index)).toBe(
      'Twin primes',
    );
    expect(shareBranchTitle(share('c', { scope: 'subtree', targetNodeId: 'n1' }), index)).toBe(
      'Main thread',
    );
    // A message no longer in the tree, or no tree loaded.
    expect(shareBranchTitle(share('d', { scope: 'path', targetNodeId: 'gone' }), index)).toBeNull();
    expect(shareBranchTitle(share('e', { scope: 'path', targetNodeId: 'n3' }), null)).toBeNull();
  });
});

describe('Share dialog: this conversation’s existing links', () => {
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

  it('loads, then lists only this conversation’s shares with their branch', async () => {
    const s = setup([
      share('a', { scope: 'path', targetNodeId: 'n3', mode: 'live', title: 'Twins' }),
      share('b', { treeId: 't2', treeTitle: 'Tides' }),
      share('c'),
    ]);
    const d = s.open();
    expect(d.loading()).toBe(true);
    await vi.waitFor(() => expect(d.loading()).toBe(false));
    expect(s.api.listShares).toHaveBeenCalledTimes(1);
    expect(d.rows().map((r) => [r.share.id, r.branch])).toEqual([
      ['a', 'Twin primes'],
      ['c', null],
    ]);
    expect(d.loadError()).toBeNull();
  });

  it('with none, the empty state; the template has it and the loading state', async () => {
    const s = setup([share('b', { treeId: 't2' })]);
    const d = s.open();
    await vi.waitFor(() => expect(d.loading()).toBe(false));
    expect(d.rows()).toEqual([]);
    const t = templateOf(ShareDialog);
    expect(t).toContain('No shares of this conversation yet.');
    expect(t).toContain('Loading shares…');
    // Rows are the Shares page's cards, without the link back to the conversation.
    expect(t).toContain('app-share-card');
    expect(t).toContain('[showTree]="false"');
    expect(t).toContain('[branch]="r.branch"');
    expect(t).toContain('(changed)="replace($event)"');
  });

  it('a new link joins the top of the list', async () => {
    const s = setup([share('a')]);
    const d = s.open();
    await vi.waitFor(() => expect(d.loading()).toBe(false));
    await d.create();
    expect(s.api.createShare).toHaveBeenCalledWith(
      expect.objectContaining({ treeId: 't1', scope: 'tree', mode: 'snapshot' }),
    );
    expect(d.created()?.id).toBe('new');
    expect(d.rows().map((r) => r.share.id)).toEqual(['new', 'a']);
  });

  it('a link made while the list is loading is kept', async () => {
    let resolve: (l: ShareSummary[]) => void = () => undefined;
    const s = setup([]);
    s.api.listShares.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const d = s.open();
    await d.create();
    resolve([share('a')]);
    await vi.waitFor(() => expect(d.loading()).toBe(false));
    expect(d.rows().map((r) => r.share.id)).toEqual(['new', 'a']);
  });

  it('a failed load says why and can be retried', async () => {
    const s = setup([share('a')]);
    s.api.listShares.mockRejectedValueOnce(new ApiError(500, 'internal', 'Something broke'));
    const d = s.open();
    await vi.waitFor(() => expect(d.loadError()).toBe('Something broke'));
    expect(d.rows()).toEqual([]);
    await d.load();
    expect(d.loadError()).toBeNull();
    expect(d.rows().map((r) => r.share.id)).toEqual(['a']);
  });

  it('revoking from a row asks first, then shows the revoked share', async () => {
    const s = setup([share('a', { title: 'Old link' })]);
    const d = s.open();
    await vi.waitFor(() => expect(d.loading()).toBe(false));
    const card = s.card(d.rows()[0]!.share, d);

    confirm.mockReturnValueOnce(false);
    expect(await card.revoke()).toBe(false);
    expect(s.api.revokeShare).not.toHaveBeenCalled();

    expect(await card.revoke()).toBe(true);
    expect(confirm).toHaveBeenLastCalledWith(
      'Revoke “Old link”? The link stops working immediately and cannot be re-enabled.',
    );
    expect(s.api.revokeShare).toHaveBeenCalledWith('a');
    expect(d.rows()[0]!.share.state).toBe('revoked');
    expect(s.toasts.toasts().map((t) => t.text)).toEqual(['Link revoked']);
  });

  it('deleting from a row asks first, then drops the share; a failure keeps it', async () => {
    const s = setup([share('a', { title: 'Old link' }), share('b', { state: 'revoked' })]);
    const d = s.open();
    await vi.waitFor(() => expect(d.loading()).toBe(false));
    const [a, b] = d.rows().map((r) => s.card(r.share, d));

    confirm.mockReturnValueOnce(false);
    expect(await a!.remove()).toBe(false);
    expect(s.api.deleteShare).not.toHaveBeenCalled();

    expect(await a!.remove()).toBe(true);
    expect(confirm).toHaveBeenLastCalledWith(
      'Delete “Old link”? The link stops working immediately. This cannot be undone.',
    );
    expect(s.api.deleteShare).toHaveBeenCalledWith('a');
    expect(d.rows().map((r) => r.share.id)).toEqual(['b']);
    expect(s.toasts.toasts().map((t) => t.text)).toEqual(['Share deleted']);

    s.api.deleteShare.mockRejectedValueOnce(new ApiError(500, 'internal', 'Nope'));
    expect(await b!.remove()).toBe(false);
    expect(confirm).toHaveBeenLastCalledWith('Delete “Primes”? This cannot be undone.');
    expect(d.rows().map((r) => r.share.id)).toEqual(['b']);
    expect(s.toasts.toasts().at(-1)).toMatchObject({ kind: 'error', text: 'Nope' });
  });

  it('republishing from a row swaps in the new version; a failure shows the error', async () => {
    const s = setup([share('a')]);
    const d = s.open();
    await vi.waitFor(() => expect(d.loading()).toBe(false));
    const card = s.card(d.rows()[0]!.share, d);
    expect(await card.republish()).toBe(true);
    expect(d.rows()[0]!.share.version).toBe(2);

    s.api.republishShare.mockRejectedValueOnce(new ApiError(500, 'internal', 'Nope'));
    expect(await card.republish()).toBe(false);
    expect(s.toasts.toasts().at(-1)).toMatchObject({ kind: 'error', text: 'Nope' });
  });
});
