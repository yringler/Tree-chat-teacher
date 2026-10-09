import { TestBed } from '@angular/core/testing';
import type { CreateShareRequest, ShareSummary } from '@tangent/shared';
import { ApiError, ToastStore } from '@tangent/web-shared';
import {
  branch,
  deferred,
  detail,
  node,
  openTree,
  powerProviders,
  render,
  share,
  signIn,
  T,
} from '@tangent/web-shared/testing';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TreeStore } from '../state/tree-store';
import { ShareDialog } from './share-dialog';

/** The Share dialog on tree t1 "Primes" (n1 → n2 on the trunk, "Twin primes" off n2), listing `list`. */
async function open(list: ShareSummary[], firstList?: () => Promise<ShareSummary[]>) {
  const api = {
    listShares: vi.fn(async (): Promise<ShareSummary[]> => list),
    createShare: vi.fn(async (req: CreateShareRequest) =>
      share('new', { scope: req.scope, mode: req.mode ?? 'snapshot', title: 'New link' }),
    ),
    revokeShare: vi.fn(async (id: string) => ({
      ...list.find((s) => s.id === id)!,
      state: 'revoked' as const,
      revokedAt: T,
    })),
    republishShare: vi.fn(async (id: string) => ({
      ...list.find((s) => s.id === id)!,
      version: 2,
    })),
    deleteShare: vi.fn(async (_id: string) => undefined),
  };
  // The dialog asks for the list as it opens.
  if (firstList) api.listShares.mockImplementationOnce(firstList);
  const r = await render(ShareDialog, {
    providers: powerProviders(TreeStore, api),
    setup: () => {
      const store = TestBed.inject(TreeStore);
      signIn(store.account);
      openTree(
        store,
        detail(
          [
            node('n1', { role: 'user', content: 'What is a prime?' }),
            node('n2', { parentId: 'n1', seq: 1, content: 'A number…' }),
            node('n3', { branchId: 'side', parentId: 'n2', role: 'user', content: 'And twins?' }),
          ],
          [
            branch('trunk', { title: 'Main thread' }),
            branch('side', {
              parentBranchId: 'trunk',
              branchPointNodeId: 'n2',
              title: 'Twin primes',
            }),
          ],
          [],
          { title: 'Primes' },
        ),
      );
    },
  });
  return { ...r, api, toasts: TestBed.inject(ToastStore), user: userEvent.setup() };
}

const existing = () => screen.getByRole('region', { name: /Links to this conversation/ });
const rows = () => within(existing()).queryAllByRole('listitem');

describe('Share dialog: this conversation’s links', () => {
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

  it('says it is loading; a link made meanwhile is kept', async () => {
    const list = deferred<ShareSummary[]>();
    const d = await open([], () => list.promise);
    expect(within(existing()).getByRole('status').textContent).toBe('Loading shares…');
    await d.user.click(screen.getByRole('button', { name: 'Create link' }));
    list.resolve([share('a', { title: 'Old link' })]);
    await vi.waitFor(() =>
      expect(rows().map((r) => r.querySelector('.share-title')?.textContent)).toEqual([
        'New link',
        'Old link',
      ]),
    );
  });

  it('lists only this conversation’s links, the branch a path link ends in, without the link back', async () => {
    await open([
      share('a', { scope: 'path', targetNodeId: 'n3', mode: 'live', title: 'Twins' }),
      share('b', { treeId: 't2', treeTitle: 'Tides', title: 'Elsewhere' }),
      share('c', { title: 'Whole thing' }),
    ]);
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    const [twins, whole] = rows();
    expect(twins!.textContent).toContain('Twins');
    expect(twins!.textContent).toContain('ends in “Twin primes”');
    expect(whole!.textContent).toContain('Whole thing');
    expect(screen.queryByText('Elsewhere')).toBeNull();
    // The rows are the Shares page's cards, minus the link to the conversation they are in.
    expect(within(existing()).queryByRole('link', { name: 'Primes' })).toBeNull();
  });

  it('with none, says so', async () => {
    await open([share('b', { treeId: 't2' })]);
    await vi.waitFor(() =>
      expect(within(existing()).getByText('No shares of this conversation yet.')).toBeTruthy(),
    );
  });

  it('a new link shows its address, and joins the top of the list', async () => {
    const d = await open([share('a', { title: 'Old link' })]);
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    await d.user.click(screen.getByRole('radio', { name: /Live/ }));
    await d.user.click(screen.getByRole('button', { name: 'Create link' }));
    expect(d.api.createShare).toHaveBeenCalledWith(
      expect.objectContaining({ treeId: 't1', scope: 'tree', mode: 'live' }),
    );
    await vi.waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Share link' }).value).toBe(
        'https://tangent.example/s/tok-new',
      ),
    );
    expect(screen.getByText(/Anyone with this link can read this conversation\./)).toBeTruthy();
    expect(rows().map((r) => r.querySelector('.share-title')?.textContent)).toEqual([
      'New link',
      'Old link',
    ]);
  });

  it('a failed load says why, and Retry tries again', async () => {
    const d = await open([share('a', { title: 'Old link' })], async () => {
      throw new ApiError(500, 'internal', 'Something broke');
    });
    const alert = await within(existing()).findByRole('alert');
    expect(alert.textContent).toContain('Something broke');
    await d.user.click(within(alert).getByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
  });

  it('revoking from a row asks first, then shows it revoked', async () => {
    const d = await open([share('a', { title: 'Old link' })]);
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    const revoke = within(rows()[0]!).getByRole('button', { name: 'Revoke' });
    confirm.mockReturnValueOnce(false);
    await d.user.click(revoke);
    expect(d.api.revokeShare).not.toHaveBeenCalled();
    await d.user.click(revoke);
    expect(confirm).toHaveBeenLastCalledWith(
      'Revoke “Old link”? The link stops working immediately and cannot be re-enabled.',
    );
    await vi.waitFor(() => expect(rows()[0]!.textContent).toContain('revoked'));
    expect(within(rows()[0]!).queryByRole('button', { name: 'Revoke' })).toBeNull();
    expect(d.toasts.toasts().map((t) => t.text)).toEqual(['Link revoked']);
  });

  it('deleting from a row asks first, then drops it; a failure keeps it', async () => {
    const d = await open([share('a', { title: 'Old link' }), share('b', { title: 'Keep' })]);
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    await d.user.click(within(rows()[0]!).getByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenLastCalledWith(
      'Delete “Old link”? The link stops working immediately. This cannot be undone.',
    );
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(d.api.deleteShare).toHaveBeenCalledWith('a');

    d.api.deleteShare.mockRejectedValueOnce(new ApiError(500, 'internal', 'Nope'));
    await d.user.click(within(rows()[0]!).getByRole('button', { name: 'Delete' }));
    await vi.waitFor(() =>
      expect(d.toasts.toasts().at(-1)).toMatchObject({ kind: 'error', text: 'Nope' }),
    );
    expect(rows()).toHaveLength(1);
  });

  it('republishing from a row asks the server for the new version', async () => {
    const d = await open([share('a')]);
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    await d.user.click(within(rows()[0]!).getByRole('button', { name: 'Republish' }));
    expect(d.api.republishShare).toHaveBeenCalledWith('a');
  });
});
