import { TestBed } from '@angular/core/testing';
import type {
  ProviderInfo,
  SettingsResponse,
  TreeDetail,
  UpdateSettingsRequest,
} from '@tangent/shared';
import { ApiError } from '@tangent/web-shared';
import * as fixtures from '@tangent/web-shared/testing';
import { openTree, powerProviders, provider, render, signIn } from '@tangent/web-shared/testing';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, SettingsStore } from '../state/settings-store';
import { TreeStore } from '../state/tree-store';
import { type SettingsSection, UiStore } from '../state/ui-store';
import { DialogHost } from './dialog-host';
import { SettingsDialog } from './settings-dialog';

const SAVED: SettingsResponse = fixtures.accountSettings({
  defaultSystemPrompt: 'Answer directly.',
});

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

/** OpenRouter on the user's own key, suggesting DeepSeek as its Normal. */
const OWN: ProviderInfo = provider({
  models: [
    { id: PRO, label: 'Normal (suggested)', tier: 'normal' },
    { id: SONNET, label: 'Max (suggested)', tier: 'max' },
  ],
  defaultModel: PRO,
});

/** A conversation whose main thread is on Tangent credit. */
const onCredit = (): TreeDetail =>
  fixtures.detail([], [fixtures.branch('trunk', { funding: 'credit', model: HAIKU })]);

/** The account's answer to a save: SAVED with the request's changes. */
async function echo(req: UpdateSettingsRequest): Promise<SettingsResponse> {
  const { tiers, walkthroughDone: _done, ...rest } = req;
  return { ...SAVED, ...rest, tiers: { ...SAVED.tiers, ...tiers } };
}

/** Settings, with the account's settings still on their way (`settings` never answers). */
async function loading(
  settings: () => Promise<SettingsResponse> = () => new Promise<SettingsResponse>(() => {}),
) {
  const api = { settings: vi.fn(settings) };
  const r = await render(SettingsDialog, {
    providers: powerProviders(TreeStore, api),
    setup: () => signIn(TestBed.inject(TreeStore).account),
  });
  return { ...r, api };
}

/**
 * Settings opened on the dialog stack (at `section`), once the account's
 * settings (`saved`) have loaded; `update` answers a save. Signed in with
 * `providers`, with `tree` open if given.
 */
async function opened(
  update: (req: UpdateSettingsRequest) => Promise<SettingsResponse> = echo,
  opts: {
    section?: SettingsSection;
    providers?: ProviderInfo[];
    tree?: TreeDetail;
    saved?: SettingsResponse;
  } = {},
) {
  const { section, providers, tree, saved = SAVED } = opts;
  const api = { settings: vi.fn(async () => saved), updateSettings: vi.fn(update) };
  const r = await render(DialogHost, {
    providers: powerProviders(TreeStore, api),
    setup: () => {
      const store = TestBed.inject(TreeStore);
      signIn(store.account, providers ? { providers, builtInCredit: true } : {});
      if (tree) openTree(store, tree);
    },
  });
  const dialogs = TestBed.inject(UiStore).dialogs;
  dialogs.open(section ? { kind: 'settings', section } : { kind: 'settings' });
  await r.fixture.whenStable();
  const prompt = await vi.waitFor(() => {
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Default system prompt' });
    expect(box.disabled).toBe(false);
    return box;
  });
  return {
    ...r,
    api,
    dialogs,
    prompt,
    settings: TestBed.inject(SettingsStore),
    user: userEvent.setup(),
  };
}

