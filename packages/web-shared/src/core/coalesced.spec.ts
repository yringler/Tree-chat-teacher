import { describe, expect, it } from 'vitest';
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
