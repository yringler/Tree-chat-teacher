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
import { describe, expect, it } from 'vitest';
import { SettingsStore } from '../state/settings-store';
import { TreeStore } from '../state/tree-store';
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
      TestBed.inject(SettingsStore).update({
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

describe('RouteBar', () => {
  it('names your Normal (Settings) when the thread is on it', async () => {
    expect(await chip(PRO)).toBe('Tangent credit · Normal');
  });

  it('names the model otherwise, even the one the provider suggests as Normal', async () => {
    expect(await chip(HAIKU)).toBe('Tangent credit · claude-haiku-5.5');
  });
});
