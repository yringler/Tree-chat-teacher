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

describe("account settings: power's models and limits", () => {
  const normal = { providerId: 'openrouter', funding: 'credit', model: 'a/normal' } as const;
  const max = { providerId: 'anthropic', funding: 'own-key', model: 'claude-max' } as const;

  it('starts on the defaults', async () => {
    const { chat } = setup({ autoTitle: false });
    expect(await chat.getSettings()).toMatchObject({
      tiers: { normal: null, max: null },
      reviewer: null,
      maxOutputTokens: null,
      maxInputTokens: null,
      inputOverflow: 'compact',
    });
  });

  it('saves the fields it names and keeps the others', async () => {
    const { chat } = setup({ autoTitle: false });
    await chat.updateSettings({ systemPrompt: 'MINE', tiers: { normal, max } });
    const saved = await chat.updateSettings({
      tiers: { max: null },
      reviewer: max,
      maxOutputTokens: 8192,
      maxInputTokens: 32_000,
      inputOverflow: 'truncate',
    });
    expect(saved).toMatchObject({
      systemPrompt: 'MINE',
      tiers: { normal, max: null },
      reviewer: max,
      maxOutputTokens: 8192,
      maxInputTokens: 32_000,
      inputOverflow: 'truncate',
    });
    expect(await chat.getSettings()).toEqual(saved);
    // Null goes back to the default; what isn't named stays.
    expect(await chat.updateSettings({ reviewer: null, maxInputTokens: null })).toMatchObject({
      tiers: { normal, max: null },
      reviewer: null,
      maxOutputTokens: 8192,
      maxInputTokens: null,
      inputOverflow: 'truncate',
    });
  });

  it.each([
    ['a reply limit below the least', { maxOutputTokens: 255 }],
    ['a reply limit above the most', { maxOutputTokens: 128_001 }],
    ['a fractional reply limit', { maxOutputTokens: 1000.5 }],
    ['an input limit below the least', { maxInputTokens: 999 }],
    ['an input limit above the most', { maxInputTokens: 2_000_001 }],
    ['an unknown overflow', { inputOverflow: 'forget' }],
    ['a null overflow', { inputOverflow: null }],
    ['an unknown payer', { reviewer: { ...normal, funding: 'free' } }],
    ['a model without a payer', { reviewer: { providerId: 'p', model: 'm' } }],
    ['an empty provider', { reviewer: { ...normal, providerId: '' } }],
    ['an overlong provider', { reviewer: { ...normal, providerId: 'p'.repeat(65) } }],
    ['an overlong model', { tiers: { normal: { ...normal, model: 'm'.repeat(201) } } }],
    ['no tier', { tiers: {} }],
  ])('rejects %s', async (_name, body) => {
    const { chat } = setup({ autoTitle: false });
    // Deliberately malformed bodies, as a client could send them.
    await expect(chat.updateSettings(JSON.parse(JSON.stringify(body)))).rejects.toThrow();
    expect((await chat.getSettings()).reviewer).toBeNull();
  });

  it('reads a stored value that no longer validates as its default, keeping the rest', async () => {
    const { chat, repos } = setup({ autoTitle: false });
    await chat.updateSettings({ systemPrompt: 'MINE' });
    const [accountId] = repos.dump().settings.keys();
    await repos.settings.updateSettings(
      accountId!,
      {
        tierNormal: { ...normal, funding: 'retired' },
        tierMax: max,
        reviewer: { ...normal, model: '' },
        maxOutputTokens: 100,
        maxInputTokens: 5_000_000,
        inputOverflow: 'forget',
      },
      '2026-02-01T00:00:00.000Z',
    );
    expect(await chat.getSettings()).toMatchObject({
      systemPrompt: 'MINE',
      tiers: { normal: null, max },
      reviewer: null,
      maxOutputTokens: null,
      maxInputTokens: null,
      inputOverflow: 'compact',
    });
  });
});

describe("account settings: Learn's reply settings", () => {
  it('are the defaults until saved, then as saved, one at a time', async () => {
    const { chat } = setup({ autoTitle: false });
    expect((await chat.getSettings()).learn).toEqual({ tier: 'normal', replyLength: 'normal' });
    await chat.updateSettings({ learn: { tier: 'max' } });
    const saved = await chat.updateSettings({ learn: { replyLength: 'long' } });
    expect(saved.learn).toEqual({ tier: 'max', replyLength: 'long' });
    expect(await chat.learnReplySettings()).toEqual({ tier: 'max', replyLength: 'long' });
    await chat.updateSettings({ learn: { tier: 'normal', replyLength: 'normal' } });
    expect(await chat.learnReplySettings()).toEqual({ tier: 'normal', replyLength: 'normal' });
  });

  it('a stored value that no longer validates reads as its default', async () => {
    const { chat, repos } = setup({ autoTitle: false });
    await repos.settings.updateSettings(
      chat.accountId,
      { learnTier: 'ultra', learnReplyLength: 'veryLong' },
      '2026-01-01T00:00:00.000Z',
    );
    expect(await chat.learnReplySettings()).toEqual({ tier: 'normal', replyLength: 'veryLong' });
    expect((await chat.getSettings()).learn).toEqual({ tier: 'normal', replyLength: 'veryLong' });
  });
});
