import { describe, expect, it, vi } from 'vitest';
import { coalesced } from './coalesced';

describe('coalesced', () => {
  function gated() {
    const gates: (() => void)[] = [];
    let runs = 0;
    const refresh = coalesced(async () => {
      runs++;
      await new Promise<void>((r) => gates.push(r));
    });
    return { refresh, gates, runs: () => runs };
  }

  it('runs once for calls while it is running, then once more', async () => {
    const g = gated();
    const calls = [g.refresh(), g.refresh(), g.refresh(), g.refresh(), g.refresh(), g.refresh()];
    expect(g.runs()).toBe(1);
    g.gates.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(g.runs()).toBe(2);
    g.gates.shift()?.();
    await Promise.all(calls);
    expect(g.runs()).toBe(2);
  });

  it('a call after the batch ends starts a new one', async () => {
    const g = gated();
    const first = g.refresh();
    g.gates.shift()?.();
    await first;
    const second = g.refresh();
    expect(g.runs()).toBe(2);
    g.gates.shift()?.();
    await second;
  });

  it('a run that hangs is left to itself after 20 s: later calls run again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(0);
      const g = gated();
      void g.refresh();
      vi.setSystemTime(19_000);
      void g.refresh();
      expect(g.runs()).toBe(1);
      // The first read never answers.
      vi.setSystemTime(21_000);
      const fresh = g.refresh();
      expect(g.runs()).toBe(2);
      // The new batch is the one later calls join, and it ends on its own.
      void g.refresh();
      expect(g.runs()).toBe(2);
      g.gates[1]?.();
      await vi.waitFor(() => expect(g.runs()).toBe(3));
      g.gates[2]?.();
      await fresh;
      // The hung run answering at last starts nothing more.
      g.gates[0]?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(g.runs()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a run that throws ends the batch; the next call starts afresh', async () => {
    let runs = 0;
    const refresh = coalesced(async () => {
      runs++;
      throw new Error('boom');
    });
    await expect(refresh()).rejects.toThrow('boom');
    await expect(refresh()).rejects.toThrow('boom');
    expect(runs).toBe(2);
  });
});
