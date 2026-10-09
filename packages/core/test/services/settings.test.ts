import { describe, expect, it } from 'vitest';
import { appChatSettings, DEFAULT_CHAT_SETTINGS } from '../../src/services/settings.js';

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
