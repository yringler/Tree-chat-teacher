import '@angular/compiler'; // JIT: the component module below is decorated.
import { Injector, runInInjectionContext } from '@angular/core';
import type { InputBudgetResponse } from '@tangent/shared';
import { ApiClient } from '@tangent/web-shared';
import { describe, expect, it, vi } from 'vitest';
import { TreeStore } from '../state/tree-store';
import { InputLimitSetting, inputLimitNotes } from './input-limit-setting';

const OWN_KEY: InputBudgetResponse = {
  model: 'anthropic/claude-sonnet-5.5',
  funding: 'own-key',
  contextTokens: 1_000_000,
  maxOutputTokens: 64_000,
  reasoning: true,
  serverMaxInputTokens: null,
  price: { inputUsdPerMTok: 2, cacheReadUsdPerMTok: 0.2, basis: 'list' },
};
const CREDIT: InputBudgetResponse = {
  model: 'deepseek/deepseek-v4.1-flash',
  funding: 'credit',
  contextTokens: 60_000 + 16_384,
  maxOutputTokens: 16_384,
  reasoning: true,
  serverMaxInputTokens: 60_000,
  // $0.15 a million with OpenRouter's 5.5% and a 10% markup.
  price: { inputUsdPerMTok: 0.174075, cacheReadUsdPerMTok: null, basis: 'credit' },
};

describe('inputLimitNotes', () => {
  it('without an open conversation: only the size of the chosen limit', () => {
    expect(inputLimitNotes(null, { maxInputTokens: 60_000, maxOutputTokens: null })).toEqual({
      size: '60,000 tokens ≈ 45,000 words ≈ 160 paperback pages, about the length of a short novel.',
      route: null,
      cost: null,
    });
    expect(inputLimitNotes(null, { maxInputTokens: null, maxOutputTokens: null })).toEqual({
      size: null,
      route: null,
      cost: null,
    });
  });

  it('on the own key: the window less the reply is the default, and the cost at the limit', () => {
    expect(inputLimitNotes(OWN_KEY, { maxInputTokens: 200_000, maxOutputTokens: null })).toEqual({
      size: '200,000 tokens ≈ 150,000 words ≈ 550 paperback pages, about the length of a long novel.',
      route:
        "Without a limit, this conversation's model (anthropic/claude-sonnet-5.5) takes up to " +
        '983,616 tokens a message: its 1,000,000-token context window less 16,384 for the reply.',
      cost:
        'A message that sends all 200,000 tokens costs about $0.40 in input at ' +
        "anthropic/claude-sonnet-5.5's OpenRouter list price ($2.00 per million tokens), or " +
        'about $0.040 when it is read from the prompt cache ($0.20 per million). OpenRouter ' +
        'bills your key directly, and adds its fee when you buy OpenRouter credit.',
    });
  });

  it('with the limit off: the default’s size and cost', () => {
    const notes = inputLimitNotes(OWN_KEY, { maxInputTokens: null, maxOutputTokens: 32_768 });
    expect(notes.size).toBe(
      '967,232 tokens ≈ 730,000 words ≈ 2,600 paperback pages, about the length of 8 novels.',
    );
    expect(notes.route).toContain('less 32,768 for the reply.');
    expect(notes.cost).toContain('costs about $1.93 in input');
  });

  it('on Tangent credit: the server’s cap, which a larger limit can’t raise', () => {
    expect(inputLimitNotes(CREDIT, { maxInputTokens: 200_000, maxOutputTokens: null })).toEqual({
      size: '60,000 tokens ≈ 45,000 words ≈ 160 paperback pages, about the length of a short novel.',
      route:
        'On Tangent credit, a message sends at most 60,000 tokens (on deepseek/deepseek-v4.1-flash); ' +
        'a limit of yours can only lower that. Your limit is above that, so 60,000 applies.',
      cost:
        'A message that sends all 60,000 tokens costs about $0.010 in input on Tangent credit, ' +
        "which charges $0.1741 per million tokens of deepseek/deepseek-v4.1-flash's input " +
        "(OpenRouter's price with its fee and Tangent's markup).",
    });
    expect(
      inputLimitNotes(CREDIT, { maxInputTokens: 16_000, maxOutputTokens: null }).route,
    ).not.toContain('Your limit is above');
  });

  it('leaves the cost out without a price', () => {
    expect(
      inputLimitNotes({ ...OWN_KEY, price: null }, { maxInputTokens: null, maxOutputTokens: null })
        .cost,
    ).toBeNull();
  });
});

