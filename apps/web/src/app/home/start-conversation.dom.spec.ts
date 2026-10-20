import { TestBed } from '@angular/core/testing';
import type { ModelInfo, ProviderInfo } from '@tangent/shared';
import { billing, powerProviders, provider, render, signIn } from '@tangent/web-shared/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../state/settings-store';
import { loadSettings } from '../state/settings-store.testing';
import { TreeStore } from '../state/tree-store';
import { HomePage } from './home-page';

const HAIKU = 'anthropic/claude-haiku-5.5';
const SONNET = 'anthropic/claude-sonnet-5.5';
const PRO = 'deepseek/deepseek-v4-pro';

/** A Normal and a Max, as the server suggests them on OpenRouter and Tangent credit. */
const TIER_MODELS: ModelInfo[] = [
  { id: HAIKU, label: 'Normal (suggested)', tier: 'normal' },
  { id: SONNET, label: 'Max (suggested)', tier: 'max' },
];

/** OpenRouter on your own key, saved in this browser unless `available` says otherwise. */
const ownKey = (available = true) =>
  provider({ models: TIER_MODELS, defaultModel: HAIKU, available });

const CREDIT = provider({
  label: 'Tangent credit',
  acceptsUserKey: false,
  keySource: 'server',
  funding: 'credit',
  models: TIER_MODELS,
  defaultModel: HAIKU,
});

/** Your own Anthropic key, saved: a provider without tiers. */
const ANTHROPIC = provider({
  id: 'anthropic',
  kind: 'anthropic',
  label: 'Anthropic',
  models: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }],
  defaultModel: 'claude-opus-5-5',
  openModels: false,
});

/**
 * The home page for a member offered Tangent credit with $2 of it (or
 * `availableMicros`; top-ups are sold), over `providers`, with the Normal
 * and Max of `tiers` (Settings).
 */
async function home(
  providers: ProviderInfo[],
  tiers?: AppSettings['tiers'],
  availableMicros = 2_000_000,
) {
  const api = { billing: vi.fn(async () => billing({ availableMicros })) };
  await render(HomePage, {
    providers: powerProviders(TreeStore, api),
    setup: async () => {
      loadSettings(tiers ? { tiers } : {});
      const store = TestBed.inject(TreeStore);
      signIn(store.account, { providers, builtInCredit: true });
      await store.account.refreshBilling();
    },
  });
  const store = TestBed.inject(TreeStore);
  const start = vi.spyOn(store, 'startConversation').mockResolvedValue();
  return { start, user: userEvent.setup() };
}

const providerField = () => screen.getByRole<HTMLSelectElement>('combobox', { name: 'Provider' });

describe('A new conversation', () => {
  it('starts on your Normal (Settings), on the payer you chose it with', async () => {
    // The default route is your own OpenRouter key; your Normal is DeepSeek on Tangent credit.
    const h = await home([ownKey(), CREDIT], {
      normal: { providerId: 'openrouter', funding: 'credit', model: PRO },
      max: null,
    });
    expect(providerField().value).toBe('openrouter@credit');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Model' }).value).toBe(PRO);
    const tiers = screen.getByRole('toolbar', { name: 'Model tier' });
    expect(tiers.querySelector('[aria-pressed="true"]')?.textContent?.trim()).toBe('Normal');

    await h.user.type(screen.getByRole('textbox', { name: 'Message' }), 'Why is the sky blue?');
    await h.user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(h.start).toHaveBeenCalledWith('Why is the sky blue?', 'openrouter@credit', PRO);
  });

  it('starts on the default route when your Normal can’t reply in this browser', async () => {
    // Your Normal is on your own OpenRouter key, and none is saved here: Tangent credit can pay.
    await home([ownKey(false), CREDIT], {
      normal: { providerId: 'openrouter', funding: 'own-key', model: PRO },
      max: null,
    });
    expect(providerField().value).toBe('openrouter@credit');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Model' }).value).toBe(HAIKU);
  });

  it('starts on your own key, not on your Normal on Tangent credit, when no credit is left', async () => {
    // Top-ups are sold, but the first send on an empty balance would get a 402.
    await home(
      [ownKey(), CREDIT],
      { normal: { providerId: 'openrouter', funding: 'credit', model: PRO }, max: null },
      0,
    );
    expect(providerField().value).toBe('openrouter');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Model' }).value).toBe(HAIKU);
  });

  it('with no Normal chosen, starts on the default route, not on a suggested Normal another payer lists', async () => {
    await home([ANTHROPIC, CREDIT]);
    expect(providerField().value).toBe('anthropic');
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Model' }).value).toBe(
      'claude-opus-5-5',
    );
  });
});
