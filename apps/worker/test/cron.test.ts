// The Worker's cron dispatch (src/cron.ts): each schedule runs only its own jobs.
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { CRON_DAILY, CRON_FREQUENT, cronTasks, type CronJobs } from '../src/cron.js';
import type { AppEnv } from '../src/env.js';

const env = rawEnv as unknown as AppEnv;

function spies() {
  return {
    reconcile: vi.fn(() => Promise.resolve()),
    poolExpiry: vi.fn(() => Promise.resolve()),
    paymentDisputes: vi.fn(() => Promise.resolve()),
    poolRevenueShare: vi.fn(() => Promise.resolve()),
    priceSync: vi.fn(() => Promise.resolve()),
  } satisfies CronJobs;
}

describe('cron dispatch', () => {
  it('runs each schedule’s own jobs only, and logs an unknown one', async () => {
    const now = new Date();
    const frequent = spies();
    await Promise.all(cronTasks(CRON_FREQUENT, env, now, frequent));
    expect(frequent.reconcile).toHaveBeenCalledOnce();
    expect(frequent.poolExpiry).toHaveBeenCalledWith(env, now);
    expect(frequent.paymentDisputes).toHaveBeenCalledWith(env, now);
    expect(frequent.poolRevenueShare).toHaveBeenCalledWith(env, now);
    expect(frequent.priceSync).not.toHaveBeenCalled();

    const daily = spies();
    await Promise.all(cronTasks(CRON_DAILY, env, now, daily));
    expect(daily.priceSync).toHaveBeenCalledWith(env, now);
    expect(daily.reconcile).not.toHaveBeenCalled();
    expect(daily.poolExpiry).not.toHaveBeenCalled();
    expect(daily.paymentDisputes).not.toHaveBeenCalled();

    // A failed sync is logged, not thrown into the scheduled handler.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = spies();
    failing.priceSync.mockImplementation(() => Promise.reject(new Error('down')));
    await expect(Promise.all(cronTasks(CRON_DAILY, env, now, failing))).resolves.toBeDefined();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('price sync failed'),
      expect.any(Error),
    );
    error.mockRestore();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unknown = spies();
    expect(cronTasks('0 0 * * *', env, now, unknown)).toEqual([]);
    expect(Object.values(unknown).every((f) => f.mock.calls.length === 0)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cron_unknown'));
    warn.mockRestore();
  });
});
