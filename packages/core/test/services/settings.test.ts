import { describe, expect, it } from 'vitest';
import { appChatSettings, DEFAULT_CHAT_SETTINGS } from '../../src/services/settings.js';
import { setup } from './helpers.js';

describe('appChatSettings', () => {
  const config = {
    summaryProviderId: 'p',
    summaryModel: 'm',
    groundingPolicy: 'explicit',
  } as const;

  it("keeps the defaults but for the operator's choices", () => {
    expect(appChatSettings('power', { ...config, maxInputTokens: 9000 })).toEqual({
      ...DEFAULT_CHAT_SETTINGS,
      summaryProviderId: 'p',
      summaryModel: 'm',
      maxInputTokens: 9000,
      grounding: { ...DEFAULT_CHAT_SETTINGS.grounding, policy: 'explicit' },
    });
  });

  it('titles every Learn conversation and ignores its branches’ grounding setting', () => {
    const learn = appChatSettings('learn', { ...config, autoTitle: false });
    expect(learn.autoTitle).toBe(true);
    expect(learn.grounding).toMatchObject({ policy: 'explicit', ignoreBranchSetting: true });
    const power = appChatSettings('power', { ...config, autoTitle: false });
    expect(power.autoTitle).toBe(false);
    expect(power.grounding.ignoreBranchSetting).toBe(false);
  });
});

describe('account settings: the walkthrough flag', () => {
  it('starts as not done', async () => {
    const { chat } = setup({ autoTitle: false });
    expect((await chat.getSettings()).walkthroughDoneAt).toBeNull();
  });

  it('marks the walkthrough done with the time, keeping a saved prompt', async () => {
    const { chat } = setup({ autoTitle: false });
    await chat.updateSettings({ systemPrompt: 'MINE' });
    const done = await chat.updateSettings({ walkthroughDone: true });
    expect(done.systemPrompt).toBe('MINE');
    expect(done.walkthroughDoneAt).toMatch(/^2026-01-01T00:00:\d\d\.000Z$/);
    expect(await chat.getSettings()).toEqual(done);
  });

  it('keeps the flag when only the prompt changes, and clears it on false', async () => {
    const { chat } = setup({ autoTitle: false });
    const { walkthroughDoneAt } = await chat.updateSettings({ walkthroughDone: true });
    expect(walkthroughDoneAt).not.toBeNull();
    const saved = await chat.updateSettings({ systemPrompt: 'Again.' });
    expect(saved).toMatchObject({ systemPrompt: 'Again.', walkthroughDoneAt });
    expect(await chat.updateSettings({ systemPrompt: null })).toMatchObject({
      systemPrompt: null,
      walkthroughDoneAt,
    });
    expect((await chat.updateSettings({ walkthroughDone: false })).walkthroughDoneAt).toBeNull();
  });

  it('two changes at once, of different fields, both stick', async () => {
    const { chat } = setup({ autoTitle: false });
    await Promise.all([
      chat.updateSettings({ systemPrompt: 'MINE' }),
      chat.updateSettings({ walkthroughDone: true }),
    ]);
    const saved = await chat.getSettings();
    expect(saved.systemPrompt).toBe('MINE');
    expect(saved.walkthroughDoneAt).not.toBeNull();
  });

  it('rejects an update that changes nothing', async () => {
    const { chat } = setup({ autoTitle: false });
    await expect(chat.updateSettings({})).rejects.toThrow();
  });
});
