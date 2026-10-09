import { TestBed } from '@angular/core/testing';
import type { InputBudgetResponse } from '@tangent/shared';
import { detail, openTree, powerProviders, render } from '@tangent/web-shared/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
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

/**
 * The setting as the settings dialog shows it, with a conversation open on
 * its trunk (unless `conversation` is false) whose numbers load as `info` (an
 * Error: they fail to). `inputs` are the dialog's bindings.
 */
async function open(
  info: InputBudgetResponse | Error,
  opts: { conversation?: boolean; inputs?: Record<string, unknown> } = {},
) {
  const api = {
    inputBudget: vi.fn(async () => {
      if (info instanceof Error) throw info;
      return info;
    }),
  };
  const r = await render(InputLimitSetting, {
    inputs: opts.inputs,
    providers: powerProviders(TreeStore, api),
    setup: () => {
      if (opts.conversation !== false) openTree(TestBed.inject(TreeStore), detail());
    },
  });
  /** The hints under the setting; null where none shows. */
  const notes = () => {
    const text = (part: string) =>
      r.host.querySelector(`.input-limit-${part}`)?.textContent?.trim() ?? null;
    return { size: text('size'), route: text('route'), cost: text('cost') };
  };
  return { ...r, api, notes, user: userEvent.setup() };
}

const limitBox = () =>
  screen.getByRole<HTMLInputElement>('checkbox', { name: 'Limit what each message sends' });
const radio = (name: string | RegExp) => screen.getByRole<HTMLInputElement>('radio', { name });
const customBox = () => screen.getByRole<HTMLInputElement>('spinbutton', { name: /^Tokens/ });

describe('InputLimitSetting', () => {
  it('loads the open conversation’s numbers, and shows its default while off', async () => {
    const s = await open(CREDIT);
    expect(s.api.inputBudget).toHaveBeenCalledWith('trunk');
    expect(limitBox().checked).toBe(false);
    await vi.waitFor(() => expect(s.notes().route).toContain('On Tangent credit'));
    expect(s.notes().size).toContain('60,000 tokens');
    expect(s.component.value()).toBeNull();
  });

  it('turns on at 32,000, follows presets and custom numbers live, and turns off', async () => {
    const s = await open(OWN_KEY);
    await vi.waitFor(() => expect(s.notes().route).not.toBeNull());
    await s.user.click(limitBox());
    expect(s.component.value()).toBe(32_000);
    expect(radio('32,000').checked).toBe(true);
    await s.user.click(radio('128,000'));
    expect(s.component.value()).toBe(128_000);
    expect(s.notes().size).toMatch(/^128,000 tokens ≈ 96,000 words/);

    await s.user.click(radio('Custom'));
    expect(radio('Custom').checked).toBe(true);
    await s.user.clear(customBox());
    await s.user.type(customBox(), '60000');
    expect(s.component.value()).toBe(60_000);
    expect(s.notes().size).toBe(
      '60,000 tokens ≈ 45,000 words ≈ 160 paperback pages, about the length of a short novel.',
    );
    expect(s.notes().cost).toContain('costs about $0.12 in input');

    // Out of range: invalid, and the last valid number stays.
    await s.user.clear(customBox());
    await s.user.type(customBox(), '50');
    expect(s.component.invalid()).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('Enter a whole number');
    expect(s.component.value()).toBe(60_000);
    await s.user.clear(customBox());
    expect(s.component.invalid()).toBe(true);

    // Off: no limit (and no error); on again restores the last one.
    await s.user.click(limitBox());
    expect(s.component.value()).toBeNull();
    expect(s.component.invalid()).toBe(false);
    await s.user.click(limitBox());
    expect(s.component.value()).toBe(60_000);
  });

  it('starts from a saved limit', async () => {
    const s = await open(OWN_KEY, { inputs: { value: 16_000 } });
    expect(limitBox().checked).toBe(true);
    expect(radio('16,000').checked).toBe(true);
    await s.set({ value: 50_000 });
    expect(radio('Custom').checked).toBe(true);
  });

  it('without a conversation, shows the size alone', async () => {
    const s = await open(OWN_KEY, { conversation: false });
    expect(s.api.inputBudget).not.toHaveBeenCalled();
    await s.user.click(limitBox());
    expect(s.notes()).toEqual({
      size: expect.stringMatching(/^32,000 tokens/),
      route: null,
      cost: null,
    });
  });

  it('when the numbers fail to load, shows the size alone', async () => {
    const s = await open(new Error('offline'));
    await vi.waitFor(() => expect(s.api.inputBudget).toHaveBeenCalled());
    await s.user.click(limitBox());
    expect(s.notes()).toMatchObject({ size: expect.stringMatching(/^32,000 tokens/), route: null });
  });

  it('keeps the over-limit choice', async () => {
    const s = await open(OWN_KEY);
    expect(radio(/^Summarize the oldest part/).checked).toBe(true);
    expect(s.component.overflow()).toBe('compact');
    await s.user.click(radio(/^Drop the oldest messages/));
    expect(s.component.overflow()).toBe('truncate');
  });
});
