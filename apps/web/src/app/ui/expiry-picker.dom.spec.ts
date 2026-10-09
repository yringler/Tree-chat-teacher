import { render } from '@tangent/web-shared/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpiryPicker } from './expiry-picker';

/** The picker as the share editor opens it on `expiresAt`. */
async function open(expiresAt: string | null) {
  const r = await render(ExpiryPicker, { inputs: { expiresAt } });
  const expires = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Expires' });
  return { ...r, expires, user: userEvent.setup({ advanceTimers: vi.advanceTimersByTime }) };
}

describe('ExpiryPicker', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T15:00:00'));
  });

  afterEach(() => vi.useRealTimers());

  it('a new share never expires until the user picks a time', async () => {
    const p = await open(null);
    expect(p.expires.value).toBe('none');
    expect(screen.queryByLabelText('Date')).toBeNull();
    await p.user.selectOptions(p.expires, 'In 7 days');
    expect(p.component.expiresAt()).toBe(new Date('2026-10-15T15:00:00').toISOString());
    await p.user.selectOptions(p.expires, 'Never');
    expect(p.component.expiresAt()).toBeNull();
  });

  it('on a date: the end of that day', async () => {
    const p = await open(null);
    await p.user.selectOptions(p.expires, 'On a date…');
    const date = screen.getByLabelText<HTMLInputElement>('Date');
    expect(date.min).toBe('2026-10-08');
    await p.user.clear(date);
    await p.user.type(date, '2026-11-01');
    expect(p.component.expiresAt()).toBe(new Date('2026-11-01T23:59:59').toISOString());
  });

  it('opened on an existing expiry, shows its date and keeps it to the second', async () => {
    // Expired at 09:30 today: moving it to the end of today would bring the share back.
    const exact = new Date('2026-10-08T09:30:00').toISOString();
    const p = await open(exact);
    expect(p.expires.value).toBe('custom');
    expect(screen.getByLabelText<HTMLInputElement>('Date').value).toBe('2026-10-08');
    expect(p.component.expiresAt()).toBe(exact);
  });
});
