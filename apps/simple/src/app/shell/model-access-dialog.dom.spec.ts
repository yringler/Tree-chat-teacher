import { TestBed } from '@angular/core/testing';
import type { PoolMeResponse } from '@tangent/shared';
import { ToastStore } from '@tangent/web-shared';
import { appProviders, billing, membership, render } from '@tangent/web-shared/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { learner, NOT_A_MEMBER, POOL_ON } from '../learn.testing';
import { LessonStore } from '../state/lesson-store';
import { UiStore } from '../state/ui-store';
import { ModelAccessDialog } from './model-access-dialog';

const POOL_ME: PoolMeResponse = {
  available: true,
  verified: true,
  suspended: false,
  caps: {
    requestsPerDay: 30,
    spendMicrosPerDay: 100_000,
    usedRequests: 3,
    usedSpendMicros: 0,
    resetAt: '2026-10-10T00:00:00.000Z',
  },
  personalAvailableMicros: 0,
};

/** "How replies are paid for", opened on what `facts` say of the learner. */
async function open(facts: Parameters<typeof learner>[0] = {}) {
  const api = {
    billing: vi.fn(async () => facts.billing ?? billing()),
    poolStatus: vi.fn(async () => facts.pool ?? { ...POOL_ON, enabled: false }),
    poolMe: vi.fn(async () => POOL_ME),
    saveKey: vi.fn(async (_provider: string, _key: string): Promise<void> => undefined),
    forgetKey: vi.fn(async (_provider: string) => undefined),
    keyStatus: vi.fn(async () => ({ enabled: true, hasKey: true, providers: ['openrouter'] })),
  };
  const r = await render(ModelAccessDialog, {
    providers: appProviders(api),
    setup: () => {
      learner(facts);
      TestBed.inject(UiStore).dialogs.open({ kind: 'access' });
    },
  });
  return { ...r, api, ui: TestBed.inject(UiStore), user: userEvent.setup() };
}

const radio = (name: RegExp) => screen.getByRole<HTMLInputElement>('radio', { name });
const OWN = /Use my own OpenRouter key/;
const CREDIT = /Use Tangent credit/;
const POOL = /Use the open pool/;

describe('How replies are paid for', () => {
  it('offers the own key, Tangent credit and the open pool, the pick checked', async () => {
    await open({
      billing: billing({ availableMicros: 1_200_000 }),
      pool: POOL_ON,
      chosen: 'credit',
    });
    screen.getByRole('dialog', { name: 'How replies are paid for' });
    expect(radio(CREDIT).checked).toBe(true);
    expect(radio(OWN).checked).toBe(false);
    expect(radio(OWN).closest('label')?.textContent).toContain(
      'Free here: you pay OpenRouter directly.',
    );
    expect(radio(CREDIT).closest('label')?.textContent).toContain(
      "Prepaid credit: each reply costs the model's OpenRouter price + 5.5% OpenRouter fee + 10%.",
    );
    expect(radio(POOL).closest('label')?.textContent).toMatch(
      /Free to you, within daily limits, on\s+Lite\./,
    );
    expect(screen.getByText(/\$1\.20 available/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add credit' }).getAttribute('href')).toBe('/billing');
  });

  it('the own key needs a membership where one is required: a non-member sees it disabled', async () => {
    await open({ membership: NOT_A_MEMBER, billing: billing({ availableMicros: 1_000_000 }) });
    expect(radio(OWN).disabled).toBe(true);
    const label = radio(OWN).closest('label')!;
    expect(label.textContent).toMatch(
      /Needs a membership \(\$10\/year\): covers Tangent while OpenRouter bills you\s+directly\./,
    );
    expect(screen.getByRole('link', { name: 'Become a member' }).getAttribute('href')).toBe(
      '/billing',
    );
    // Credit has no member conditions.
    expect(radio(CREDIT).disabled).toBe(false);
  });

  it("credit that can't pay and can't be bought can't be picked", async () => {
    await open({ billing: billing({ topUpsEnabled: false }) });
    expect(radio(CREDIT).disabled).toBe(true);
    expect(radio(CREDIT).closest('label')?.textContent).toContain(
      "No credit left, and top-ups aren't available right now.",
    );
  });

  it('picking credit with nothing left keeps credit picked, while replies use the pool', async () => {
    const d = await open({ billing: billing(), pool: POOL_ON, chosen: 'pool' });
    await d.user.click(radio(CREDIT));
    await d.fixture.whenStable();
    expect(radio(CREDIT).checked).toBe(true);
    expect(screen.getByRole('status').textContent).toContain(
      'Your credit is used up, so replies use the open pool until you add credit.',
    );
  });

  it('on the pool: its meter, today’s use, and how it works', async () => {
    const d = await open({ pool: POOL_ON, poolMe: POOL_ME, chosen: 'pool' });
    await d.fixture.whenStable();
    expect(radio(POOL).checked).toBe(true);
    screen.getByRole('group', { name: 'Open pool' });
    expect(screen.getByText(/3 of 30 replies used today/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'How the pool works' }).getAttribute('href')).toBe(
      '/pool',
    );
  });

  it('saves the own key, clearing the field before the request', async () => {
    const d = await open({ ownKey: false });
    expect(screen.getByText('not set')).toBeTruthy();
    const field = screen.getByLabelText<HTMLInputElement>('Your OpenRouter API key');
    await d.user.type(field, ' sk-or-1 ');
    d.api.saveKey.mockImplementationOnce(async () => expect(field.value).toBe(''));
    await d.user.click(screen.getByRole('button', { name: 'Save key' }));
    await vi.waitFor(() => expect(d.api.saveKey).toHaveBeenCalledWith('openrouter', 'sk-or-1'));
    await vi.waitFor(() =>
      expect(TestBed.inject(ToastStore).toasts()[0]?.text).toBe('Your OpenRouter key is saved'),
    );
  });

  it('opened by a message refused for want of the key, says it wasn’t sent', async () => {
    const d = await open({ ownKey: false });
    TestBed.inject(LessonStore).unsentDraft.set({
      treeId: 't1',
      branchId: 'trunk',
      text: 'Why?',
      needsKey: true,
    });
    await d.fixture.whenStable();
    expect(screen.getByRole('status').textContent).toContain('Your message wasn’t sent');
  });

  it("where the server can't store keys, says so", async () => {
    await open({ ownKey: null });
    expect(screen.getByText(/This server can't store your own key/)).toBeTruthy();
    expect(screen.queryByLabelText('Your OpenRouter API key')).toBeNull();
  });

  it('with only the own key on offer: no choice, just what it costs', async () => {
    await open({ membership: membership({ required: false }) });
    expect(screen.queryAllByRole('radio')).toEqual([]);
    expect(
      screen.getByText(
        /Replies run on your own OpenRouter key: you pay OpenRouter directly, and Tangent charges\s+nothing\./,
      ),
    ).toBeTruthy();
  });

  it('closes on Close', async () => {
    const d = await open();
    await d.user.click(screen.getByRole('button', { name: 'Close' }));
    expect(d.ui.dialogs.isOpen('access')).toBe(false);
  });
});
