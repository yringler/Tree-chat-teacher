import { TestBed } from '@angular/core/testing';
import type { Branch, UpdateBranchRequest } from '@tangent/shared';
import { ToastStore } from '@tangent/web-shared';
import * as fixtures from '@tangent/web-shared/testing';
import {
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
import { ReviewStore } from '../state/review-store';
import { SettingsStore } from '../state/settings-store';
import { TreeStore } from '../state/tree-store';
import { ReviewDialog } from './review-dialog';

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

/** The main thread, on DeepSeek with Tangent credit. */
const trunk: Branch = fixtures.branch('trunk', {
  title: 'Main thread',
  funding: 'credit',
  model: PRO,
});

/**
 * The Review dialog on reply a1 of the main thread, its review by `model`
 * on Tangent credit done, with Normal set to DeepSeek on Tangent credit in
 * Settings.
 */
async function reviewed(model: string) {
  const api = {
    updateBranch: vi.fn(async (_id: string, req: UpdateBranchRequest) => ({ ...trunk, ...req })),
  };
  const r = await render(ReviewDialog, {
    inputs: { nodeId: 'a1' },
    providers: powerProviders(TreeStore, api),
    setup: () => {
      TestBed.inject(SettingsStore).update({
        tiers: { normal: { providerId: 'openrouter', funding: 'credit', model: PRO }, max: null },
      });
      const store = TestBed.inject(TreeStore);
      signIn(store.account, { providers: [provider(), CREDIT], builtInCredit: true });
      openTree(store, fixtures.detail([node('a1', { content: 'A wave.' })], [trunk]));
      TestBed.inject(ReviewStore).reviews.set(
        new Map([
          [
            'a1',
            {
              nodeId: 'a1',
              providerId: 'openrouter',
              funding: 'credit',
              model,
              phase: 'done',
              text: 'Light is also a particle.',
              status: null,
              error: null,
              usage: null,
            },
          ],
        ]),
      );
    },
  });
  return { ...r, api, toasts: TestBed.inject(ToastStore), user: userEvent.setup() };
}

describe('Review up to here', () => {
  it('names the reviewer’s model as the route chip does: “Normal” is only your Normal', async () => {
    // Credit's default model is labelled "Normal (suggested)", but your Normal is DeepSeek.
    const d = await reviewed(HAIKU);
    expect(screen.getByText(/^Reviewed by/).textContent?.replace(/\s+/g, ' ')).toBe(
      'Reviewed by claude-haiku-5.5',
    );
    screen.getByRole('button', { name: 'Tangent here with claude-haiku-5.5…' });

    await d.user.click(
      screen.getByRole('button', { name: 'Continue this thread with claude-haiku-5.5' }),
    );
    expect(d.api.updateBranch).toHaveBeenCalledWith('trunk', {
      providerId: 'openrouter',
      funding: 'credit',
      model: HAIKU,
    });
    expect(d.toasts.toasts().map((t) => t.text)).toEqual([
      '“Main thread” now uses claude-haiku-5.5',
    ]);
  });
});
