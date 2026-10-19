import { chargeMicros } from '@tangent/shared';
import { renderOverheadBytes, utf8Bytes } from '@tangent/core';
import { describe, expect, it } from 'vitest';
import type { ModelPrice } from '../src/config.js';
import { ipKey, ipPrefix } from '../src/pool/ids.js';
import {
  ceilingHoldMicros,
  chargeFromTokensMicros,
  costFromTokensNanos,
  exceedsInputLimit,
  inputBoundTokens,
  maxInputMicrosPerMTok,
  poolInputLimitTokens,
  worstCaseHoldMicros,
} from '../src/pool/pricing.js';
import { meteredSettlement } from '../src/billing/settle-policy.js';

const FLASH: ModelPrice = {
  inMicrosPerMTok: 100_000,
  outMicrosPerMTok: 400_000,
  contextTokens: 131_072,
};
const msg = (content: string) => ({ role: 'user' as const, content });

describe('pool pricing', () => {
  it('bounds input tokens by UTF-8 bytes plus framing (ASCII and CJK)', () => {
    expect(utf8Bytes('hello')).toBe(5);
    expect(utf8Bytes('漢字')).toBe(6);
    // 5 + 3 bytes, 2 messages × 4, + 16
    expect(inputBoundTokens({ system: 'hello', messages: [msg('abc'), msg('')] })).toBe(
      5 + 3 + 8 + 16,
    );
    expect(inputBoundTokens({ system: null, messages: [msg('漢字漢字')] })).toBe(12 + 4 + 16);
  });

  it('counts per-reply instructions as a message of their own', () => {
    expect(inputBoundTokens({ system: null, messages: [], turnInstructions: 'abc' })).toBe(
      3 + 4 + 16,
    );
  });

  it('flags requests whose input bound exceeds the limit (refused, never clamped)', () => {
    expect(exceedsInputLimit(4096, { system: null, messages: [msg('x'.repeat(10_000))] })).toBe(
      true,
    );
    expect(exceedsInputLimit(4096, { system: null, messages: [msg('x'.repeat(4096 - 20))] })).toBe(
      false,
    );
    // CJK counts bytes: 1_400 characters are 4_200 bytes.
    expect(exceedsInputLimit(4096, { system: null, messages: [msg('漢'.repeat(1_400))] })).toBe(
      true,
    );
  });

  it("limits pool input to its budget in bytes plus what rendering adds, within the model's window", () => {
    // A budget of 16_000 "tokens" of 3.5 bytes: 56_000 bytes, plus headings, tags and framing.
    const limit = poolInputLimitTokens({ ...FLASH, contextTokens: 1_048_576 }, 16_000);
    expect(limit).toBeGreaterThan(56_000 + renderOverheadBytes(1));
    expect(limit).toBeLessThan(56_000 + 5_000);
    // A smaller window wins.
    expect(poolInputLimitTokens({ ...FLASH, contextTokens: 8_192 }, 16_000)).toBe(8_192);
  });

  it('rounds holds up and applies the fee, with no markup (the pool pays the true cost)', () => {
    // (37 × 0.1 + 100 × 0.4) µ$ = 43.7 → × 1.055 = 46.1035 → 47
    const request = { system: null, messages: [msg('x'.repeat(17))] };
    expect(inputBoundTokens(request)).toBe(37);
    expect(worstCaseHoldMicros(FLASH, request, 100, 550)).toBe(47);
    // A per-model fee wins over the default.
    expect(worstCaseHoldMicros({ ...FLASH, feeBps: 0 }, request, 100, 550)).toBe(44);
  });

  it('puts the ceiling hold above any exact hold the input limit admits', () => {
    const big = { ...FLASH, contextTokens: 1_048_576 };
    const limit = poolInputLimitTokens(big, 16_000);
    const ceiling = ceilingHoldMicros(big, 16_000, 1024, 550);
    // The pool's input limit in, not the window: (limit × 0.1 + 1024 × 0.4) µ$ × 1.055.
    expect(ceiling).toBe(Math.ceil((limit * 0.1 + 1024 * 0.4) * 1.055));
    expect(ceiling).toBeLessThan(10_000);
    for (const n of [0, 1, 1000, limit - 4 - 16 - 1]) {
      const request = { system: 's', messages: [msg('y'.repeat(n))] };
      expect(exceedsInputLimit(limit, request)).toBe(false);
      expect(worstCaseHoldMicros(big, request, 1024, 550)).toBeLessThanOrEqual(ceiling);
    }
    // On a window smaller than the limit, the window: (131_072 × 0.1 + 1024 × 0.4) µ$ × 1.055.
    expect(ceilingHoldMicros(FLASH, 1_000_000, 1024, 550)).toBe(14_261);
  });

  it('prices tokens in nano-USD, and charges them with the per-model fee and the row’s markup', () => {
    expect(costFromTokensNanos(FLASH, 1000, 500)).toBe(300_000); // 0.1 + 0.2 µ$… × 1000 tokens
    expect(costFromTokensNanos(FLASH, 1, 0)).toBe(100); // 0.1 µ$ = 100 n$
    expect(costFromTokensNanos({ ...FLASH, inMicrosPerMTok: 1 }, 1, 0)).toBe(1); // rounds up
    expect(chargeFromTokensMicros(FLASH, 1000, 500, 550, 500)).toBe(
      chargeMicros(300_000, 500, 550),
    );
    // A credit row: 300 µ$ × 1.055 × 1.05 = 332.325 → 333
    expect(chargeFromTokensMicros(FLASH, 1000, 500, 550, 500)).toBe(333);
    // A pool row, at cost: 300 µ$ × 1.055 = 316.5 → 317
    expect(chargeFromTokensMicros(FLASH, 1000, 500, 550, 0)).toBe(317);
    expect(chargeFromTokensMicros(FLASH, 1000, 500, 0, 0)).toBe(300);
  });

  it('holds at least what the call settles at', () => {
    for (const [inTok, outTok] of [
      [0, 1],
      [37, 100],
      [1000, 500],
      [131_072, 1024],
    ] as const) {
      const request = { system: null, messages: [msg('x'.repeat(Math.max(0, inTok - 20)))] };
      const bound = inputBoundTokens(request);
      for (const fee of [0, 550, 1000]) {
        const hold = worstCaseHoldMicros(FLASH, request, outTok, fee);
        const settle = chargeFromTokensMicros(FLASH, bound, outTok, fee, 0);
        expect(hold, `${inTok}/${outTok} at fee ${fee}`).toBeGreaterThanOrEqual(settle);
      }
    }
  });

  it('holds at least the settle where rounding the cost to nanos first adds a micro-dollar', () => {
    // 20 bound input tokens at 44_751 µ$/MTok, 1 output token at $1/MTok, a 5.5% fee:
    // 1_895_020 µ$/10⁶ × 1.055 = 1.9992 µ$ in one rounding, but the settle rounds
    // 1_895.02 n$ up to 1_896 first, and 1_896 × 1.055 = 2_000.28 n$ → 3 µ$.
    const price: ModelPrice = {
      inMicrosPerMTok: 44_751,
      outMicrosPerMTok: 1_000_000,
      contextTokens: 1000,
    };
    const request = { system: null, messages: [msg('')] };
    expect(inputBoundTokens(request)).toBe(20);
    const settle = chargeFromTokensMicros(price, 20, 1, 550, 0);
    expect(settle).toBe(3);
    expect(worstCaseHoldMicros(price, request, 1, 550)).toBeGreaterThanOrEqual(settle);
  });

  it('holds at least what the call settles at, over seeded random prices, sizes and fees', () => {
    let a = 20261018;
    /** A seeded PRNG (mulberry32), so a failing case reproduces. */
    const rand = (): number => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const int = (max: number): number => Math.floor(rand() ** 2 * (max + 1));
    for (let i = 0; i < 20_000; i++) {
      const inPrice = 1 + int(20_000_000);
      const price: ModelPrice = {
        inMicrosPerMTok: inPrice,
        outMicrosPerMTok: 1 + int(80_000_000),
        contextTokens: 1_000_000,
        ...(rand() < 0.5
          ? {
              cacheReadMicrosPerMTok: Math.ceil(inPrice / 10),
              cacheWriteMicrosPerMTok: Math.ceil(inPrice * 1.25),
            }
          : {}),
      };
      const bound = 20 + int(2000);
      const request = { system: null, messages: [msg('x'.repeat(bound - 20))] };
      const outTok = int(4000);
      const fee = int(1500);
      const hold = worstCaseHoldMicros(price, request, outTok, fee);
      // The settle's input is at most the bound, at its reported cache split or none.
      const inTok = bound - int(bound);
      const read = int(inTok);
      const caches = [
        {},
        { readTokens: read, writeTokens: int(inTok - read) },
        { readTokens: read },
      ];
      for (const cache of caches) {
        const settle = chargeFromTokensMicros(price, inTok, outTok, fee, 0, cache);
        const at = JSON.stringify({ price, bound, inTok, outTok, fee, cache });
        expect(hold, at).toBeGreaterThanOrEqual(settle);
      }
    }
  });
});

