import type {
  AdminCreditRequest,
  AdminCreditResponse,
  AdminPoolResponse,
  AdminUser,
  UpdateAdminUserRequest,
} from '@tangent/shared';
import { AuthService } from '@tangent/web-shared';
import { appProviders, me, render, T } from '@tangent/web-shared/testing';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { PoolPage } from './pool-page';
import { UsersPage } from './users-page';

const POOL: AdminPoolResponse = {
  enabled: true,
  accountId: 'pool',
  balanceMicros: 12_500_000,
  heldMicros: 500_000,
  pendingCalls: 2,
  availableMicros: 12_000_000,
  breaker: { overageMicros: 0, maxMicros: 5_000_000, windowMs: 86_400_000, tripped: false },
};

const ADA: AdminUser = {
  id: 'u1',
  email: 'ada@example.com',
  name: 'Ada',
  createdAt: T,
  shareAllowed: false,
  isAdmin: false,
  activeShares: 0,
  poolSuspended: false,
  creditBalanceMicros: 2_000_000,
  membershipWaived: false,
  membershipPaid: true,
};

function adminApi(pool: AdminPoolResponse = POOL) {
  return {
    adminPool: vi.fn(async () => pool),
    adminCredit: vi.fn(async (req: AdminCreditRequest): Promise<AdminCreditResponse> => ({
      credited: true,
      amountMicros: req.amountCents * 10_000,
      balanceMicros: 37_500_000,
    })),
    adminUsers: vi.fn(async () => ({ users: [ADA], nextCursor: null })),
    updateAdminUser: vi.fn(async (_id: string, req: UpdateAdminUserRequest) => ({
      ...ADA,
      ...req,
    })),
    adminStatus: vi.fn(async () => ({ dmcaAgentRegistered: false, membershipRequired: true })),
    adminPoolUsage: vi.fn(async (_days: number) => ({ since: T, rows: [], ipKeys: [] })),
  };
}

describe('Admin', () => {
  async function app(isAdmin: boolean) {
    await render(App, {
      providers: [
        ...appProviders(adminApi()),
        { provide: AuthService, useValue: { requireUser: async () => me({ isAdmin }) } },
      ],
    });
  }

  it('an admin gets the users, the open pool and who uses it', async () => {
    await app(true);
    await screen.findByRole('region', { name: 'Users' });
    await screen.findByRole('heading', { name: 'Open pool' });
    expect(screen.getByText(/DMCA_AGENT_REGISTERED is off:/)).toBeTruthy();
  });

  it('anyone else is told so, and sees nothing', async () => {
    await app(false);
    expect((await screen.findByRole('alert')).textContent).toBe('This account is not an admin.');
    expect(screen.queryByRole('region', { name: 'Users' })).toBeNull();
  });
});

describe('Admin: the open pool', () => {
  it('shows its balance, holds and the overage breaker', async () => {
    await render(PoolPage, { providers: appProviders(adminApi()) });
    const terms = await screen.findAllByRole('term');
    const facts = Object.fromEntries(
      terms.map((t) => [
        t.textContent,
        t.nextElementSibling?.textContent?.replace(/\s+/g, ' ').trim(),
      ]),
    );
    expect(facts).toMatchObject({
      Available: '$12.00',
      Balance: '$12.50',
      Held: '$0.50 (2 pending)',
      'Overage breaker': 'ok $0.00 of $5.00 in 24 h',
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('alerts while the breaker is tripped: the pool refuses every request', async () => {
    const tripped = {
      ...POOL,
      breaker: { ...POOL.breaker, overageMicros: 6_000_000, tripped: true },
    };
    await render(PoolPage, { providers: appProviders(adminApi(tripped)) });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Overage breaker tripped:');
    expect(alert.textContent).toContain('the pool refuses every request');
    expect(alert.textContent).toContain('$5.00 limit');
  });

  it('adjusts the pool by an amount, then shows the new balance', async () => {
    const api = adminApi();
    await render(PoolPage, { providers: appProviders(api) });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Amount ($, negative to debit)'), '25');
    await user.type(screen.getByLabelText('Note'), ' Seed ');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(api.adminCredit).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'pool',
        amountCents: 2500,
        mode: 'adjustment',
        note: 'Seed',
      }),
    );
    await vi.waitFor(() =>
      expect(screen.getByRole('status').textContent?.trim()).toBe(
        'Applied $25.00; pool balance $37.50.',
      ),
    );
    expect(api.adminPool).toHaveBeenCalledTimes(2);
  });

  it('refuses what the server would, before sending it', async () => {
    const api = adminApi();
    await render(PoolPage, { providers: appProviders(api) });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Amount ($, negative to debit)'), '501');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('alert').textContent).toBe('At most $500 at a time.');
    expect(api.adminCredit).not.toHaveBeenCalled();
  });
});

describe('Admin: users', () => {
  const confirm = vi.fn(() => true);
  beforeEach(() => vi.stubGlobal('confirm', confirm.mockReset().mockReturnValue(true)));
  afterEach(() => vi.unstubAllGlobals());

  async function users() {
    const api = adminApi();
    await render(UsersPage, { providers: appProviders(api) });
    const row = (await screen.findByText('ada@example.com')).closest('tr')!;
    return { api, row, user: userEvent.setup() };
  }

  it("shows each user's credit, and a form to credit their own ledger", async () => {
    const u = await users();
    expect(u.row.textContent).toContain('$2.00');
    within(u.row).getByText('paid');
    const toggle = within(u.row).getByRole('button', { name: 'Credit' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await u.user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await u.user.type(screen.getByLabelText('Amount ($, negative to debit)'), '10.25');
    await u.user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(u.api.adminCredit).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'personal', userId: 'u1', amountCents: 1025 }),
    );
    await vi.waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Applied $10.25; balance $37.50.'),
    );
  });

  it('waives the membership per user', async () => {
    const u = await users();
    await u.user.click(
      screen.getByRole('checkbox', { name: "ada@example.com's membership is waived" }),
    );
    await vi.waitFor(() =>
      expect(u.api.updateAdminUser).toHaveBeenCalledWith('u1', { membershipWaived: true }),
    );
  });
});
