import { TestBed } from '@angular/core/testing';
import type { BillingSummary, ProviderInfo } from '@tangent/shared';
import {
  branch,
  detail,
  membership,
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
import { UiStore, type BranchDialogState } from '../state/ui-store';
import { BranchDialog } from './branch-dialog';

const OWN_KEY = provider({ models: [{ id: 'vendor/x', label: 'X' }] });
const CREDIT: ProviderInfo = {
  ...OWN_KEY,
  label: 'Tangent credit',
  defaultModel: 'vendor/default',
  acceptsUserKey: false,
  keySource: 'server',
  funding: 'credit',
};

/** The branch dialog on reply a1 of an own-key trunk; `lapsed`: the membership it needs ended. */
async function open(state: Partial<BranchDialogState> = {}, opts: { lapsed?: boolean } = {}) {
  const api = {
    billing: vi.fn(async () => ({ availableMicros: 2_000_000 }) as BillingSummary),
  };
  const r = await render(BranchDialog, {
    providers: powerProviders(TreeStore, api),
    setup: async () => {
      const store = TestBed.inject(TreeStore);
      signIn(store.account, {
        membership: opts.lapsed ? membership({ status: 'inactive' }) : undefined,
        providers: [OWN_KEY, CREDIT],
        builtInCredit: true,
      });
      await store.account.refreshBilling();
      openTree(
        store,
        detail(
          [
            node('a1', {
              content: 'Light is a wave.\n\n<tangents>\n- Photons\n</tangents>',
            }),
          ],
          [branch('trunk', { model: 'vendor/x' })],
        ),
      );
      TestBed.inject(UiStore).dialogs.open({ kind: 'branch', fromNodeId: 'a1', quote: null });
    },
    inputs: { state: { fromNodeId: 'a1', quote: 'a wave', ...state } },
  });
  const store = TestBed.inject(TreeStore);
  const created = vi.fn(async () => branch('new'));
  vi.spyOn(store, 'createBranch').mockImplementation(created);
  vi.spyOn(store, 'startBranch').mockImplementation(created);
  return { ...r, store, ui: TestBed.inject(UiStore), user: userEvent.setup() };
}

const field = (name: RegExp) => screen.getByRole<HTMLTextAreaElement>('textbox', { name });

describe('Branch from here (power)', () => {
  it('shows the message branched from, without its tangents, and the quote it was opened with', async () => {
    await open();
    screen.getByRole('dialog', { name: 'Branch from here' });
    expect(screen.getByText('Light is a wave.')).toBeTruthy();
    expect(screen.queryByText(/Photons/)).toBeNull();
    expect(field(/Anchor quote/).value).toBe('a wave');
  });

  it('creates the branch on the parent’s route, and closes', async () => {
    const d = await open();
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Provider' }).value).toBe(
      'openrouter',
    );
    await d.user.click(screen.getByRole('radio', { name: /Independent/ }));
    await d.user.click(screen.getByRole('button', { name: 'Create branch' }));
    expect(d.store.createBranch).toHaveBeenCalledWith({
      fromNodeId: 'a1',
      contextMode: 'independent',
      anchorQuote: 'a wave',
      isPrivate: false,
    });
    expect(d.ui.dialogs.get('branch')).toBeNull();
  });

  it('with a starting message, creates and asks (Ctrl+Enter too)', async () => {
    const d = await open();
    await d.user.click(screen.getByRole('button', { name: 'Remove quote' }));
    await d.user.type(field(/Starting message/), 'Why?');
    expect(screen.getByRole('button', { name: 'Create and ask' })).toBeTruthy();
    await d.user.keyboard('{Control>}{Enter}{/Control}');
    expect(d.store.startBranch).toHaveBeenCalledWith(
      expect.objectContaining({ fromNodeId: 'a1', anchorQuote: null }),
      'Why?',
    );
  });

  it('a question carried from "Ask your own" is the first message, cleared once created', async () => {
    const onCreated = vi.fn();
    const d = await open({ message: 'Why does it bend?', onCreated });
    expect(screen.queryByRole('textbox', { name: /Starting message/ })).toBeNull();
    expect(screen.getByText('Why does it bend?')).toBeTruthy();
    await d.user.click(screen.getByRole('button', { name: 'Create and ask' }));
    expect(d.store.startBranch).toHaveBeenCalledWith(expect.anything(), 'Why does it bend?');
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('off a branch the membership locks, starts on Tangent credit, keeping the model', async () => {
    const d = await open({}, { lapsed: true });
    const route = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Provider' });
    expect(route.value).toBe('openrouter@credit');
    expect(route.selectedOptions[0]?.textContent?.trim()).toBe('Tangent credit');
    await d.user.click(screen.getByRole('button', { name: 'Create branch' }));
    expect(d.store.createBranch).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'openrouter', funding: 'credit', model: 'vendor/x' }),
    );
  });

  it('Cancel closes it without creating anything', async () => {
    const d = await open();
    await d.user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(d.ui.dialogs.get('branch')).toBeNull();
    expect(d.store.createBranch).not.toHaveBeenCalled();
  });
});