describe('pool pricing with prompt caching', () => {
  // Sonnet-like: $2 in, $10 out, reads 0.1×, writes 1.25×.
  const CACHED: ModelPrice = {
    inMicrosPerMTok: 2_000_000,
    outMicrosPerMTok: 10_000_000,
    contextTokens: 200_000,
    cacheReadMicrosPerMTok: 200_000,
    cacheWriteMicrosPerMTok: 2_500_000,
  };

  it('prices cache reads and writes at their own prices, the rest at the input price', () => {
    // n$ per token: read 200, write 2500, input 2000, output 10_000.
    // 1000 in = 600 read + 300 written + 100 uncached; 10 out:
    // 120_000 + 750_000 + 200_000 + 100_000 n$.
    expect(costFromTokensNanos(CACHED, 1000, 10, { readTokens: 600, writeTokens: 300 })).toBe(
      1_170_000,
    );
    // All read: 200_000 + 100_000 n$ (vs 2_100_000 uncached).
    expect(costFromTokensNanos(CACHED, 1000, 10, { readTokens: 1000, writeTokens: 0 })).toBe(
      300_000,
    );
    // Nothing cached: the plain input price.
    expect(costFromTokensNanos(CACHED, 1000, 10, { readTokens: 0, writeTokens: 0 })).toBe(
      2_100_000,
    );
  });

  it('never undercharges input whose cache share is unknown', () => {
    // No report: every input token at the write price (the most it can cost).
    expect(costFromTokensNanos(CACHED, 1000, 10)).toBe(2_600_000);
    // Reads without writes: the reads at the read price, the rest at the write price.
    expect(costFromTokensNanos(CACHED, 1000, 10, { readTokens: 600 })).toBe(
      120_000 + 1_000_000 + 100_000,
    );
    // Over-reported cache counts are clamped to the input total.
    expect(costFromTokensNanos(CACHED, 1000, 0, { readTokens: 5000, writeTokens: 5000 })).toBe(
      200_000,
    );
  });

  it('prices unset cache prices at the input price', () => {
    expect(maxInputMicrosPerMTok(FLASH)).toBe(100_000);
    expect(costFromTokensNanos(FLASH, 1000, 500, { readTokens: 800, writeTokens: 200 })).toBe(
      costFromTokensNanos(FLASH, 1000, 500),
    );
    expect(
      costFromTokensNanos({ ...FLASH, cacheReadMicrosPerMTok: 10_000 }, 1000, 0, {
        readTokens: 1000,
        writeTokens: 0,
      }),
    ).toBe(10_000);
  });

  it('holds input at the cache-write price, so a hold covers a call that writes it all', () => {
    expect(maxInputMicrosPerMTok(CACHED)).toBe(2_500_000);
    for (const inTok of [37, 1000, 50_000]) {
      const request = { system: null, messages: [msg('x'.repeat(Math.max(0, inTok - 20)))] };
      const bound = inputBoundTokens(request);
      for (const fee of [0, 550]) {
        const hold = worstCaseHoldMicros(CACHED, request, 100, fee);
        const allWritten = chargeMicros(
          costFromTokensNanos(CACHED, bound, 100, { readTokens: 0, writeTokens: bound }),
          0,
          fee,
        );
        expect(hold).toBeGreaterThanOrEqual(allWritten);
      }
    }
    // (200_000 × 2.5 + 1024 × 10) µ$
    expect(ceilingHoldMicros(CACHED, 1_000_000, 1024, 0)).toBe(510_240);
  });

  it('settles tokens with the reported cache share', () => {
    expect(
      meteredSettlement({
        dispatched: true,
        inputTokens: 1000,
        outputTokens: 10,
        cacheReadTokens: 600,
        cacheWriteTokens: 300,
        price: CACHED,
      }),
    ).toEqual({ reason: 'tokens', costNanos: 1_170_000 });
    expect(
      meteredSettlement({ dispatched: true, inputTokens: 1000, outputTokens: 10, price: CACHED }),
    ).toEqual({ reason: 'tokens', costNanos: 2_600_000 });
  });
});

