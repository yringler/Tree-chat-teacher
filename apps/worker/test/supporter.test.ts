import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/env.js';
import { isSupporter, windowStart } from '../src/pool/supporter.js';
import { uniq } from './mocks/billing-helpers.js';

const env = rawEnv as unknown as AppEnv;
const NOW = new Date('2026-10-05T12:00:00.000Z');

interface GrantRow {
  accountId: string;
  kind: 'purchase' | 'refund' | 'adjustment' | 'subscription';
  amountMicros: number;
  grossMicros?: number | null;
  userId?: string | null;
  createdAt?: string;
}

async function grant(row: GrantRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO credit_grants (id, account_id, kind, amount_micros, gross_micros, user_id, provider_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      uniq('grant'),
      row.accountId,
      row.kind,
      row.amountMicros,
      row.grossMicros ?? null,
      row.userId ?? null,
      uniq('ref'),
      row.createdAt ?? '2026-09-01T00:00:00.000Z',
    )
    .run();
}

describe('isSupporter', () => {
  it('is false without purchases; admin adjustments and membership credit never count', async () => {
    const userId = uniq('user');
    expect(await isSupporter(env.DB, userId, NOW, null)).toBe(false);
    await grant({ accountId: `u_${userId}`, kind: 'adjustment', amountMicros: 5_000_000, userId });
    await grant({ accountId: `u_${userId}`, kind: 'subscription', amountMicros: 2_000_000 });
    expect(await isSupporter(env.DB, userId, NOW, null)).toBe(false);
  });

  it('counts pool and personal purchases by user id, and legacy personal ones by ledger id', async () => {
    const pool = uniq('user');
    await grant({
      accountId: 'pool-x',
      kind: 'purchase',
      amountMicros: 9_259_259,
      grossMicros: 10_000_000,
      userId: pool,
    });
    expect(await isSupporter(env.DB, pool, NOW, null)).toBe(true);

    const legacy = uniq('user');
    await grant({
      accountId: `u_${legacy}`,
      kind: 'purchase',
      amountMicros: 4_500_000,
      grossMicros: 5_000_000,
    });
    expect(await isSupporter(env.DB, legacy, NOW, null)).toBe(true);
  });

  it('nets refunds and disputes against purchases (gross, or the legacy refund amount)', async () => {
    const userId = uniq('user');
    await grant({
      accountId: 'pool-x',
      kind: 'purchase',
      amountMicros: 9_259_259,
      grossMicros: 10_000_000,
      userId,
    });
    // A partial refund leaves the user a supporter.
    await grant({
      accountId: 'pool-x',
      kind: 'refund',
      amountMicros: -4_629_629,
      grossMicros: -5_000_000,
      userId,
    });
    expect(await isSupporter(env.DB, userId, NOW, null)).toBe(true);
    // The rest, clamped to 0 credit because the pool was drained: the gross still nets to 0.
    await grant({
      accountId: 'pool-x',
      kind: 'refund',
      amountMicros: 0,
      grossMicros: -5_000_000,
      userId,
    });
    expect(await isSupporter(env.DB, userId, NOW, null)).toBe(false);

    const legacy = uniq('user');
    await grant({
      accountId: `u_${legacy}`,
      kind: 'purchase',
      amountMicros: 4_500_000,
      grossMicros: 5_000_000,
    });
    await grant({ accountId: `u_${legacy}`, kind: 'refund', amountMicros: -5_000_000 });
    expect(await isSupporter(env.DB, legacy, NOW, null)).toBe(false);
  });

  it('a full refund in rounded parts leaves no supporter behind', async () => {
    const userId = uniq('user');
    await grant({
      accountId: `u_${userId}`,
      kind: 'purchase',
      amountMicros: 10_000_000,
      grossMicros: 10_000_000,
      userId,
    });
    // $10.83 with tax refunded as three $3.61 refunds: each pre-tax share rounds to 3_333_333.
    for (let i = 0; i < 3; i++) {
      await grant({
        accountId: `u_${userId}`,
        kind: 'refund',
        amountMicros: -3_333_333,
        grossMicros: -3_333_333,
        userId,
      });
    }
    expect(await isSupporter(env.DB, userId, NOW, null)).toBe(false);
  });

  it('is lifetime by default; with SUPPORTER_WINDOW_MONTHS the latest purchase must be recent', async () => {
    const userId = uniq('user');
    await grant({
      accountId: 'pool-x',
      kind: 'purchase',
      amountMicros: 4_629_629,
      grossMicros: 5_000_000,
      userId,
      createdAt: '2025-09-01T00:00:00.000Z',
    });
    expect(await isSupporter(env.DB, userId, NOW, null)).toBe(true);
    expect(await isSupporter(env.DB, userId, NOW, 12)).toBe(false);
    expect(await isSupporter(env.DB, userId, NOW, 14)).toBe(true);
    // A newer purchase renews the window.
    await grant({
      accountId: `u_${userId}`,
      kind: 'purchase',
      amountMicros: 4_500_000,
      grossMicros: 5_000_000,
      userId,
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    expect(await isSupporter(env.DB, userId, NOW, 12)).toBe(true);
  });

  it('measures the window in calendar months (UTC)', () => {
    expect(windowStart(NOW, 12).toISOString()).toBe('2025-10-05T12:00:00.000Z');
    expect(windowStart(NOW, 1).toISOString()).toBe('2026-09-05T12:00:00.000Z');
  });
});
