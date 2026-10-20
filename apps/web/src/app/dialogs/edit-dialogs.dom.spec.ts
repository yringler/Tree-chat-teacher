import { TestBed } from '@angular/core/testing';
import type { Branch, ProviderInfo, Tree, TreeDetail, UpdateBranchRequest } from '@tangent/shared';
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

/** Tangent credit, suggesting a Normal and a Max as the server lists them. */
const CREDIT: ProviderInfo = provider({
  label: 'Tangent credit',
  acceptsUserKey: false,
  keySource: 'server',
  funding: 'credit',
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
 * `type` rendered with `inputs`, on tree t1 open at branch `side`, for a
 * member offered Tangent credit, with the Normal and Max of `tiers`
 * (Settings); saves answer with what they were sent.
 */
async function open<T>(
  type: new () => T,
  inputs: Record<string, unknown> = {},
  tiers?: AppSettings['tiers'],
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
      openTree(store, detail(), 'side');
    },
  });
  return {
    ...r,
    api,
    store: TestBed.inject(TreeStore),
    dialogs: TestBed.inject(UiStore).dialogs,
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

  it('on the main thread, is the main thread’s settings, with no delete', async () => {
    const d = await open(BranchSettings, { branch: branch() });
    screen.getByRole('dialog', { name: 'Main thread settings' });
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
    await d.user.click(screen.getByRole('checkbox', { name: /^Private/ }));
    await d.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(d.api.updateBranch).toHaveBeenCalledWith('trunk', { isPrivate: true });
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
  it('a title given by the first reply while open is not reverted by Save', async () => {
    const d = await open(TreeSettings, { tree });
    await d.set({ tree: { ...tree, title: 'Light as a wave' } });
    await d.user.type(screen.getByRole('textbox', { name: /^System prompt/ }), 'Be brief.');
    await d.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(d.api.updateTree).toHaveBeenCalledWith('t1', { systemPrompt: 'Be brief.' });
  });

  it('clearing the prompt saves none, so the conversation follows the default', async () => {
    const d = await open(TreeSettings, { tree: { ...tree, systemPrompt: 'Be terse.' } });
    const prompt = screen.getByRole('textbox', { name: /^System prompt/ });
    await d.user.clear(prompt);
    expect(prompt.getAttribute('placeholder')).toMatch(/default system prompt/);
    await d.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(d.api.updateTree).toHaveBeenCalledWith('t1', { systemPrompt: null });
  });
});
