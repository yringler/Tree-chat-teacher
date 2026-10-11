import type {
  AdminCreditRequest,
  AdminCreditResponse,
  AdminHold,
  AdminHoldReportRequest,
  AdminPoolResponse,
  AdminReport,
  AdminResolveReportRequest,
  AdminShare,
  AdminStatusResponse,
  AdminUser,
  AdminWaitlistInviteRequest,
  AdminWaitlistResponse,
  UpdateAdminUserRequest,
} from '@tangent/shared';
import { AuthService } from '@tangent/web-shared';
import { appProviders, me, render, T } from '@tangent/web-shared/testing';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { HoldsPage } from './holds-page';
import { PoolPage } from './pool-page';
import { ReportsPage } from './reports-page';
import { UsersPage } from './users-page';
import { WaitlistPage } from './waitlist-page';

const POOL: AdminPoolResponse = {
  enabled: true,
  accountId: 'pool',
  balanceMicros: 12_500_000,
  heldMicros: 500_000,
  pendingCalls: 2,
  availableMicros: 12_000_000,
  breaker: { overageMicros: 0, maxMicros: 5_000_000, windowMs: 86_400_000, tripped: false },
};

const WAITLIST: AdminWaitlistResponse = {
  entries: [
    { email: 'early@example.com', createdAt: T, invitedAt: T },
    { email: 'next@example.com', createdAt: T, invitedAt: null },
    { email: 'later@example.com', createdAt: T, invitedAt: null },
  ],
  total: 3,
  users: 19,
  maxUsers: 20,
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
  sharingSuspended: false,
  removedShares: 0,
  openReports: 0,
};

const REPORT: AdminReport = {
  id: 'r1',
  shareId: 's1',
  shareToken: 'tok',
  ownerUserId: 'u1',
  ownerEmail: 'ada@example.com',
  category: 'copyright',
  details: 'Chapter one of my book',
  reporterEmail: 'author@example.com',
  createdAt: T,
  resolution: 'pending',
  resolvedAt: null,
  resolvedBy: null,
  notes: null,
  shareState: 'pending_review',
  shareReporters: 1,
  held: false,
};

const HOLD: AdminHold = {
  id: 'h1',
  reason: 'csam',
  reportId: 'r1',
  shareId: 's1',
  subjectUserId: 'u1',
  subjectEmail: 'ada@example.com',
  createdAt: T,
  createdBy: null,
  releasedAt: null,
  releasedBy: null,
  notes: null,
  externalReports: [],
};

const SHARE: AdminShare = {
  id: 's1',
  token: 'tok',
  accountId: 'u_u1',
  treeId: 't1',
  scope: 'tree',
  targetNodeId: null,
  includeAncestors: false,
  title: 'Shared',
  expiresAt: null,
  revokedAt: null,
  createdAt: T,
  updatedAt: T,
  publishedAt: T,
  version: 1,
  viewCount: 3,
  treeTitle: 'Tree',
  url: 'https://tangent.example.com/s/tok',
  state: 'unavailable',
  takedown: 'pending_review',
};

const STATUS: AdminStatusResponse = {
  sharing: 'allowlist',
  membershipRequired: true,
  moderationKeyMissing: false,
};

function adminApi(pool: AdminPoolResponse = POOL, status: AdminStatusResponse = STATUS) {
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
    adminStatus: vi.fn(async () => status),
    adminReports: vi.fn(async (_status?: string, _cursor?: string | null) => ({
      reports: [REPORT],
      nextCursor: null,
    })),
    adminResolveReport: vi.fn(async (_id: string, req: AdminResolveReportRequest) => ({
      ...REPORT,
      resolution: req.action === 'remove' ? ('actioned' as const) : ('rejected' as const),
    })),
    adminPlaceHold: vi.fn(async () => HOLD),
    adminHolds: vi.fn(async () => ({ holds: [HOLD] })),
    adminReportHold: vi.fn(async (_id: string, req: AdminHoldReportRequest) => ({
      ...HOLD,
      externalReports: [{ ...req, at: T }],
    })),
    adminReleaseHold: vi.fn(async () => ({ ...HOLD, releasedAt: T, releasedBy: 'a1' })),
    adminUserShares: vi.fn(async () => [SHARE]),
    adminRemoveShare: vi.fn(async () => ({ ...SHARE, takedown: 'removed' as const })),
    adminRestoreShare: vi.fn(async () => ({ ...SHARE, state: 'active' as const, takedown: null })),
    adminPoolUsage: vi.fn(async (_days: number) => ({ since: T, rows: [], ipKeys: [] })),
    adminWaitlist: vi.fn(async () => WAITLIST),
    adminWaitlistInvite: vi.fn(async (req: AdminWaitlistInviteRequest) => ({
      invited: req.emails.length,
    })),
  };
}

