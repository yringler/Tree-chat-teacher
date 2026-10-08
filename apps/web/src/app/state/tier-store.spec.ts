import '@angular/compiler'; // JIT: lets the DI below compile @Injectable classes without the Angular CLI.
import { Injector, signal } from '@angular/core';
import {
  providerRouteKey,
  routeKey,
  type Branch,
  type BranchFunding,
  type ProviderInfo,
  type UpdateBranchRequest,
} from '@tangent/shared';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings, SettingsStore } from './settings-store';
import { TierStore, tierOptions } from './tier-store';
import { TreeStore } from './tree-store';
import { UiStore } from './ui-store';

const PRO = 'deepseek/deepseek-v4-pro';
const SONNET = 'anthropic/claude-sonnet-5.5';

/** An OpenRouter entry listing both tiers (power's suggestions, or Tangent credit). */
function entry(funding: BranchFunding, over: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: 'openrouter',
    kind: 'openai-compatible',
    label: funding === 'credit' ? 'Tangent credit' : 'OpenRouter',
    models: [
      { id: PRO, label: 'Normal (suggested)', tier: 'normal' },
      { id: SONNET, label: 'Max (suggested)', tier: 'max', usageFactor: 3 },
    ],
    defaultModel: PRO,
    openModels: true,
    available: true,
    acceptsUserKey: funding === 'own-key',
    keySource: funding === 'own-key' ? 'user' : 'server',
    funding,
    ...over,
  };
}

const anthropic: ProviderInfo = {
  id: 'anthropic',
  kind: 'anthropic',
  label: 'Anthropic',
  models: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }],
  defaultModel: 'claude-opus-5-5',
  openModels: false,
  available: true,
  acceptsUserKey: true,
  keySource: 'user',
};