/** The component's protected view state, read the way its template does. */
interface View {
  enabled(): boolean;
  choice(): 'custom' | number;
  customError(): boolean;
  notes(): ReturnType<typeof inputLimitNotes>;
  setEnabled(on: boolean): void;
  pickPreset(tokens: number): void;
  pickCustom(): void;
  setCustom(text: string): void;
}

function open(info: InputBudgetResponse | Error, branch: { id: string } | null = { id: 'b1' }) {
  const api = {
    inputBudget: vi.fn(async () => {
      if (info instanceof Error) throw info;
      return info;
    }),
  };
  const injector = Injector.create({
    providers: [
      { provide: ApiClient, useValue: api },
      { provide: TreeStore, useValue: { selectedBranch: () => branch } },
    ],
  });
  const setting = runInInjectionContext(injector, () => new InputLimitSetting());
  setting.ngOnInit();
  return { setting, view: setting as unknown as View, api };
}

describe('InputLimitSetting', () => {
  it('loads the open conversation’s numbers, and shows its default while off', async () => {
    const { setting, view, api } = open(CREDIT);
    expect(api.inputBudget).toHaveBeenCalledWith('b1');
    expect(view.enabled()).toBe(false);
    await vi.waitFor(() => expect(view.notes().route).toContain('On Tangent credit'));
    expect(view.notes().size).toContain('60,000 tokens');
    expect(setting.value()).toBeNull();
  });

  it('turns on at 32,000, follows presets and custom numbers live, and turns off', async () => {
    const { setting, view } = open(OWN_KEY);
    await vi.waitFor(() => expect(view.notes().route).not.toBeNull());
    view.setEnabled(true);
    expect(setting.value()).toBe(32_000);
    expect(view.choice()).toBe(32_000);
    view.pickPreset(128_000);
    expect(setting.value()).toBe(128_000);
    expect(view.notes().size).toMatch(/^128,000 tokens ≈ 96,000 words/);

    view.pickCustom();
    expect(view.choice()).toBe('custom');
    view.setCustom('60000');
    expect(setting.value()).toBe(60_000);
    expect(view.notes().size).toBe(
      '60,000 tokens ≈ 45,000 words ≈ 160 paperback pages, about the length of a short novel.',
    );
    expect(view.notes().cost).toContain('costs about $0.12 in input');

    // Out of range: invalid, and the last valid number stays.
    view.setCustom('50');
    expect(setting.invalid()).toBe(true);
    expect(view.customError()).toBe(true);
    expect(setting.value()).toBe(60_000);
    view.setCustom('');
    expect(setting.invalid()).toBe(true);

    // Off: no limit (and no error); on again restores the last one.
    view.setEnabled(false);
    expect(setting.value()).toBeNull();
    expect(setting.invalid()).toBe(false);
    view.setEnabled(true);
    expect(setting.value()).toBe(60_000);
  });

  it('starts from a saved limit', () => {
    const { setting, view } = open(OWN_KEY);
    setting.value.set(16_000);
    expect(view.enabled()).toBe(true);
    expect(view.choice()).toBe(16_000);
    setting.value.set(50_000);
    expect(view.choice()).toBe('custom');
  });

  it('without a conversation, or when the numbers fail to load, shows the size alone', async () => {
    const none = open(OWN_KEY, null);
    expect(none.api.inputBudget).not.toHaveBeenCalled();
    none.view.setEnabled(true);
    expect(none.view.notes()).toEqual({
      size: expect.stringMatching(/^32,000 tokens/),
      route: null,
      cost: null,
    });

    const failed = open(new Error('offline'));
    await vi.waitFor(() => expect(failed.api.inputBudget).toHaveBeenCalled());
    failed.view.setEnabled(true);
    expect(failed.view.notes().route).toBeNull();
  });

  it('keeps the over-limit choice', () => {
    const { setting } = open(OWN_KEY);
    expect(setting.overflow()).toBe('compact');
    setting.overflow.set('truncate');
    expect(setting.overflow()).toBe('truncate');
  });
});
