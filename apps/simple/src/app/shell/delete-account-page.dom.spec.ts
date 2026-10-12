import { TestBed } from '@angular/core/testing';
import { appProviders, render } from '@tangent/web-shared/testing';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { routes } from '../app.routes';
import { learner } from '../learn.testing';
import { AccountStore } from '../state/account-store';
import { DeleteAccountPage } from './delete-account-page';

describe('Delete account page', () => {
  it('is the `delete-account` route, the target of the short /delete-account link', () => {
    expect(routes.find((r) => r.path === 'delete-account')?.component).toBe(DeleteAccountPage);
  });

  it('asks the signed-in learner to type their email, then deletes the account', async () => {
    const deleteAccount = vi.fn(async (_email: string): Promise<void> => {
      throw new Error('stopped before leaving the page');
    });
    await render(DeleteAccountPage, {
      providers: appProviders({ deleteAccount }),
      setup: () => {
        learner();
      },
    });
    screen.getByRole('heading', { name: 'Delete account' });
    expect(screen.getByRole('link', { name: /Back to your lessons/ }).getAttribute('href')).toBe(
      '/',
    );
    const confirm = screen.getByRole('textbox', { name: /a@example\.com/ });
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: /Delete my account/ });
    expect(submit.disabled).toBe(true);
    const user = userEvent.setup();
    await user.type(confirm, 'a@example.com');
    await user.click(submit);
    expect(deleteAccount).toHaveBeenCalledWith('a@example.com');
  });

  it('says there is no account when sign-in is disabled', async () => {
    await render(DeleteAccountPage, {
      providers: appProviders({}),
      setup: () => {
        learner();
        const me = TestBed.inject(AccountStore).me();
        if (me) TestBed.inject(AccountStore).me.set({ ...me, email: null });
      },
    });
    screen.getByText(/no account to delete/);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