describe('Settings', () => {
  it('opens at its top, on its heading, while the prompt loads: not on a control further down', async () => {
    await loading();
    const heading = screen.getByRole('heading', { name: 'Settings' });
    await vi.waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('opened at Normal and Max (the bar under the message box), scrolls there and focuses its first choice', async () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView');
    await opened(echo, { section: 'tiers' });
    const tiers = screen.getByRole('group', { name: 'Normal and Max' });
    const normal = within(tiers).getByRole('group', { name: 'Normal' });
    expect(document.activeElement).toBe(within(normal).getByRole('radio', { name: 'Suggested' }));
    expect(scrolled.mock.contexts).toContain(tiers);
    scrolled.mockRestore();
  });

  it('opened at the reply limit (a reply cut off at it), focuses its choice', async () => {
    await opened(echo, { section: 'output-cap' });
    const limit = screen.getByRole('group', { name: 'Reply limit' });
    expect(document.activeElement).toBe(within(limit).getByRole('radio', { name: /^Auto/ }));
  });

  it('holds the defaults for every conversation, grouped by what they control, each synced to the account', async () => {
    await opened();
    screen.getByText('Defaults for every conversation in power.');
    const where = (group: string) =>
      within(screen.getByRole('group', { name: group }))
        .getAllByText(/^(Saved in this browser|Synced to your account)/)
        .map((el) => el.textContent?.trim());
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Normal and Max',
      'How replies are written',
      'What each message sends',
    ]);
    expect(where('Normal and Max')).toEqual(['Synced to your account']);
    // What Max costs stays in view.
    expect(screen.getByRole('group', { name: 'Normal and Max' }).textContent).toContain(
      'Max uses more than Normal.',
    );
    expect(where('How replies are written')).toEqual(['Synced to your account']);
    expect(where('What each message sends')).toEqual(['Synced to your account']);
    // The default reviewer is kept from the Review dialog.
    expect(screen.queryByRole('group', { name: 'Reviewer' })).toBeNull();
  });

  it('Normal and Max: Suggested says what it is in this thread; a chosen model keeps its value and is saved', async () => {
    const s = await opened(echo, { providers: [OWN, CREDIT] });
    const normal = within(screen.getByRole('group', { name: 'Normal' }));
    const suggested = normal.getByRole('radio', { name: 'Suggested' });
    const line = () =>
      document.getElementById(suggested.getAttribute('aria-describedby') ?? '')?.textContent;
    // No conversation open: what a new one gets, on the default payer (the own key).
    expect(line()).toBe(
      "Follows each thread's payer. In a new conversation: deepseek-v4-pro on OpenRouter.",
    );
    openTree(TestBed.inject(TreeStore), onCredit());
    await s.fixture.whenStable();
    expect(line()).toBe(
      "Follows each thread's payer. In this thread: claude-haiku-5.5 on Tangent credit.",
    );
    expect(suggested).toHaveProperty('checked', true);
    expect(normal.queryByRole('textbox', { name: 'Model' })).toBeNull();

    // Choose a model: the picker, under it, starts on the tier's model now.
    await s.user.click(normal.getByRole('radio', { name: 'Choose a model' }));
    const model = () => normal.getByRole<HTMLInputElement>('textbox', { name: 'Model' });
    expect(model().value).toBe(HAIKU);
    await s.user.clear(model());
    await s.user.type(model(), PRO);
    // Back on Suggested and again: the pick is kept.
    await s.user.click(suggested);
    expect(normal.queryByRole('textbox', { name: 'Model' })).toBeNull();
    await s.user.click(normal.getByRole('radio', { name: 'Choose a model' }));
    expect(model().value).toBe(PRO);

    await s.user.click(screen.getByRole('button', { name: 'Save' }));
    await s.fixture.whenStable();
    const pro = { providerId: 'openrouter', funding: 'credit', model: PRO };
    expect(s.api.updateSettings).toHaveBeenCalledExactlyOnceWith({ tiers: { normal: pro } });
    expect(s.settings.settings().tiers).toEqual({ normal: pro, max: null });
  });

  it('a tier’s picker offers Normal and Max as the dialog holds them, before they are saved', async () => {
    const s = await opened(echo, {
      providers: [provider(), CREDIT],
      tree: onCredit(),
    });
    const normal = within(screen.getByRole('group', { name: 'Normal' }));
    await s.user.click(normal.getByRole('radio', { name: 'Choose a model' }));
    const model = normal.getByRole<HTMLInputElement>('textbox', { name: 'Model' });
    await s.user.clear(model);
    await s.user.type(model, PRO);

    const max = within(screen.getByRole('group', { name: 'Max' }));
    await s.user.click(max.getByRole('radio', { name: 'Choose a model' }));
    const chips = within(max.getByRole('group', { name: 'Suggested models' }));
    expect(
      chips.getAllByRole('button').map((b) => b.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual(['Normal · deepseek-v4-pro', 'Max · claude-sonnet-5.5', 'claude-haiku-5.5']);
    expect(s.settings.settings().tiers.normal).toBeNull();
  });

  it('the default prompt: says under the box which prompt is used, and offers Clear only with text', async () => {
    const s = await opened();
    const status = () =>
      screen
        .getByText(/^Using (the built-in|your) prompt/)
        .textContent?.replace(/\s+/g, ' ')
        .trim();
    expect(status()).toBe(
      'Using the built-in prompt: it answers directly, then suggests tangents.',
    );
    expect(s.prompt.getAttribute('placeholder')).toBe('Leave empty to use the built-in prompt');
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();

    await s.user.type(s.prompt, 'Be brief.');
    expect(status()).toBe('Using your prompt.');
    await s.user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(s.prompt.value).toBe('');
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    // Clear went with the text: the focus moves to its neighbour rather than to the page.
    const startFrom = screen.getByRole('button', { name: 'Start from the built-in prompt' });
    expect(document.activeElement).toBe(startFrom);
    await s.user.click(startFrom);
    expect(s.prompt.value).toBe('Answer directly.');
    expect(status()).toBe(
      'Using the built-in prompt: it answers directly, then suggests tangents.',
    );
  });

  it('opens on the account’s settings', async () => {
    await opened(echo, {
      saved: fixtures.accountSettings({
        systemPrompt: 'Be brief.',
        tiers: { normal: null, max: { providerId: 'openrouter', funding: 'credit', model: PRO } },
        maxOutputTokens: 8192,
        maxInputTokens: 32_000,
        inputOverflow: 'truncate',
      }),
      providers: [provider(), CREDIT],
    });
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Default system prompt' }).value,
    ).toBe('Be brief.');
    const max = within(screen.getByRole('group', { name: 'Max' }));
    expect(max.getByRole('radio', { name: 'Choose a model' })).toHaveProperty('checked', true);
    expect(max.getByRole<HTMLInputElement>('textbox', { name: 'Model' }).value).toBe(PRO);
    expect(screen.getByRole('radio', { name: '8k' })).toHaveProperty('checked', true);
    expect(screen.getByRole('checkbox', { name: 'Limit what each message sends' })).toHaveProperty(
      'checked',
      true,
    );
  });

  it('until the settings load, nothing can be edited or saved', async () => {
    await loading();
    for (const group of ['Normal and Max', 'How replies are written', 'What each message sends'])
      expect(screen.getByRole('group', { name: group })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('a failed load says so, and Save stays off', async () => {
    await loading(async () => {
      throw new ApiError(503, 'network', 'The server could not be reached.');
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      "Couldn't load your settings: The server could not be reached.",
    );
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  });

  it('saves all or nothing: when the save fails, nothing is saved, and it says why above Save', async () => {
    const s = await opened(async () => {
      throw new ApiError(503, 'network', 'The server could not be reached.');
    });
    await s.user.type(s.prompt, 'Be brief.');
    await s.user.click(screen.getByRole('radio', { name: '8k' }));
    await s.user.click(screen.getByRole('button', { name: 'Save' }));
    await s.fixture.whenStable();
    expect(s.api.updateSettings).toHaveBeenCalledExactlyOnceWith({
      systemPrompt: 'Be brief.',
      maxOutputTokens: 8192,
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(
      "Couldn't save your settings: The server could not be reached.",
    );
    // Right above Save, not in a toast.
    expect(alert.nextElementSibling?.contains(screen.getByRole('button', { name: 'Save' }))).toBe(
      true,
    );
    // The settings in use are untouched, so Cancel still undoes every edit.
    expect(s.settings.settings()).toEqual(DEFAULT_SETTINGS);
    // The dialog stays open with the edits.
    expect(s.dialogs.isOpen('settings')).toBe(true);
    expect(s.prompt.value).toBe('Be brief.');
  });

  it('brings the save error into view and leaves the focus on Save', async () => {
    const s = await opened(async () => {
      throw new ApiError(503, 'network', 'The server could not be reached.');
    });
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView');
    await s.user.type(s.prompt, 'Be brief.');
    const save = screen.getByRole('button', { name: 'Save' });
    await s.user.click(save);
    await s.fixture.whenStable();
    const alert = screen.getByRole('alert');
    await vi.waitFor(() => expect(scrolled.mock.contexts).toContain(alert));
    expect(scrolled).toHaveBeenLastCalledWith({ block: 'nearest' });
    // Focusing anything else would raise a phone's keyboard.
    expect(document.activeElement).toBe(save);
    scrolled.mockRestore();
  });

  it('saves every change in one request, takes the account’s answer and closes', async () => {
    const s = await opened();
    await s.user.type(s.prompt, 'Be brief.');
    await s.user.click(screen.getByRole('radio', { name: '8k' }));
    await s.user.click(screen.getByRole('button', { name: 'Save' }));
    await s.fixture.whenStable();
    expect(s.api.updateSettings).toHaveBeenCalledExactlyOnceWith({
      systemPrompt: 'Be brief.',
      maxOutputTokens: 8192,
    });
    expect(s.settings.settings().maxOutputTokens).toBe(8192);
    expect(s.settings.prompt().saved).toBe('Be brief.');
    expect(s.dialogs.isOpen('settings')).toBe(false);
  });

  it('with nothing changed, Save sends nothing and closes', async () => {
    const s = await opened();
    await s.user.click(screen.getByRole('button', { name: 'Save' }));
    await s.fixture.whenStable();
    expect(s.api.updateSettings).not.toHaveBeenCalled();
    expect(s.dialogs.isOpen('settings')).toBe(false);
  });

  it('a backdrop tap asks before it discards an edit (a tier, a limit, the prompt), and closes once each is taken back', async () => {
    const s = await opened(echo, { providers: [OWN, CREDIT] });
    const backdrop = s.host.querySelector<HTMLElement>('.backdrop')!;
    const ask = () => screen.queryByRole('alertdialog', { name: 'Discard your changes?' });
    const normal = within(screen.getByRole('group', { name: 'Normal' }));
    const limit = within(screen.getByRole('group', { name: 'Reply limit' }));
    const edits: [() => Promise<void>, () => Promise<void>][] = [
      [
        () => s.user.click(normal.getByRole('radio', { name: 'Choose a model' })),
        () => s.user.click(normal.getByRole('radio', { name: 'Suggested' })),
      ],
      [
        () => s.user.click(limit.getByRole('radio', { name: '8k' })),
        () => s.user.click(limit.getByRole('radio', { name: /^Auto/ })),
      ],
      [() => s.user.type(s.prompt, 'Be brief.'), () => s.user.clear(s.prompt)],
    ];
    for (const [edit, takeBack] of edits) {
      await edit();
      await s.user.click(backdrop);
      expect(ask()).not.toBeNull();
      await s.user.click(screen.getByRole('button', { name: 'Keep editing' }));
      await takeBack();
    }
    await s.user.click(backdrop);
    expect(ask()).toBeNull();
    expect(s.dialogs.isOpen('settings')).toBe(false);
  });
});