const at = '2026-10-01T00:00:00.000Z';
function branch(over: Partial<Branch> = {}): Branch {
  return {
    id: 'b1',
    treeId: 't1',
    parentBranchId: null,
    branchPointNodeId: null,
    contextMode: 'path',
    anchorQuote: null,
    title: 'Light',
    titleSource: 'default',
    isPrivate: false,
    providerId: 'openrouter',
    model: PRO,
    funding: 'credit',
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

/** The bits of TreeStore that TierStore reads, over a plain provider list. */
function setup(
  opts: {
    providers?: ProviderInfo[];
    defaultRoute?: string | null;
    locked?: BranchFunding[];
    tiers?: AppSettings['tiers'];
    branches?: Branch[];
  } = {},
) {
  const providers = signal(opts.providers ?? [entry('own-key'), entry('credit')]);
  const map = () => new Map(providers().map((p) => [providerRouteKey(p), p]));
  const locked = new Set(opts.locked ?? []);
  const branches = new Map((opts.branches ?? [branch()]).map((b) => [b.id, b]));
  const updateBranch = vi.fn(async (_id: string, _req: UpdateBranchRequest) => true);
  const tree = {
    providers,
    providerOf: (r: { providerId: string; funding?: BranchFunding }) => map().get(routeKey(r)),
    defaultProvider: () =>
      opts.defaultRoute === null ? null : (map().get(opts.defaultRoute ?? 'openrouter') ?? null),
    routeLocked: (r: { funding?: BranchFunding }) => locked.has(r.funding ?? 'own-key'),
    index: () => ({ branches }),
    updateBranch,
  };
  const settings = {
    settings: signal<AppSettings>({
      ...DEFAULT_SETTINGS,
      tiers: opts.tiers ?? DEFAULT_SETTINGS.tiers,
    }),
  };
  const injector = Injector.create({
    providers: [
      { provide: TierStore },
      { provide: UiStore },
      { provide: TreeStore, useValue: tree },
      { provide: SettingsStore, useValue: settings },
    ],
  });
  return {
    tiers: injector.get(TierStore),
    ui: injector.get(UiStore),
    providers,
    settings,
    updateBranch,
  };
}

describe('TierStore choice', () => {
  it("is the tier's model on the branch's own route, keeping who pays", () => {
    const s = setup();
    expect(s.tiers.choice('max', branch())).toEqual({
      providerId: 'openrouter',
      funding: 'credit',
      model: SONNET,
    });
    expect(s.tiers.choice('normal', branch({ funding: 'own-key' }))).toEqual({
      providerId: 'openrouter',
      model: PRO,
    });
  });

  it('falls back to the default route, then to the first usable route listing the tier', () => {
    const onAnthropic = branch({ providerId: 'anthropic', funding: 'own-key', model: 'x' });
    expect(
      setup({ providers: [anthropic, entry('own-key'), entry('credit')] }).tiers.choice(
        'max',
        onAnthropic,
      ),
    ).toEqual({ providerId: 'openrouter', model: SONNET });
    // No default route yet, and the own-key OpenRouter has no key: credit.
    const s = setup({
      providers: [anthropic, entry('own-key', { available: false }), entry('credit')],
      defaultRoute: null,
    });
    expect(s.tiers.choice('normal', onAnthropic)).toEqual({
      providerId: 'openrouter',
      funding: 'credit',
      model: PRO,
    });
    expect(s.tiers.choice('normal')).toEqual({
      providerId: 'openrouter',
      funding: 'credit',
      model: PRO,
    });
  });

  it('keeps a missing key on the branch’s own route (the route bar asks for it)', () => {
    const s = setup({ providers: [entry('own-key', { available: false }), entry('credit')] });
    expect(s.tiers.choice('max', branch({ funding: 'own-key' }))).toEqual({
      providerId: 'openrouter',
      model: SONNET,
    });
  });

  it('never picks a route whose funding needs the membership', () => {
    const s = setup({ locked: ['own-key'], defaultRoute: 'openrouter' });
    expect(s.tiers.choice('max', branch({ funding: 'own-key' }))).toEqual({
      providerId: 'openrouter',
      funding: 'credit',
      model: SONNET,
    });
  });

  it('prefers the saved choice while its route can use it', () => {
    const saved = { providerId: 'anthropic', model: 'claude-opus-5-5' };
    const s = setup({
      providers: [anthropic, entry('credit')],
      tiers: { normal: null, max: saved },
    });
    expect(s.tiers.choice('max', branch())).toEqual(saved);
    expect(s.tiers.choice('normal', branch())?.model).toBe(PRO);
    // Its provider lost its key: the suggested model again.
    s.providers.set([{ ...anthropic, available: false }, entry('credit')]);
    expect(s.tiers.choice('max', branch())?.model).toBe(SONNET);
    // A model its provider doesn't allow: the suggested one.
    s.settings.settings.set({
      ...DEFAULT_SETTINGS,
      tiers: { normal: null, max: { providerId: 'anthropic', model: 'not-listed' } },
    });
    s.providers.set([anthropic, entry('credit')]);
    expect(s.tiers.choice('max', branch())?.model).toBe(SONNET);
  });

  it('is null when no route lists the tier', () => {
    const s = setup({ providers: [anthropic], defaultRoute: 'anthropic' });
    expect(s.tiers.choice('max', branch())).toBeNull();
    expect(s.tiers.available(branch())).toBe(false);
  });
});

describe('TierStore tierOfBranch, available and usageFactor', () => {
  it("names the branch's tier, or none for another model", () => {
    const s = setup();
    expect(s.tiers.tierOfBranch(branch())).toBe('normal');
    expect(s.tiers.tierOfBranch(branch({ model: SONNET }))).toBe('max');
    expect(s.tiers.tierOfBranch(branch({ model: 'vendor/other' }))).toBeNull();
    // A saved Max elsewhere: the branch's suggested Max model is no tier now.
    const saved = setup({
      providers: [anthropic, entry('credit')],
      tiers: { normal: null, max: { providerId: 'anthropic', model: 'claude-opus-5-5' } },
    });
    expect(saved.tiers.tierOfBranch(branch({ model: SONNET }))).toBeNull();
    expect(
      saved.tiers.tierOfBranch(
        branch({ providerId: 'anthropic', funding: 'own-key', model: 'claude-opus-5-5' }),
      ),
    ).toBe('max');
  });

  it("offers the switch when both tiers resolve to different models, with Max's usage factor", () => {
    const s = setup();
    expect(s.tiers.available(branch())).toBe(true);
    expect(s.tiers.available(null)).toBe(true);
    expect(s.tiers.usageFactor(branch())).toBe(3);
    const same = setup({
      tiers: { normal: null, max: { providerId: 'openrouter', funding: 'credit', model: PRO } },
    });
    expect(same.tiers.available(branch())).toBe(false);
    // A custom Max no price is known for: no factor.
    const custom = setup({
      tiers: { normal: null, max: { providerId: 'openrouter', model: 'vendor/other' } },
    });
    expect(custom.tiers.usageFactor(branch())).toBeUndefined();
    // A custom Normal: the server's factor was priced against the suggested Normal, so none.
    const customNormal = setup({
      tiers: { normal: { providerId: 'openrouter', model: 'vendor/pricier' }, max: null },
    });
    expect(customNormal.tiers.usageFactor(branch())).toBeUndefined();
    // The suggested pair on own key and on credit: the same models, so the same factor.
    const split = setup({
      tiers: { normal: { providerId: 'openrouter', model: PRO }, max: null },
    });
    expect(split.tiers.usageFactor(branch({ funding: 'credit' }))).toBe(3);
  });

  it('labels a model by its name, or by its id where the label only names the tier', () => {
    const s = setup({ providers: [anthropic, entry('credit')] });
    expect(s.tiers.modelLabel({ providerId: 'openrouter', funding: 'credit', model: SONNET })).toBe(
      'claude-sonnet-5.5',
    );
    expect(s.tiers.modelLabel({ providerId: 'anthropic', model: 'claude-opus-5-5' })).toBe(
      'Claude Opus 5.5',
    );
    expect(s.tiers.modelLabel({ providerId: 'anthropic', model: 'unlisted' })).toBe('unlisted');
  });
});

describe('TierStore switchTier', () => {
  it('moves the branch onto the tier, says so and focuses the composer', async () => {
    const s = setup();
    const focus = s.ui.composerFocus();
    await expect(s.tiers.switchTier('b1', 'max')).resolves.toBe(true);
    expect(s.updateBranch).toHaveBeenCalledWith('b1', {
      providerId: 'openrouter',
      funding: 'credit',
      model: SONNET,
    });
    expect(s.ui.toasts().at(-1)?.text).toBe('Replies now on Max');
    expect(s.ui.composerFocus()).toBe(focus + 1);
  });

  it('sends the own key as such, and does nothing for an unknown branch', async () => {
    const s = setup({ branches: [branch({ funding: 'own-key', model: SONNET })] });
    await s.tiers.switchTier('b1', 'normal');
    expect(s.updateBranch).toHaveBeenCalledWith('b1', {
      providerId: 'openrouter',
      funding: 'own-key',
      model: PRO,
    });
    await expect(s.tiers.switchTier('gone', 'max')).resolves.toBe(false);
    expect(s.updateBranch).toHaveBeenCalledTimes(1);
  });

  it('names the new route when the tier moves a branch off its provider', async () => {
    const s = setup({
      providers: [anthropic, entry('credit')],
      branches: [branch({ providerId: 'anthropic', funding: 'own-key', model: 'claude-opus-5-5' })],
    });
    await expect(s.tiers.switchTier('b1', 'max')).resolves.toBe(true);
    expect(s.updateBranch).toHaveBeenCalledWith('b1', {
      providerId: 'openrouter',
      funding: 'credit',
      model: SONNET,
    });
    expect(s.ui.toasts().at(-1)?.text).toBe('Replies now on Max (Tangent credit)');
  });

  it('a refused update changes nothing here (TreeStore reports it)', async () => {
    const s = setup();
    s.updateBranch.mockResolvedValueOnce(false);
    await expect(s.tiers.switchTier('b1', 'max')).resolves.toBe(false);
    expect(s.ui.toasts()).toEqual([]);
  });
});

describe('tierOptions', () => {
  it('offers Normal then Max, with what Max costs in its hint', () => {
    expect(tierOptions('Max uses about 3× as much as Normal.')).toEqual([
      { id: 'normal', label: 'Normal', hint: 'Normal: clear, thorough answers' },
      {
        id: 'max',
        label: 'Max',
        hint: 'Max: the strongest model. Max uses about 3× as much as Normal.',
      },
    ]);
  });
});
