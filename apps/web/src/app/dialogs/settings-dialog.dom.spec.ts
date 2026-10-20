import { TestBed } from '@angular/core/testing';
import type { SettingsResponse, UpdateSettingsRequest } from '@tangent/shared';
import { ApiError } from '@tangent/web-shared';
import { powerProviders, render, signIn } from '@tangent/web-shared/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, SettingsStore } from '../state/settings-store';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { DialogHost } from './dialog-host';
import { SettingsDialog } from './settings-dialog';

const SAVED: SettingsResponse = {
  systemPrompt: null,
  defaultSystemPrompt: 'Answer directly.',
  walkthroughDoneAt: null,
};

/** Settings, with the account's prompt still on its way (`settings` never answers). */
async function loading() {
  const api = { settings: vi.fn(() => new Promise<SettingsResponse>(() => {})) };
  const r = await render(SettingsDialog, {
    providers: powerProviders(TreeStore, api),
    setup: () => signIn(TestBed.inject(TreeStore).account),
  });
  return { ...r, api };
}

/** Settings opened on the dialog stack, the prompt loaded; `update` answers a save of it. */
async function opened(update: (req: UpdateSettingsRequest) => Promise<SettingsResponse>) {
  const api = { settings: vi.fn(async () => SAVED), updateSettings: vi.fn(update) };
  const r = await render(DialogHost, {
    providers: powerProviders(TreeStore, api),
    setup: () => signIn(TestBed.inject(TreeStore).account),
  });
  const dialogs = TestBed.inject(UiStore).dialogs;
  dialogs.open({ kind: 'settings' });
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

  it('saves all or nothing: when the prompt can’t be saved, nothing is, and it says why under the box', async () => {
    const s = await opened(async () => {
      throw new ApiError(503, 'network', 'The server could not be reached.');
    });
    await s.user.type(s.prompt, 'Be brief.');
    await s.user.click(screen.getByRole('radio', { name: '8k' }));
    await s.user.click(screen.getByRole('button', { name: 'Save' }));
    await s.fixture.whenStable();
    expect(s.api.updateSettings).toHaveBeenCalledExactlyOnceWith({ systemPrompt: 'Be brief.' });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('The server could not be reached.');
    // Right under the box, not in a toast.
    expect(s.prompt.closest('.field')?.nextElementSibling).toBe(alert);
    // The browser's settings are untouched, so Cancel still undoes the reply length.
    expect(s.settings.settings()).toEqual(DEFAULT_SETTINGS);
    expect(localStorage.getItem('tangent.settings')).toBeNull();
    // The dialog stays open with the edits.
    expect(s.dialogs.isOpen('settings')).toBe(true);
    expect(s.prompt.value).toBe('Be brief.');
  });

  it('once the prompt is saved, saves the rest and closes', async () => {
    const s = await opened(async (req) => ({ ...SAVED, systemPrompt: req.systemPrompt ?? null }));
    await s.user.type(s.prompt, 'Be brief.');
    await s.user.click(screen.getByRole('radio', { name: '8k' }));
    await s.user.click(screen.getByRole('button', { name: 'Save' }));
    await s.fixture.whenStable();
    expect(s.api.updateSettings).toHaveBeenCalledExactlyOnceWith({ systemPrompt: 'Be brief.' });
    expect(s.settings.settings().maxOutputTokens).toBe(8192);
    expect(s.dialogs.isOpen('settings')).toBe(false);
  });
});