describe('pricing above a long-context threshold', () => {
  // Haiku 5.5-like: $0.10 / $0.50 up to 100K input tokens, $0.50 / $2.50 above.
  const BASE = {
    inMicrosPerMTok: 100_000,
    outMicrosPerMTok: 500_000,
    cacheReadMicrosPerMTok: 10_000,
    cacheWriteMicrosPerMTok: 125_000,
  };
  const LONG = {
    inMicrosPerMTok: 500_000,
    outMicrosPerMTok: 2_500_000,
    cacheReadMicrosPerMTok: 50_000,
    cacheWriteMicrosPerMTok: 625_000,
  };
  const TIERED: ModelPrice = {
    ...BASE,
    contextTokens: 1_000_000,
    longContext: { aboveInputTokens: 100_000, ...LONG },
  };
  /** The same model priced flat at each tier's rates. */
  const FLAT_BASE: ModelPrice = { ...BASE, contextTokens: 1_000_000 };
  const FLAT_LONG: ModelPrice = { ...LONG, contextTokens: 1_000_000 };

  it('charges the whole call at the long rates once its input exceeds the threshold', () => {
    // 120_000 × $0.50 + 1000 × $2.50 per million: 62_500 µ$.
    expect(costFromTokensNanos(TIERED, 120_000, 1000, { readTokens: 0, writeTokens: 0 })).toBe(
      62_500_000,
    );
    expect(
      chargeFromTokensMicros(TIERED, 120_000, 1000, 0, 0, { readTokens: 0, writeTokens: 0 }),
    ).toBe(62_500);
    // Cache reads at the long read price: 100_000 × $0.05 + 20_000 × $0.50.
    expect(costFromTokensNanos(TIERED, 120_000, 0, { readTokens: 100_000, writeTokens: 0 })).toBe(
      15_000_000,
    );
    // Unknown cache share: the long write price, the most an input token can cost there.
    expect(costFromTokensNanos(TIERED, 120_000, 1000)).toBe(
      costFromTokensNanos(FLAT_LONG, 120_000, 1000),
    );
  });

  it('charges the base rates at or under the threshold', () => {
    // 90_000 × $0.10 + 1000 × $0.50 per million: 9_500 µ$.
    expect(costFromTokensNanos(TIERED, 90_000, 1000, { readTokens: 0, writeTokens: 0 })).toBe(
      9_500_000,
    );
    for (const input of [0, 90_000, 100_000]) {
      expect(costFromTokensNanos(TIERED, input, 1000)).toBe(
        costFromTokensNanos(FLAT_BASE, input, 1000),
      );
    }
    expect(costFromTokensNanos(TIERED, 100_001, 1000)).toBe(
      costFromTokensNanos(FLAT_LONG, 100_001, 1000),
    );
  });

  it('holds a request whose input bound exceeds the threshold at the long rates', () => {
    const long = { system: null, messages: [msg('x'.repeat(120_000))] };
    expect(inputBoundTokens(long)).toBeGreaterThan(100_000);
    expect(worstCaseHoldMicros(TIERED, long, 1000, 0)).toBe(
      worstCaseHoldMicros(FLAT_LONG, long, 1000, 0),
    );
    const short = { system: null, messages: [msg('x'.repeat(90_000))] };
    expect(worstCaseHoldMicros(TIERED, short, 1000, 0)).toBe(
      worstCaseHoldMicros(FLAT_BASE, short, 1000, 0),
    );
    // A ceiling whose input limit passes the threshold is at the long rates too.
    expect(ceilingHoldMicros(TIERED, 60_000, 1000, 0)).toBe(
      ceilingHoldMicros(FLAT_LONG, 60_000, 1000, 0),
    );
    expect(ceilingHoldMicros(TIERED, 16_000, 1000, 0)).toBe(
      ceilingHoldMicros(FLAT_BASE, 16_000, 1000, 0),
    );
  });

  it('settles tokens at the long rates above the threshold', () => {
    const facts = { dispatched: true, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(meteredSettlement({ ...facts, inputTokens: 120_000, price: TIERED })).toEqual({
      reason: 'tokens',
      costNanos: 62_500_000,
    });
    expect(meteredSettlement({ ...facts, inputTokens: 90_000, price: TIERED })).toEqual({
      reason: 'tokens',
      costNanos: 9_500_000,
    });
  });
});

describe('pool settle policy', () => {
  const price = { ...FLASH };
  it('releases what never left, or was refused upstream', () => {
    expect(meteredSettlement({ dispatched: false, costUsd: 1 })).toEqual({
      reason: 'released',
      costNanos: 0,
    });
    expect(meteredSettlement({ dispatched: true, upstream: 'not_sent' })).toEqual({
      reason: 'released',
      costNanos: 0,
    });
    expect(
      meteredSettlement({
        dispatched: true,
        upstream: 'rejected',
        inputTokens: 1,
        outputTokens: 1,
        price,
      }),
    ).toEqual({
      reason: 'released',
      costNanos: 0,
    });
  });

  it('charges reported cost, then a lookup, then tokens, then the hold', () => {
    expect(
      meteredSettlement({
        dispatched: true,
        upstream: 'stream',
        costUsd: 0.001,
        generationCostUsd: 0.002,
      }),
    ).toEqual({
      reason: 'cost',
      costNanos: 1_000_000,
    });
    expect(
      meteredSettlement({
        dispatched: true,
        generationCostUsd: 0.002,
        inputTokens: 1,
        outputTokens: 1,
        price,
      }),
    ).toEqual({
      reason: 'generation',
      costNanos: 2_000_000,
    });
    expect(
      meteredSettlement({ dispatched: true, inputTokens: 1000, outputTokens: 500, price }),
    ).toEqual({
      reason: 'tokens',
      costNanos: 300_000,
    });
    // One count alone (a stream cut short), or no price: the hold.
    expect(meteredSettlement({ dispatched: true, inputTokens: 1000, price })).toEqual({
      reason: 'hold',
      costNanos: null,
    });
    expect(meteredSettlement({ dispatched: true, inputTokens: 1, outputTokens: 1 })).toEqual({
      reason: 'hold',
      costNanos: null,
    });
    expect(meteredSettlement({ dispatched: true })).toEqual({ reason: 'hold', costNanos: null });
    // A call the user stopped with nothing reported: its input at the input price, no output.
    const stoppedAt = { dispatched: true, userStopped: true, heldInputTokens: 1000, price };
    expect(meteredSettlement(stoppedAt)).toEqual({
      reason: 'tokens',
      costNanos: costFromTokensNanos(price, 1000, 0, { readTokens: 0, writeTokens: 0 }),
    });
    expect(meteredSettlement({ ...stoppedAt, inputTokens: 10 })).toEqual({
      reason: 'tokens',
      costNanos: costFromTokensNanos(price, 10, 0, { readTokens: 0, writeTokens: 0 }),
    });
    expect(meteredSettlement({ ...stoppedAt, heldInputTokens: null })).toEqual({
      reason: 'hold',
      costNanos: null,
    });
    expect(meteredSettlement({ ...stoppedAt, userStopped: false })).toEqual({
      reason: 'hold',
      costNanos: null,
    });
  });

  it('adds searches at their fee to a tokens settlement, never to a reported cost', () => {
    const searched = { dispatched: true, webSearches: 2, searchFeeMicros: 10_000, price };
    expect(meteredSettlement({ ...searched, inputTokens: 1000, outputTokens: 500 })).toEqual({
      reason: 'tokens',
      costNanos: 300_000 + 20_000_000,
    });
    expect(meteredSettlement({ ...searched, userStopped: true, heldInputTokens: 1000 })).toEqual({
      reason: 'tokens',
      costNanos:
        costFromTokensNanos(price, 1000, 0, { readTokens: 0, writeTokens: 0 }) + 20_000_000,
    });
    // OpenRouter's reported cost (or its lookup) already holds the search fee.
    expect(meteredSettlement({ ...searched, costUsd: 0.001 })).toEqual({
      reason: 'cost',
      costNanos: 1_000_000,
    });
    expect(meteredSettlement({ ...searched, generationCostUsd: 0.002 })).toEqual({
      reason: 'generation',
      costNanos: 2_000_000,
    });
    // No fee (an endpoint whose cost reports it) or no search: the tokens alone.
    expect(
      meteredSettlement({ ...searched, searchFeeMicros: 0, inputTokens: 1000, outputTokens: 500 }),
    ).toEqual({ reason: 'tokens', costNanos: 300_000 });
    expect(
      meteredSettlement({ ...searched, webSearches: null, inputTokens: 1000, outputTokens: 500 }),
    ).toEqual({ reason: 'tokens', costNanos: 300_000 });
  });
});

describe('pool network keys', () => {
  it('keys IPv4 by address and IPv6 by /64', () => {
    expect(ipPrefix('203.0.113.7')).toBe('203.0.113.7');
    expect(ipPrefix('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(ipPrefix('2001:DB8:1:2::9')).toBe('2001:db8:1:2::/64');
    expect(ipPrefix('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipPrefix('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipPrefix('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(ipPrefix('not-an-ip')).toBe('not-an-ip');
  });

  it('hashes the network with the day: 16 hex chars, same /64 alike, rotating daily', async () => {
    const a = await ipKey('secret', '2026-10-05', '2001:db8:1:2::1');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await ipKey('secret', '2026-10-05', '2001:db8:1:2:ffff::9')).toBe(a);
    expect(await ipKey('secret', '2026-10-05', '2001:db8:1:3::1')).not.toBe(a);
    expect(await ipKey('secret', '2026-10-06', '2001:db8:1:2::1')).not.toBe(a);
    expect(await ipKey('other', '2026-10-05', '2001:db8:1:2::1')).not.toBe(a);
  });
});
