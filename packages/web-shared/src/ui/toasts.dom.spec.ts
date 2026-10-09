import { TestBed } from '@angular/core/testing';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { provideAnyRoute, render } from '../testing';
import { Toasts, ToastStore } from './toasts';

async function toasts() {
  const r = await render(Toasts, { providers: [provideAnyRoute()] });
  return { ...r, store: TestBed.inject(ToastStore), user: userEvent.setup() };
}

describe('Toasts', () => {
  it('announces each toast politely, with a Dismiss button that removes it', async () => {
    const t = await toasts();
    t.store.notify('Copied to clipboard');
    t.store.notify('Something broke', 'error');
    await t.fixture.whenStable();
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(within(region).getByText('Copied to clipboard')).toBeTruthy();
    const dismiss = within(region).getAllByRole('button', { name: 'Dismiss' });
    expect(dismiss).toHaveLength(2);
    await t.user.click(dismiss[0]!);
    await t.fixture.whenStable();
    expect(screen.queryByText('Copied to clipboard')).toBeNull();
    expect(screen.getByText('Something broke')).toBeTruthy();
  });

  it("links to an app route or a page, and following the app's link dismisses the toast", async () => {
    const t = await toasts();
    t.store.notify('Out of credit', 'error', { label: 'Add credit', path: '/billing' });
    t.store.notify('Shared', 'info', { label: 'Open', href: 'https://tangent.example/s/x' });
    await t.fixture.whenStable();
    const add = screen.getByRole('link', { name: 'Add credit' });
    expect(add.getAttribute('href')).toBe('/billing');
    expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(
      'https://tangent.example/s/x',
    );
    await t.user.click(add);
    await t.fixture.whenStable();
    expect(screen.queryByText('Out of credit')).toBeNull();
  });
});