describe('Admin', () => {
  async function app(isAdmin: boolean, status: AdminStatusResponse = STATUS) {
    await render(App, {
      providers: [
        ...appProviders(adminApi(POOL, status)),
        { provide: AuthService, useValue: { requireUser: async () => me({ isAdmin }) } },
      ],
    });
  }

  it('an admin gets the users, the open pool and who uses it', async () => {
    await app(true);
    await screen.findByRole('region', { name: 'Users' });
    await screen.findByRole('heading', { name: 'Open pool' });
    await screen.findByRole('region', { name: 'Reports' });
    await screen.findByRole('region', { name: 'Legal holds' });
    expect(screen.getByText(/SHARING is allowlist:/)).toBeTruthy();
    expect(screen.queryByText(/MODERATION_API_KEY is not set/)).toBeNull();
  });

  it('explains why SHARING=everyone acts as the allowlist without the moderation key', async () => {
    await app(true, { ...STATUS, moderationKeyMissing: true });
    await screen.findByRole('region', { name: 'Users' });
    expect(screen.getByText(/MODERATION_API_KEY is not set:/)).toBeTruthy();
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

  it("suspends a user's sharing", async () => {
    const u = await users();
    await u.user.click(
      screen.getByRole('checkbox', { name: "ada@example.com's sharing is suspended" }),
    );
    await vi.waitFor(() =>
      expect(u.api.updateAdminUser).toHaveBeenCalledWith('u1', { sharingSuspended: true }),
    );
  });

  it('removes and restores a share, then refreshes the counts', async () => {
    const u = await users();
    await u.user.click(within(u.row).getByRole('button', { name: 'Shares' }));
    const item = (await screen.findByText('Shared')).closest('li')!;
    expect(item.textContent).toContain('pending review');
    expect(
      within(item)
        .getByRole('link', { name: /Review/ })
        .getAttribute('href'),
    ).toBe('/admin/review/s1');
    await u.user.click(within(item).getByRole('button', { name: /Remove/ }));
    await vi.waitFor(() => expect(u.api.adminRemoveShare).toHaveBeenCalledWith('s1'));
    await vi.waitFor(() =>
      expect(within(item).queryByRole('button', { name: /Remove/ })).toBeNull(),
    );
    expect(u.api.adminUsers).toHaveBeenLastCalledWith('ada@example.com');
    await u.user.click(within(item).getByRole('button', { name: 'Restore' }));
    await vi.waitFor(() => expect(u.api.adminRestoreShare).toHaveBeenCalledWith('s1'));
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

describe('Admin: the waitlist', () => {
  it('invites the oldest not yet invited, as many as there are free places', async () => {
    const api = adminApi();
    await render(WaitlistPage, { providers: appProviders(api) });
    await screen.findByRole('region', { name: 'Waitlist' });
    expect(screen.getByText('19 of 20 (MAX_USERS)')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Invite the next 1' }));
    expect(api.adminWaitlistInvite).toHaveBeenCalledExactlyOnceWith({
      emails: ['next@example.com'],
    });
    expect((await screen.findByRole('status')).textContent).toContain('Invited 1.');
  });
});

describe('Admin: reports', () => {
  const confirm = vi.fn(() => true);
  beforeEach(() => vi.stubGlobal('confirm', confirm.mockReset().mockReturnValue(true)));
  afterEach(() => vi.unstubAllGlobals());

  async function reports() {
    const api = adminApi();
    await render(ReportsPage, { providers: appProviders(api) });
    const row = (await screen.findByText('Chapter one of my book')).closest('tr')!;
    return { api, row, user: userEvent.setup() };
  }

  it('lists the queue with the report, where the share stands, and a review link', async () => {
    const r = await reports();
    expect(r.api.adminReports).toHaveBeenCalledWith('pending', null);
    expect(r.row.textContent).toContain('Copyright');
    expect(r.row.textContent).toContain('pending review');
    expect(r.row.textContent).toContain('From author@example.com');
    const review = within(r.row).getByRole('link', { name: /Review/ });
    expect(review.getAttribute('href')).toBe('/admin/review/s1');
    expect(review.getAttribute('target')).toBe('_blank');
  });

  it('removes with notes after asking, then reloads the queue', async () => {
    const r = await reports();
    await r.user.type(within(r.row).getByLabelText('Notes'), ' Whole chapter ');
    await r.user.click(within(r.row).getByRole('button', { name: 'Remove' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('strike'));
    await vi.waitFor(() =>
      expect(r.api.adminResolveReport).toHaveBeenCalledWith('r1', {
        action: 'remove',
        notes: 'Whole chapter',
      }),
    );
    await vi.waitFor(() => expect(r.api.adminReports).toHaveBeenCalledTimes(2));
  });

  it('does nothing when the admin cancels', async () => {
    const r = await reports();
    confirm.mockReturnValue(false);
    await r.user.click(within(r.row).getByRole('button', { name: 'Reject' }));
    expect(r.api.adminResolveReport).not.toHaveBeenCalled();
  });

  it('shows every report on request, and holds one the report page did not', async () => {
    const r = await reports();
    await r.user.selectOptions(screen.getByLabelText('Show'), 'all');
    expect(r.api.adminReports).toHaveBeenLastCalledWith('all', null);
    const row = (await screen.findByText('Chapter one of my book')).closest('tr')!;
    await r.user.click(within(row).getByRole('button', { name: 'Hold' }));
    await vi.waitFor(() =>
      expect(r.api.adminPlaceHold).toHaveBeenCalledWith('s1', { reason: 'other' }),
    );
    await vi.waitFor(() => expect(within(row).getByText('held')).toBeTruthy());
  });
});

describe('Admin: legal holds', () => {
  const confirm = vi.fn(() => true);
  beforeEach(() => vi.stubGlobal('confirm', confirm.mockReset().mockReturnValue(true)));
  afterEach(() => vi.unstubAllGlobals());

  async function holds() {
    const api = adminApi();
    await render(HoldsPage, { providers: appProviders(api) });
    const row = (await screen.findByText('Child sexual abuse material')).closest('tr')!;
    return { api, row, user: userEvent.setup() };
  }

  it('records a report filed with NCMEC', async () => {
    const h = await holds();
    expect(
      within(h.row)
        .getByRole('link', { name: /Review/ })
        .getAttribute('href'),
    ).toBe('/admin/review/s1');
    await h.user.type(within(h.row).getByLabelText('Report number'), 'CT-42');
    await h.user.click(within(h.row).getByRole('button', { name: 'Record' }));
    await vi.waitFor(() =>
      expect(h.api.adminReportHold).toHaveBeenCalledWith('h1', {
        kind: 'ncmec',
        reference: 'CT-42',
      }),
    );
    await vi.waitFor(() => expect(h.row.textContent).toContain('CT-42'));
  });

  it('refuses an empty report number, and releases after asking', async () => {
    const h = await holds();
    await h.user.click(within(h.row).getByRole('button', { name: 'Record' }));
    expect(screen.getByRole('alert').textContent).toBe('Enter the report number you were given.');
    expect(h.api.adminReportHold).not.toHaveBeenCalled();
    await h.user.click(within(h.row).getByRole('button', { name: 'Release' }));
    await vi.waitFor(() => expect(h.api.adminReleaseHold).toHaveBeenCalledWith('h1'));
    await vi.waitFor(() => expect(h.row.textContent).toContain('released'));
  });
});
