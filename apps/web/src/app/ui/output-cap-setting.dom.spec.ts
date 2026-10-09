import type { ProviderInfo } from '@tangent/shared';
import { render } from '@tangent/web-shared/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { effectiveOutputCap, OutputCapSetting } from './output-cap-setting';

function provider(over: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: 'openrouter',
    kind: 'openai-compatible',
    label: 'OpenRouter',
    models: [],
    defaultModel: 'deepseek/deepseek-v4-pro',
    openModels: true,
    available: true,
    acceptsUserKey: true,
    keySource: 'user',
    funding: 'own-key',
    ...over,
  };
}

describe('effectiveOutputCap', () => {
  it('is Auto’s default for the model: 16k on a reasoning model, 4k otherwise', () => {
    const own = provider();
    expect(effectiveOutputCap(null, { model: 'deepseek/deepseek-v4-pro', provider: own })).toEqual({
      tokens: 16_384,
      reasoning: true,
      limit: null,
    });
    expect(effectiveOutputCap(null, { model: 'openai/gpt-4o', provider: own })).toMatchObject({
      tokens: 4096,
      reasoning: false,
    });
  });

  it('is the chosen cap, within Tangent credit’s limit or a listed model’s', () => {
    const credit = provider({ funding: 'credit' });
    expect(
      effectiveOutputCap(32_768, { model: 'anthropic/claude-sonnet-5.5', provider: credit }),
    ).toEqual({ tokens: 16_384, reasoning: true, limit: 16_384 });
    expect(effectiveOutputCap(8192, { model: 'openai/gpt-4o', provider: credit }).tokens).toBe(
      8192,
    );
    const listed = provider({
      models: [{ id: 'mine', label: 'Mine', maxOutputTokens: 6000, reasoning: true }],
    });
    expect(effectiveOutputCap(null, { model: 'mine', provider: listed })).toEqual({
      tokens: 6000,
      reasoning: true,
      limit: 6000,
    });
    // Unknown provider (not loaded yet): no limit to apply.
    expect(effectiveOutputCap(50_000, { model: 'x', provider: undefined }).tokens).toBe(50_000);
  });
});

const radio = (name: string) => screen.getByRole<HTMLInputElement>('radio', { name });
const hint = (host: HTMLElement) => host.querySelector('.output-cap-hint')?.textContent?.trim();

describe('OutputCapSetting', () => {
  it('says what the open conversation’s replies get, as the choice changes', async () => {
    const r = await render(OutputCapSetting, {
      inputs: { target: { model: 'deepseek/deepseek-v4-pro', provider: provider() } },
    });
    const user = userEvent.setup();
    expect(radio('Auto 4k, or 16k for a model that reasons.').checked).toBe(true);
    expect(hint(r.host)).toBe(
      "This conversation's model (deepseek/deepseek-v4-pro) reasons before answering: " +
        'its replies get up to 16k tokens.',
    );
    await user.click(radio('8k'));
    expect(r.component.value()).toBe(8192);
    expect(hint(r.host)).toContain('up to 8k tokens.');
    // On Tangent credit, its limit wins over a larger choice.
    await user.click(radio('32k'));
    await r.set({
      target: { model: 'anthropic/claude-sonnet-5.5', provider: provider({ funding: 'credit' }) },
    });
    expect(hint(r.host)).toContain('up to 16k tokens, its limit.');
  });

  it('takes a custom number in range, and keeps the last valid one otherwise', async () => {
    const r = await render(OutputCapSetting);
    const user = userEvent.setup();
    expect(hint(r.host)).toBeUndefined();
    await user.click(radio('Custom'));
    const box = screen.getByRole<HTMLInputElement>('spinbutton', { name: /^Tokens/ });
    expect(box.value).toBe('12000');
    expect(r.component.value()).toBe(12_000);
    await user.clear(box);
    await user.type(box, '100');
    expect(r.component.invalid()).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('Enter a whole number');
    expect(r.component.value()).toBe(12_000);
    await user.click(radio('Auto 4k, or 16k for a model that reasons.'));
    expect(r.component.value()).toBeNull();
    expect(r.component.invalid()).toBe(false);
  });
});
