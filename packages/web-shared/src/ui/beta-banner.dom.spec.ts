import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../testing';
import { BETA_NOTICE_SNOOZE_MS, BetaBanner, betaNoticeDue } from './beta-banner';

const KEY = 'tangent.betaNoticeDismissedAt';
const NOW = 1_800_000_000_000;

describe('betaNoticeDue', () => {
  it('shows until a day has passed since the notice was closed', () => {
    expect(betaNoticeDue(null, NOW)).toBe(true);
    expect(betaNoticeDue(String(NOW - 1000), NOW)).toBe(false);
    expect(betaNoticeDue(String(NOW - BETA_NOTICE_SNOOZE_MS + 1), NOW)).toBe(false);
    expect(betaNoticeDue(String(NOW - BETA_NOTICE_SNOOZE_MS), NOW)).toBe(true);
  });

  it('shows on a garbled or future time', () => {
    for (const raw of ['', 'yesterday', 'NaN', 'Infinity', String(NOW + 60_000)]) {
      expect(betaNoticeDue(raw, NOW)).toBe(true);
    }
  });
});

describe('BetaBanner', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('asks for reports at the admin mailbox, and closing it remembers when', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    await render(BetaBanner);
    const link = screen.getByRole('link', { name: `admin@${location.hostname}` });
    expect(link.getAttribute('href')).toBe(`mailto:admin@${location.hostname}`);

    await userEvent.click(screen.getByRole('button', { name: 'Close the beta notice' }));
    expect(screen.queryByRole('note')).toBeNull();
    expect(localStorage.getItem(KEY)).toBe(String(NOW));
  });

  it('stays closed within a day of closing it', async () => {
    localStorage.setItem(KEY, String(Date.now() - 1000));
    await render(BetaBanner);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('comes back a day later', async () => {
    localStorage.setItem(KEY, String(Date.now() - BETA_NOTICE_SNOOZE_MS));
    await render(BetaBanner);
    expect(screen.getByRole('note').textContent).toContain('Beta.');
  });
});
