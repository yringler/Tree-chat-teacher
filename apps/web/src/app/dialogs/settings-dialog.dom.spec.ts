import { TestBed } from '@angular/core/testing';
import type { SettingsResponse } from '@tangent/shared';
import { powerProviders, render, signIn } from '@tangent/web-shared/testing';
import { screen } from '@testing-library/dom';
import { describe, expect, it, vi } from 'vitest';
import { TreeStore } from '../state/tree-store';
import { SettingsDialog } from './settings-dialog';

/** Settings, with the account's prompt still on its way (`settings` never answers). */
async function open() {
  const api = { settings: vi.fn(() => new Promise<SettingsResponse>(() => {})) };
  const r = await render(SettingsDialog, {
    providers: powerProviders(TreeStore, api),
    setup: () => signIn(TestBed.inject(TreeStore).account),
  });
  return { ...r, api };
}

describe('Settings', () => {
  it('opens at its top, on its heading, while the prompt loads: not on a control further down', async () => {
    await open();
    const heading = screen.getByRole('heading', { name: 'Settings' });
    await vi.waitFor(() => expect(document.activeElement).toBe(heading));
  });
});
