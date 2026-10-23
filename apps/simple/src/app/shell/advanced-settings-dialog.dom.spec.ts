import { TestBed } from '@angular/core/testing';
import {
  DEFAULT_LEARN_REPLY,
  type SettingsResponse,
  type UpdateSettingsRequest,
} from '@tangent/shared';
import { ToastStore } from '@tangent/web-shared';
import { accountSettings, appProviders, billing, render } from '@tangent/web-shared/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { learner, POOL_ON } from '../learn.testing';
import { ReplySettings } from '../state/reply-settings';
import { UiStore } from '../state/ui-store';
import { AdvancedSettingsDialog } from './advanced-settings-dialog';

/** Advanced settings, opened on what `facts` say of the learner; saves answer as the server would. */
async function open(facts: Parameters<typeof learner>[0] = {}, refuse = false) {
  let saved: SettingsResponse = accountSettings({ learn: facts.replies });
  const api = {
    updateSettings: vi.fn(async (req: UpdateSettingsRequest): Promise<SettingsResponse> => {
      if (refuse) throw new Error('Could not save');
      saved = { ...saved, learn: { ...saved.learn, ...req.learn } };
      return saved;
    }),
  };
  const r = await render(AdvancedSettingsDialog, {
    providers: appProviders(api),
    setup: () => {
      learner(facts);
      TestBed.inject(UiStore).dialogs.open({ kind: 'advanced-settings' });
    },
  });
  return { ...r, api, replies: TestBed.inject(ReplySettings), user: userEvent.setup() };
}

const radio = (name: RegExp) => screen.getByRole<HTMLInputElement>('radio', { name });
const credit = { billing: billing(), chosen: 'credit' } as const;

describe('Advanced settings', () => {
  it('starts on Normal and Normal length, and saves each pick at once', async () => {
    const { api, replies, user } = await open(credit);
    expect(radio(/^Normal Quick/).checked).toBe(true);
    expect(radio(/^Normal A page/).checked).toBe(true);
    expect(screen.getByRole('button', { name: 'Back to defaults' })).toHaveProperty(
      'disabled',
      true,
    );
    await user.click(radio(/^Max/));
    expect(api.updateSettings).toHaveBeenLastCalledWith({ learn: { tier: 'max' } });
    await user.click(radio(/^Very long/));
    expect(api.updateSettings).toHaveBeenLastCalledWith({ learn: { replyLength: 'veryLong' } });
    expect(replies.settings()).toEqual({ tier: 'max', replyLength: 'veryLong' });
    // Max says what it costs.
    expect(screen.getByText(/costs about 20 times as much/)).toBeTruthy();
  });

  it('locks the model on Max while Very long is picked, until a shorter length is', async () => {
    const { api, replies, user } = await open({ ...credit, replies: DEFAULT_LEARN_REPLY });
    await user.click(radio(/^Very long/));
    expect(screen.getByText(/Uses the Max model for accuracy/)).toBeTruthy();
    // Saved as picked: Max follows from the length.
    expect(api.updateSettings).toHaveBeenLastCalledWith({ learn: { replyLength: 'veryLong' } });
    expect(replies.settings()).toEqual({ tier: 'normal', replyLength: 'veryLong' });
    expect(radio(/^Max/).checked).toBe(true);
    expect(radio(/^Max/).disabled).toBe(true);
    expect(radio(/^Normal Quick/).disabled).toBe(true);
    expect(screen.getByText(/Very long replies need Max. Pick a shorter length/)).toBeTruthy();

    await user.click(radio(/^Long/));
    expect(radio(/^Normal Quick/).checked).toBe(true);
    expect(radio(/^Normal Quick/).disabled).toBe(false);
    expect(screen.queryByText(/Very long replies need Max/)).toBeNull();
  });

  it('warns of Long on Normal, until Max is picked', async () => {
    const { user } = await open({ ...credit, replies: { tier: 'normal', replyLength: 'long' } });
    expect(screen.getByText(/long replies are more likely to have accuracy issues/)).toBeTruthy();
    await user.click(radio(/^Max/));
    expect(screen.queryByText(/more likely to have accuracy issues/)).toBeNull();
  });

  it('goes back to the defaults in one save', async () => {
    const { api, replies, user } = await open({
      ...credit,
      replies: { tier: 'max', replyLength: 'long' },
    });
    await user.click(screen.getByRole('button', { name: 'Back to defaults' }));
    expect(api.updateSettings).toHaveBeenLastCalledWith({
      learn: { tier: 'normal', replyLength: 'normal' },
    });
    expect(replies.settings()).toEqual({ tier: 'normal', replyLength: 'normal' });
  });

  it('shows a refused save undone, and says so', async () => {
    const { replies, user } = await open(credit, true);
    const notify = vi.spyOn(TestBed.inject(ToastStore), 'notify');
    await user.click(radio(/^Max/));
    expect(replies.settings().tier).toBe('normal');
    expect(notify).toHaveBeenCalledWith('Could not save', 'error');
  });

  it('disables both while the open pool pays, saying why', async () => {
    await open({ pool: POOL_ON, chosen: 'pool' });
    expect(screen.getByText(/aren't used while the open pool pays/)).toBeTruthy();
    expect(radio(/^Max/).disabled).toBe(true);
    expect(radio(/^Very long/).disabled).toBe(true);
  });

  it('fixes the model on an Anthropic key, which always uses the stronger one', async () => {
    await open({
      chosen: 'own-key',
      chosenKey: 'anthropic',
      savedKeys: ['anthropic'],
      learnProviders: ['openrouter', 'anthropic'],
    });
    expect(screen.getByText(/always uses the stronger model/)).toBeTruthy();
    expect(radio(/^Max/).disabled).toBe(true);
    expect(radio(/^Very long/).disabled).toBe(false);
  });

  it('neither locks nor warns on an Anthropic key, whose one model is the stronger', async () => {
    await open({
      chosen: 'own-key',
      chosenKey: 'anthropic',
      savedKeys: ['anthropic'],
      learnProviders: ['openrouter', 'anthropic'],
      replies: { tier: 'normal', replyLength: 'long' },
    });
    expect(screen.queryByText(/more likely to have accuracy issues/)).toBeNull();
  });
});
