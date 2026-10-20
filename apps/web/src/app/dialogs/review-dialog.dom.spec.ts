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
import { type ModelChoice, SettingsStore } from '../state/settings-store';
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
 * The Review dialog on reply a1 of the main thread, with Normal set to
 * DeepSeek on Tangent credit in Settings, and `reviewer` as the default
 * reviewer; its review by `model` on Tangent credit done, unless `model` is
 * null (none yet). Reviews started are recorded, not run.
 */
async function open(model: string | null, reviewer: ModelChoice | null = null) {
  const api = {
    updateBranch: vi.fn(async (_id: string, req: UpdateBranchRequest) => ({ ...trunk, ...req })),
  };
  const r = await render(ReviewDialog, {
    inputs: { nodeId: 'a1' },
    providers: powerProviders(TreeStore, api),
    setup: () => {
      TestBed.inject(SettingsStore).update({
        tiers: { normal: { providerId: 'openrouter', funding: 'credit', model: PRO }, max: null },
        reviewer,
      });
      const store = TestBed.inject(TreeStore);
      signIn(store.account, { providers: [provider(), CREDIT], builtInCredit: true });
      openTree(store, fixtures.detail([node('a1', { content: 'A wave.' })], [trunk]));
      if (!model) return;
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
  const started = vi.spyOn(TestBed.inject(ReviewStore), 'start').mockResolvedValue();
  return {
    ...r,
    api,
    started,
    settings: TestBed.inject(SettingsStore),
    toasts: TestBed.inject(ToastStore),
    user: userEvent.setup(),
  };
}

const defaultBox = () =>
  screen.getByRole<HTMLInputElement>('checkbox', { name: 'Use as my default reviewer' });
/** What the box's helper says the default is. */
const defaultNote = () =>
  document.getElementById(defaultBox().getAttribute('aria-describedby') ?? '')?.textContent;

describe('Review up to here', () => {
  it('names the reviewer’s model as the route chip does: “Normal” is only your Normal', async () => {
    // Credit's default model is labelled "Normal (suggested)", but your Normal is DeepSeek.
    const d = await open(HAIKU);
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

  it('keeps the model picked as the default reviewer when asked, which names what the default is', async () => {
    const d = await open(HAIKU);
    // Settings has no reviewer any more, and this dialog no way there.
    expect(screen.queryByRole('button', { name: /Default reviewer/ })).toBeNull();
    // No default yet: the thread's provider's default model, which it names.
    expect(defaultBox().checked).toBe(false);
    expect(defaultNote()).toBe(
      'Your default: Same provider as the thread, its default model (here: claude-haiku-5.5).',
    );

    await d.user.click(screen.getByRole('textbox', { name: 'Model' }));
    await d.user.clear(screen.getByRole('textbox', { name: 'Model' }));
    await d.user.type(screen.getByRole('textbox', { name: 'Model' }), SONNET);
    await d.user.click(defaultBox());
    await d.user.click(screen.getByRole('button', { name: 'Review again' }));
    const sonnet = { providerId: 'openrouter', funding: 'credit', model: SONNET };
    expect(d.started).toHaveBeenCalledExactlyOnceWith('a1', sonnet);
    expect(d.settings.settings().reviewer).toEqual(sonnet);
    expect(defaultNote()).toBe('Your default: claude-sonnet-5.5 on Tangent credit.');
  });

  it('opened on the default reviewer, the box is ticked; unticked, a review puts the default back', async () => {
    const sonnet = { providerId: 'openrouter', funding: 'credit' as const, model: SONNET };
    const d = await open(null, sonnet);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Model' }).value).toBe(SONNET);
    expect(defaultBox().checked).toBe(true);
    expect(defaultNote()).toBe('Your default: claude-sonnet-5.5 on Tangent credit.');

    await d.user.click(defaultBox());
    await d.user.click(screen.getByRole('button', { name: 'Review' }));
    expect(d.started).toHaveBeenCalledExactlyOnceWith('a1', sonnet);
    expect(d.settings.settings().reviewer).toBeNull();
  });

  it('a review on another model leaves the default alone', async () => {
    const sonnet = { providerId: 'openrouter', funding: 'credit' as const, model: SONNET };
    const d = await open(HAIKU);
    d.settings.update({ reviewer: sonnet });
    await d.user.click(screen.getByRole('button', { name: 'Review again' }));
    expect(d.started).toHaveBeenCalledOnce();
    expect(d.settings.settings().reviewer).toEqual(sonnet);
  });
});
