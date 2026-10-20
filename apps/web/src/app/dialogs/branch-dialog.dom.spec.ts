import { TestBed } from '@angular/core/testing';
import type { BillingSummary, ProviderInfo } from '@tangent/shared';
import { ComposerController } from '@tangent/web-shared';
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

/**
 * The branch dialog on reply a1 of an own-key trunk; `lapsed`: the membership it needs ended;
 * `inTangent`: open in a tangent off a1 on Tangent credit, so a1 is an earlier thread's.
 */
async function open(
  state: Partial<BranchDialogState> = {},
  opts: { lapsed?: boolean; inTangent?: boolean } = {},
) {
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
          [
            branch('trunk', { model: 'vendor/x' }),
            branch('deep', {
              parentBranchId: 'trunk',
              branchPointNodeId: 'a1',
              funding: 'credit',
              model: 'vendor/m',
            }),
          ],
        ),
        opts.inTangent ? 'deep' : null,
      );
      TestBed.inject(UiStore).dialogs.open({ kind: 'branch', fromNodeId: 'a1', quote: null });
    },
    inputs: { state: { fromNodeId: 'a1', quote: 'a wave', ...state } },
  });
  const store = TestBed.inject(TreeStore);
  vi.spyOn(store, 'startBranch').mockImplementation(async () => branch('new'));
  return { ...r, store, ui: TestBed.inject(UiStore), user: userEvent.setup() };
}

const field = (name: RegExp) => screen.getByRole<HTMLTextAreaElement>('textbox', { name });

describe('Tangent from here (power)', () => {
  it('shows the message branched from, without its tangents, and the quote it was opened with', async () => {
    await open();
    screen.getByRole('dialog', { name: 'Tangent from here' });
    expect(screen.getByText('Light is a wave.')).toBeTruthy();
    expect(screen.queryByText(/Photons/)).toBeNull();
    expect(field(/Anchor quote/).value).toBe('a wave');
  });

  it('creates the branch on the open thread’s route with its first message, and closes', async () => {
    const d = await open();
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Provider' }).value).toBe(
      'openrouter',
    );
    await d.user.click(screen.getByRole('radio', { name: /Independent/ }));
    await d.user.type(field(/Starting message/), 'Why?');
    await d.user.click(screen.getByRole('button', { name: 'Create and ask' }));
    expect(d.store.startBranch).toHaveBeenCalledWith(
      {
        fromNodeId: 'a1',
        contextMode: 'independent',
        anchorQuote: 'a wave',
        providerId: 'openrouter',
        funding: 'own-key',
        model: 'vendor/x',
        isPrivate: false,
      },
      'Why?',
    );
    expect(d.ui.dialogs.get('branch')).toBeNull();
  });

  it('off an earlier thread’s message, starts on the route the bar under the box shows: the open thread’s', async () => {
    const d = await open({}, { inTangent: true });
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Provider' }).value).toBe(
      'openrouter@credit',
    );
    await d.user.type(field(/Starting message/), 'Why?');
    await d.user.click(screen.getByRole('button', { name: 'Create and ask' }));
    expect(d.store.startBranch).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'openrouter', funding: 'credit', model: 'vendor/m' }),
      'Why?',
    );
  });

  it('makes nothing without a starting message: Create waits for one, Ctrl+Enter too', async () => {
    const d = await open();
    const create = screen.getByRole<HTMLButtonElement>('button', { name: 'Create and ask' });
    expect(create.disabled).toBe(true);
    await d.user.type(field(/Starting message/), '   ');
    expect(create.disabled).toBe(true);
    await d.user.keyboard('{Control>}{Enter}{/Control}');
    expect(d.store.startBranch).not.toHaveBeenCalled();
    expect(d.ui.dialogs.get('branch')).not.toBeNull();
  });

  it('with a starting message, creates and asks (Ctrl+Enter too)', async () => {
    const d = await open();
    await d.user.click(screen.getByRole('button', { name: 'Remove quote' }));
    await d.user.type(field(/Starting message/), 'Why?');
    await d.user.keyboard('{Control>}{Enter}{/Control}');
    expect(d.store.startBranch).toHaveBeenCalledWith(
      expect.objectContaining({ fromNodeId: 'a1', anchorQuote: null }),
      'Why?',
    );
  });

  it('opened from the message box, its starting message is what was typed there, still editable', async () => {
    const d = await open({ message: 'Why does it bend?' });
    const starting = field(/Starting message/);
    expect(starting.value).toBe('Why does it bend?');
    await d.user.type(starting, ' So much?');
    await d.user.click(screen.getByRole('button', { name: 'Create and ask' }));
    expect(d.store.startBranch).toHaveBeenCalledWith(
      expect.anything(),
      'Why does it bend? So much?',
    );
  });

  it('opened from the message box, the box lets its text go once the tangent is made, edited here or not', async () => {
    const d = await open({ message: 'Why does it bend?' });
    const sent = vi.spyOn(TestBed.inject(ComposerController), 'sent');
    await d.user.type(field(/Starting message/), ' So much?');
    await d.user.click(screen.getByRole('button', { name: 'Create and ask' }));
    expect(sent).toHaveBeenCalledWith('new', 'Why does it bend?');
  });

  it('opened elsewhere, it leaves the message box alone', async () => {
    const d = await open();
    const sent = vi.spyOn(TestBed.inject(ComposerController), 'sent');
    await d.user.type(field(/Starting message/), 'Why?');
    await d.user.click(screen.getByRole('button', { name: 'Create and ask' }));
    expect(sent).not.toHaveBeenCalled();
  });

  it('Ctrl+Enter in any field creates and asks', async () => {
    const d = await open({ message: 'Why?' });
    await d.user.click(field(/^Anchor quote/));
    await d.user.keyboard('{Control>}{Enter}{/Control}');
    expect(d.store.startBranch).toHaveBeenCalledWith(
      expect.objectContaining({ anchorQuote: 'a wave' }),
      'Why?',
    );
  });

  it('off a branch the membership locks, starts on Tangent credit, keeping the model', async () => {
    const d = await open({}, { lapsed: true });
    const route = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Provider' });
    expect(route.value).toBe('openrouter@credit');
    expect(route.selectedOptions[0]?.textContent?.trim()).toBe('Tangent credit');
    await d.user.type(field(/Starting message/), 'Why?');
    await d.user.click(screen.getByRole('button', { name: 'Create and ask' }));
    expect(d.store.startBranch).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'openrouter', funding: 'credit', model: 'vendor/x' }),
      'Why?',
    );
  });

  it('opened on a route (a reviewer’s model), starts the tangent there', async () => {
    const d = await open({
      route: { providerId: 'openrouter', funding: 'credit', model: 'vendor/m' },
    });
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Provider' }).value).toBe(
      'openrouter@credit',
    );
    await d.user.type(field(/Starting message/), 'Is it right?');
    await d.user.click(screen.getByRole('button', { name: 'Create and ask' }));
    expect(d.store.startBranch).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'openrouter', funding: 'credit', model: 'vendor/m' }),
      'Is it right?',
    );
  });

  it('Cancel closes it without creating anything', async () => {
    const d = await open();
    await d.user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(d.ui.dialogs.get('branch')).toBeNull();
    expect(d.store.startBranch).not.toHaveBeenCalled();
  });
});
