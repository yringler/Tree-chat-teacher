import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../testing';
import { KeyForm, type KeySubmission } from './key-form';

async function form(inputs: Record<string, unknown>) {
  const r = await render(KeyForm, { inputs });
  const saved = vi.fn<(s: KeySubmission) => void>();
  r.component.saved.subscribe(saved);
  return { ...r, saved, user: userEvent.setup() };
}

describe('KeyForm', () => {
  it("one provider: no picker, the field's own label, and the key handed over once, trimmed", async () => {
    const f = await form({
      providers: [{ id: 'anthropic', label: 'Anthropic' }],
      provider: 'anthropic',
      label: 'Your Anthropic API key',
      placeholder: 'sk-ant-…',
    });
    expect(screen.queryByRole('combobox')).toBeNull();
    const field = screen.getByLabelText<HTMLInputElement>('Your Anthropic API key');
    expect(field.type).toBe('password');
    expect(field.placeholder).toBe('sk-ant-…');
    expect(screen.getByText(/checked with Anthropic/)).toBeTruthy();
    await f.user.type(field, '  sk-ant-1  ');
    await f.user.click(screen.getByRole('button', { name: 'Save key' }));
    expect(f.saved).toHaveBeenCalledExactlyOnceWith({ provider: 'anthropic', apiKey: 'sk-ant-1' });
    expect(field.value).toBe('');
  });

  it('several providers: the picker chooses whose key it is; an empty field sends nothing', async () => {
    const f = await form({
      providers: [
        { id: 'anthropic', label: 'Anthropic' },
        { id: 'openrouter', label: 'OpenRouter' },
      ],
      provider: 'anthropic',
    });
    await f.user.selectOptions(screen.getByRole('combobox', { name: 'Provider' }), 'openrouter');
    expect(screen.getByText(/checked with OpenRouter/)).toBeTruthy();
    const field = screen.getByLabelText<HTMLInputElement>('API key');
    await f.user.type(field, '   ');
    await f.user.click(screen.getByRole('button', { name: 'Save key' }));
    expect(f.saved).not.toHaveBeenCalled();
    await f.user.type(field, 'sk-or-1');
    await f.user.click(screen.getByRole('button', { name: 'Save key' }));
    expect(f.saved).toHaveBeenCalledExactlyOnceWith({ provider: 'openrouter', apiKey: 'sk-or-1' });
  });

  it('waits while a save is in flight', async () => {
    await form({ providers: [{ id: 'openrouter', label: 'OpenRouter' }], busy: true });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Checking…' }).disabled).toBe(
      true,
    );
  });
});
