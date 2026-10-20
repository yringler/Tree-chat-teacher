import { TestBed } from '@angular/core/testing';
import {
  branch,
  detail,
  openTree,
  powerProviders,
  provider,
  render,
  signIn,
} from '@tangent/web-shared/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { loadSettings } from '../state/settings-store.testing';
import { TreeStore } from '../state/tree-store';
import { UiStore } from '../state/ui-store';
import { RouteBar } from './route-bar';

const HAIKU = 'anthropic/claude-haiku-5.5';
const SONNET = 'anthropic/claude-sonnet-5.5';
const PRO = 'deepseek/deepseek-v4-pro';

/** Tangent credit, suggesting a Normal and a Max as the server lists them. */
const CREDIT = provider({
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

/**
 * What the route chip reads on a main thread on Tangent credit and `model`,
 * with Normal set to DeepSeek on credit in Settings.
 */
async function chip(model: string): Promise<string | undefined> {
  await render(RouteBar, {
    providers: powerProviders(TreeStore, {}),
    setup: () => {
      loadSettings({
        tiers: { normal: { providerId: 'openrouter', funding: 'credit', model: PRO }, max: null },
      });
      const store = TestBed.inject(TreeStore);
      signIn(store.account, { providers: [provider(), CREDIT], builtInCredit: true });
      openTree(store, detail([], [branch('trunk', { funding: 'credit', model })]));
    },
  });
  return screen
    .getByRole('button', { name: /^Replies on/ })
    .textContent?.replace(/\s+/g, ' ')
    .trim();
}

/** The route chip, on the main thread or (`at`) a tangent off it. */
async function routeChip(at: string | null = null) {
  await render(RouteBar, {
    providers: powerProviders(TreeStore, {}),
    setup: () => {
      loadSettings();
      const store = TestBed.inject(TreeStore);
      signIn(store.account, { providers: [provider(), CREDIT], builtInCredit: true });
      openTree(
        store,
        detail(
          [],
          [
            branch('trunk', { funding: 'credit', model: HAIKU }),
            branch('side', { parentBranchId: 'trunk', funding: 'credit', model: HAIKU }),
          ],
        ),
        at,
      );
    },
  });
  return screen.getByRole('button', { name: /^Replies on/ });
}

describe('RouteBar', () => {
  it('the route chip opens the main thread’s replies in Conversation settings, there', async () => {
    const chip = await routeChip();
    expect(chip.getAttribute('aria-label')).toBe(
      'Replies on Tangent credit, Normal. Change the model or who pays',
    );
    expect(chip.title).toBe('Change the model or who pays');
    await userEvent.setup().click(chip);
    expect(TestBed.inject(UiStore).dialogs.list()).toEqual([
      { kind: 'tree-settings', section: 'replies' },
    ]);
  });

  it('and Tangent settings in a tangent', async () => {
    await userEvent.setup().click(await routeChip('side'));
    expect(TestBed.inject(UiStore).dialogs.list()).toEqual([{ kind: 'branch-settings' }]);
  });

  it('“Edit Normal and Max…” opens Settings at Normal and Max', async () => {
    await routeChip();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Edit Normal and Max…' }));
    expect(TestBed.inject(UiStore).dialogs.list()).toEqual([
      { kind: 'settings', section: 'tiers' },
    ]);
  });

  it('names your Normal (Settings) when the thread is on it', async () => {
    expect(await chip(PRO)).toBe('Tangent credit · Normal');
  });

  it('names the model otherwise, even the one the provider suggests as Normal', async () => {
    expect(await chip(HAIKU)).toBe('Tangent credit · claude-haiku-5.5');
  });
});
