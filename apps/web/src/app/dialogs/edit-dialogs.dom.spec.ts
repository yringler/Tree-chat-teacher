import { TestBed } from '@angular/core/testing';
import type { Branch, ProviderInfo, Tree, TreeDetail, UpdateBranchRequest } from '@tangent/shared';
import { ApiError, ToastStore } from '@tangent/web-shared';
import * as fixtures from '@tangent/web-shared/testing';
import {
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
import { type AppSettings, SettingsStore } from '../state/settings-store';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { BranchSettings } from './branch-settings';
import { DialogHost } from './dialog-host';
import { TreeSettings } from './tree-settings';

const HAIKU = 'anthropic/claude-haiku-5.5';
const SONNET = 'anthropic/claude-sonnet-5.5';
const PRO = 'deepseek/deepseek-v4-pro';

/** Tangent credit, suggesting a Normal and a Max as the server lists them; it can search the web. */
const CREDIT: ProviderInfo = provider({
  label: 'Tangent credit',
  acceptsUserKey: false,
  keySource: 'server',
  funding: 'credit',
  webSearch: true,
  models: [
    { id: HAIKU, label: 'Normal (suggested)', tier: 'normal' },
    { id: SONNET, label: 'Max (suggested)', tier: 'max' },
  ],
  defaultModel: HAIKU,
});

/** The trunk "Main thread" on Tangent credit, unless `over` says otherwise. */
const branch = (over: Partial<Branch> = {}): Branch =>
  fixtures.branch('trunk', { title: 'Main thread', funding: 'credit', ...over });

const reply = node('a1', { content: 'A wave.' });

const side = branch({
  id: 'side',
  parentBranchId: 'trunk',
  branchPointNodeId: 'a1',
  title: 'Branch: A wave.',
});

function detail(): TreeDetail {
  return fixtures.detail([reply], [branch(), side], [], { title: 'New conversation' });
}

const tree: Tree = detail().tree;

/** A chip or button's text, its whitespace collapsed. */
const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ').trim();

/**
 * `type` rendered with `inputs`, on tree t1 open at branch `side` (or
 * `at`), for a member offered Tangent credit, with the Normal and Max of
 * `tiers` (Settings); saves answer with what they were sent.
 */
async function open<T>(
  type: new () => T,
  inputs: Record<string, unknown> = {},
  tiers?: AppSettings['tiers'],
  at: string | null = 'side',
) {
  const api = {
    updateBranch: vi.fn(async (id: string, req: UpdateBranchRequest) => ({
      ...(id === 'side' ? side : branch()),
      ...req,
    })),
    updateTree: vi.fn(async (_id: string, req: Partial<Tree>) => ({ ...tree, ...req })),
  };
  const r = await render(type, {
    inputs,
    providers: powerProviders(TreeStore, api),
    setup: () => {
      if (tiers) TestBed.inject(SettingsStore).update({ tiers });
      const store = TestBed.inject(TreeStore);
      signIn(store.account, { providers: [provider(), CREDIT], builtInCredit: true });
      openTree(store, detail(), at);
    },
  });
  return {
    ...r,
    api,
    store: TestBed.inject(TreeStore),
    dialogs: TestBed.inject(UiStore).dialogs,
    toasts: TestBed.inject(ToastStore),
    user: userEvent.setup(),
  };
}

describe('Tangent settings', () => {
  it('a title given by a reply while open is not reverted (nor pinned) by Save', async () => {
    const d = await open(BranchSettings, { branch: side });
    await d.set({ branch: { ...side, title: 'Light as a wave', titleSource: 'auto' } });
    await d.user.click(screen.getByRole('checkbox', { name: /^Private/ }));
    await d.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(d.api.updateBranch).toHaveBeenCalledWith('side', { isPrivate: true });
  });

  it('saves to the branch it was opened on', async () => {
    const d = await open(BranchSettings, { branch: side });
    await d.set({ branch: branch() });
    const title = screen.getByRole('textbox', { name: /^Title/ });
    await d.user.clear(title);
    await d.user.type(title, 'Waves');
    await d.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(d.api.updateBranch).toHaveBeenCalledWith('side', { title: 'Waves' });
  });

  it('its model chips are your Normal and Max from Settings, each on the payer chosen with it', async () => {
    // Normal is DeepSeek on your own OpenRouter key; the tangent is on Tangent credit.
    const d = await open(
      BranchSettings,
      { branch: side },
      { normal: { providerId: 'openrouter', funding: 'own-key', model: PRO }, max: null },
    );
    const chips = () => within(screen.getByRole('group', { name: 'Suggested models' }));
    expect(chips().getAllByRole('button').map(text)).toEqual([
      'Normal · deepseek-v4-pro · on OpenRouter',
      'Max · claude-sonnet-5.5',
      'claude-haiku-5.5',
    ]);

    await d.user.click(chips().getByRole('button', { name: /^Normal/ }));
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Provider' }).value).toBe(
      'openrouter',
    );
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Model' }).value).toBe(PRO);
    expect(
      chips()
        .getByRole('button', { name: /^Normal/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    await d.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(d.api.updateBranch).toHaveBeenCalledWith('side', {
      providerId: 'openrouter',
      funding: 'own-key',
      model: PRO,
    });
  });

  it('opens only inside a tangent: the main thread’s are in Conversation settings', async () => {
    const d = await open(DialogHost, {}, undefined, null);
    d.dialogs.open({ kind: 'branch-settings' });
    await d.fixture.whenStable();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes when the selection moves to another branch (Back, a link), not on a focus change', async () => {
    const d = await open(DialogHost);
    d.dialogs.open({ kind: 'branch-settings' });
    await d.fixture.whenStable();
    screen.getByRole('dialog', { name: 'Tangent settings' });
    d.store.setRoute('t1', 'side', 'a1');
    await d.fixture.whenStable();
    screen.getByRole('dialog', { name: 'Tangent settings' });
    d.store.setRoute('t1', null, null);
    await d.fixture.whenStable();
    expect(d.dialogs.isOpen('branch-settings')).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Conversation settings', () => {
  it('holds the main thread’s replies and Private, saved on the main thread with the conversation’s own', async () => {
    const d = await open(TreeSettings, { tree, trunk: branch() });
    screen.getByRole('dialog', { name: 'Conversation settings' });
    // The main thread has no title of its own to edit: the conversation's is the only one.
    expect(screen.getAllByRole('textbox', { name: /^Title/ })).toHaveLength(1);
    const replies = screen.getByRole('group', { name: 'Main thread replies' });
    expect(replies.textContent).toContain('New tangents from the main thread start with these.');
    await d.user.click(within(replies).getByRole('button', { name: /^Max/ }));
    await d.user.selectOptions(
      within(replies).getByRole('combobox', { name: /^Check facts with web search/ }),
      'off',
    );
    const priv = screen.getByRole('checkbox', { name: 'Private' });
    expect(priv.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(priv.getAttribute('aria-describedby')!)?.textContent).toMatch(
      /whole conversation/,
    );
    await d.user.click(priv);
    const title = screen.getByRole('textbox', { name: /^Title/ });
    await d.user.clear(title);
    await d.user.type(title, 'Waves');
    await d.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(d.api.updateBranch).toHaveBeenCalledExactlyOnceWith('trunk', {
      grounding: 'off',
      providerId: 'openrouter',
      funding: 'credit',
      model: SONNET,
      isPrivate: true,
    });
    expect(d.api.updateTree).toHaveBeenCalledExactlyOnceWith('t1', { title: 'Waves' });
  });

  it('saves both or stays open: when the main thread’s can’t be saved, neither is, and it says why', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = await open(DialogHost);
    d.api.updateBranch.mockRejectedValueOnce(new ApiError(400, 'bad_request', 'Unknown model'));
    d.dialogs.open({ kind: 'tree-settings' });
    await d.fixture.whenStable();
    await d.user.type(screen.getByRole('textbox', { name: /^System prompt/ }), 'Be brief.');
    await d.user.click(screen.getByRole('checkbox', { name: 'Private' }));
    await d.user.click(screen.getByRole('button', { name: 'Save' }));
    await d.fixture.whenStable();
    expect(d.api.updateBranch).toHaveBeenCalledWith('trunk', { isPrivate: true });
    expect(d.api.updateTree).not.toHaveBeenCalled();
    expect(d.toasts.toasts().map((t) => [t.kind, t.text])).toEqual([['error', 'Unknown model']]);
    // Open, with the edits, for Save to try again.
    expect(d.dialogs.isOpen('tree-settings')).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Private' }).checked).toBe(true);

    await d.user.click(screen.getByRole('button', { name: 'Save' }));
    await d.fixture.whenStable();
    expect(d.api.updateTree).toHaveBeenCalledExactlyOnceWith('t1', { systemPrompt: 'Be brief.' });
    expect(d.dialogs.isOpen('tree-settings')).toBe(false);
  });

  it('when only the main thread’s were saved, Save again sends what changed since', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = await open(DialogHost, {}, undefined, null);
    d.api.updateTree.mockRejectedValueOnce(new ApiError(503, 'network', 'Offline'));
    d.dialogs.open({ kind: 'tree-settings' });
    await d.fixture.whenStable();
    await d.user.type(screen.getByRole('textbox', { name: /^System prompt/ }), 'Be brief.');
    await d.user.click(screen.getByRole('checkbox', { name: 'Private' }));
    await d.user.click(screen.getByRole('button', { name: 'Save' }));
    await d.fixture.whenStable();
    expect(d.api.updateBranch).toHaveBeenCalledExactlyOnceWith('trunk', { isPrivate: true });
    expect(d.dialogs.isOpen('tree-settings')).toBe(true);

    // The user takes Private back: the main thread, now private, must hear it.
    await d.user.click(screen.getByRole('checkbox', { name: 'Private' }));
    await d.user.click(screen.getByRole('button', { name: 'Save' }));
    await d.fixture.whenStable();
    expect(d.api.updateBranch).toHaveBeenLastCalledWith('trunk', { isPrivate: false });
    expect(d.api.updateTree).toHaveBeenLastCalledWith('t1', { systemPrompt: 'Be brief.' });
    expect(d.dialogs.isOpen('tree-settings')).toBe(false);
  });

  it('opened from the route chip, opens at the main thread’s replies', async () => {
    const d = await open(DialogHost);
    d.dialogs.open({ kind: 'tree-settings', section: 'replies' });
    await d.fixture.whenStable();
    const replies = screen.getByRole('group', { name: 'Main thread replies' });
    await vi.waitFor(() => expect(document.activeElement).toBe(replies));
  });

  it('a title given by the first reply while open is not reverted by Save', async () => {
    const d = await open(TreeSettings, { tree, trunk: branch() });
    await d.set({ tree: { ...tree, title: 'Light as a wave' } });
    await d.user.type(screen.getByRole('textbox', { name: /^System prompt/ }), 'Be brief.');
    await d.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(d.api.updateTree).toHaveBeenCalledWith('t1', { systemPrompt: 'Be brief.' });
  });

  it('clearing the prompt saves none, so the conversation follows the default', async () => {
    const d = await open(TreeSettings, {
      tree: { ...tree, systemPrompt: 'Be terse.' },
      trunk: branch(),
    });
    const prompt = screen.getByRole('textbox', { name: /^System prompt/ });
    await d.user.clear(prompt);
    expect(prompt.getAttribute('placeholder')).toMatch(/default system prompt/);
    await d.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(d.api.updateTree).toHaveBeenCalledWith('t1', { systemPrompt: null });
  });
});
