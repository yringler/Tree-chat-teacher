import { TestBed } from '@angular/core/testing';
import type { BillingSummary, GroundingMode, ProviderInfo } from '@tangent/shared';
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
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TreeStore } from '../state/tree-store';
import { UiStore, type BranchDialogState } from '../state/ui-store';
import { BranchDialog } from './branch-dialog';

const OWN_KEY = provider({ models: [{ id: 'vendor/x', label: 'X' }] });
/** Tangent credit, which can search the web (the own-key entry can't). */
const CREDIT: ProviderInfo = {
  ...OWN_KEY,
  label: 'Tangent credit',
  defaultModel: 'vendor/default',
  acceptsUserKey: false,
  keySource: 'server',
  funding: 'credit',
  webSearch: true,
};

/**
 * The branch dialog on reply a1 of an own-key trunk; `lapsed`: the membership it needs ended;
 * `inTangent`: open in a tangent off a1 on Tangent credit, so a1 is an earlier thread's;
 * `trunkSearch`: the trunk's web search.
 */
async function open(
  state: Partial<BranchDialogState> = {},
  opts: { lapsed?: boolean; inTangent?: boolean; trunkSearch?: GroundingMode } = {},
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
            branch('trunk', {
              model: 'vendor/x',
              ...(opts.trunkSearch ? { grounding: opts.trunkSearch } : {}),
            }),
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

/** The Replies group's folded line, its whitespace collapsed. */
const repliesLine = () =>
  within(screen.getByRole('group', { name: 'Replies' }))
    .getByRole('button', { name: 'Change' })
    .closest('p')
    ?.textContent?.replace(/\s+/g, ' ')
    .trim();

describe('Tangent from here (power)', () => {
  it('shows the message branched from, without its tangents, and the quote it was opened with', async () => {
    await open();
    screen.getByRole('dialog', { name: 'Tangent from here' });
    expect(screen.getByText('Light is a wave.')).toBeTruthy();
    expect(screen.queryByText(/Photons/)).toBeNull();
    // The quote is read, not typed: words selected in a message, in the Context group.
    const context = screen.getByRole('group', { name: 'Context' });
    expect(within(context).getByRole('group', { name: 'Quote' }).textContent).toContain('a wave');
    expect(screen.queryByRole('textbox', { name: /quote/i })).toBeNull();
  });

  it('starts with the starting message, then Context, Replies and Private', async () => {
    await open();
    const order = [
      field(/Starting message/),
      screen.getByRole('group', { name: 'Context' }),
      screen.getByRole('group', { name: 'Replies' }),
      screen.getByRole('checkbox', { name: 'Private' }),
    ];
    order.reduce((before, el) => {
      expect(before.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      return el;
    });
    const priv = screen.getByRole('checkbox', { name: 'Private' });
    expect(document.getElementById(priv.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Left out of shares and exports, with every tangent under it.',
    );
  });

  it('Remove takes the quote off, the focus going to the mode', async () => {
    const d = await open();
    await d.user.click(screen.getByRole('button', { name: 'Remove quote' }));
    expect(screen.queryByRole('group', { name: 'Quote' })).toBeNull();
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('radio', { name: /Full path/ })),
    );
    await d.user.type(field(/Starting message/), 'Why?');
    await d.user.click(screen.getByRole('button', { name: 'Create and ask' }));
    expect(d.store.startBranch).toHaveBeenCalledWith(
      expect.objectContaining({ anchorQuote: null }),
      'Why?',
    );
  });

  it('without a quote, shows none, and asks for none to be selected', async () => {
    await open({ quote: null });
    expect(screen.queryByRole('group', { name: 'Quote' })).toBeNull();
    expect(screen.queryByText(/Select text/)).toBeNull();
  });

  it('creates the branch on the open thread’s route with its first message, and closes', async () => {
    const d = await open();
    // Folded: the open thread's route, as the bar under the box shows it, and its web search.
    expect(repliesLine()).toBe(
      'Same as the bar under the message box: OpenRouter · X · no web search. Change',
    );
    expect(screen.queryByRole('combobox', { name: 'Provider' })).toBeNull();
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
        grounding: 'auto',
        isPrivate: false,
      },
      'Why?',
    );
    expect(d.ui.dialogs.get('branch')).toBeNull();
  });

  it('off an earlier thread’s message, starts on the route the bar under the box shows: the open thread’s', async () => {
    const d = await open({}, { inTangent: true });
    expect(repliesLine()).toBe(
      'Same as the bar under the message box: Tangent credit · vendor/m · search when likely needed. Change',
    );
    await d.user.type(field(/Starting message/), 'Why?');
    await d.user.click(screen.getByRole('button', { name: 'Create and ask' }));
    expect(d.store.startBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'openrouter',
        funding: 'credit',
        model: 'vendor/m',
        grounding: 'auto',
      }),
      'Why?',
    );
  });

  it('takes web search from the message’s thread, as a tangent from the box does, and says when that isn’t the bar’s', async () => {
    const d = await open({}, { inTangent: true, trunkSearch: 'off' });
    expect(repliesLine()).toBe('Tangent credit · vendor/m · no web search. Change');
    await d.user.type(field(/Starting message/), 'Why?');
    await d.user.click(screen.getByRole('button', { name: 'Create and ask' }));
    expect(d.store.startBranch).toHaveBeenCalledWith(
      expect.objectContaining({ funding: 'credit', model: 'vendor/m', grounding: 'off' }),
      'Why?',
    );
  });

  it('Change opens who pays, the model and web search, and the tangent starts on what is picked', async () => {
    const d = await open({}, { inTangent: true });
    await d.user.click(screen.getByRole('button', { name: 'Change' }));
    const replies = screen.getByRole('group', { name: 'Replies' });
    const provider = within(replies).getByRole<HTMLSelectElement>('combobox', { name: 'Provider' });
    await vi.waitFor(() => expect(document.activeElement).toBe(provider));
    expect(provider.value).toBe('openrouter@credit');
    await d.user.selectOptions(
      within(replies).getByRole('combobox', { name: 'Web search' }),
      'off',
    );
    await d.user.type(field(/Starting message/), 'Why?');
    await d.user.click(screen.getByRole('button', { name: 'Create and ask' }));
    expect(d.store.startBranch).toHaveBeenCalledWith(
      expect.objectContaining({ funding: 'credit', model: 'vendor/m', grounding: 'off' }),
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
    await d.user.click(screen.getByRole('radio', { name: /Summary/ }));
    await d.user.keyboard('{Control>}{Enter}{/Control}');
    expect(d.store.startBranch).toHaveBeenCalledWith(
      expect.objectContaining({ anchorQuote: 'a wave', contextMode: 'summary' }),
      'Why?',
    );
  });

  it('off a branch the membership locks, starts on Tangent credit, keeping the model', async () => {
    const d = await open({}, { lapsed: true });
    // Not the locked thread's route, and that thread shows no bar: the line names it plainly.
    expect(repliesLine()).toBe('Tangent credit · X · search when likely needed. Change');
    await d.user.click(screen.getByRole('button', { name: 'Change' }));
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
    expect(repliesLine()).toBe('Tangent credit · vendor/m · search when likely needed. Change');
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
