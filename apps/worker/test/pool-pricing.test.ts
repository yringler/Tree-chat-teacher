import { describe, expect, it } from 'vitest';
import { chargeMicros } from '../src/billing/pricing.js';
import type { ModelPrice } from '../src/config.js';
import { ipKey, ipPrefix } from '../src/pool/ids.js';
import {
  ceilingHoldMicros,
  chargeFromTokensMicros,
  costFromTokensNanos,
  exceedsContext,
  inputBoundTokens,
  poolCreditMicros,
  utf8Bytes,
  worstCaseHoldMicros,
} from '../src/pool/pricing.js';
import { poolSettlement } from '../src/pool/settle-policy.js';

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

  it('flags requests whose input bound exceeds the context window (refused, never clamped)', () => {
    const small = { ...FLASH, contextTokens: 4096 };
    expect(exceedsContext(small, { system: null, messages: [msg('x'.repeat(10_000))] })).toBe(true);
    expect(exceedsContext(small, { system: null, messages: [msg('x'.repeat(4096 - 20))] })).toBe(
      false,
    );
    // CJK counts bytes: 1_400 characters are 4_200 bytes.
    expect(exceedsContext(small, { system: null, messages: [msg('漢'.repeat(1_400))] })).toBe(true);
  });

  it('rounds holds up and applies the fee', () => {
    // (37 × 0.1 + 100 × 0.4) µ$ = 43.7 → × 1.055 = 46.1035 → 47
    const request = { system: null, messages: [msg('x'.repeat(17))] };
    expect(inputBoundTokens(request)).toBe(37);
    expect(worstCaseHoldMicros(FLASH, request, 100, 550)).toBe(47);
    // A per-model fee wins over the default.
    expect(worstCaseHoldMicros({ ...FLASH, feeBps: 0 }, request, 100, 550)).toBe(44);
  });

  it('puts the ceiling hold above any exact hold of the same model and output cap', () => {
    const ceiling = ceilingHoldMicros(FLASH, 1024, 550);
    // About $0.014 on the flash model (the cost documented on /pool).
    expect(ceiling).toBe(Math.ceil(((131_072 * 100_000 + 1024 * 400_000) / 1e6) * 1.055));
    for (const n of [0, 1, 1000, 200_000]) {
      const exact = worstCaseHoldMicros(
        FLASH,
        { system: 's', messages: [msg('y'.repeat(n))] },
        1024,
        550,
      );
      expect(exact).toBeLessThanOrEqual(ceiling);
    }
  });

  it('prices tokens in nano-USD, and charges them with the per-model fee and no markup', () => {
    expect(costFromTokensNanos(FLASH, 1000, 500)).toBe(300_000); // 0.1 + 0.2 µ$… × 1000 tokens
    expect(costFromTokensNanos(FLASH, 1, 0)).toBe(100); // 0.1 µ$ = 100 n$
    expect(costFromTokensNanos({ ...FLASH, inMicrosPerMTok: 1 }, 1, 0)).toBe(1); // rounds up
    expect(chargeFromTokensMicros(FLASH, 1000, 500, 550)).toBe(chargeMicros(300_000, 0, 550));
    expect(chargeFromTokensMicros(FLASH, 1000, 500, 0)).toBe(300);
  });

  it('takes the margin at purchase: $10 at 8% buys $9.259259', () => {
    expect(poolCreditMicros(10_000_000, 800)).toBe(9_259_259);
    expect(poolCreditMicros(10_000_000, 0)).toBe(10_000_000);
    expect(poolCreditMicros(0, 800)).toBe(0);
  });
});

describe('pool settle policy', () => {
  const price = { ...FLASH };
  it('releases what never left, or was refused upstream', () => {
    expect(poolSettlement({ dispatched: false, costUsd: 1 })).toEqual({
      reason: 'released',
      costNanos: 0,
    });
    expect(poolSettlement({ dispatched: true, upstream: 'not_sent' })).toEqual({
      reason: 'released',
      costNanos: 0,
    });
    expect(
      poolSettlement({
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
      poolSettlement({
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
      poolSettlement({
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
      poolSettlement({ dispatched: true, inputTokens: 1000, outputTokens: 500, price }),
    ).toEqual({
      reason: 'tokens',
      costNanos: 300_000,
    });
    // One count alone (a stream cut short), or no price: the hold.
    expect(poolSettlement({ dispatched: true, inputTokens: 1000, price })).toEqual({
      reason: 'hold',
      costNanos: null,
    });
    expect(poolSettlement({ dispatched: true, inputTokens: 1, outputTokens: 1 })).toEqual({
      reason: 'hold',
      costNanos: null,
    });
    expect(poolSettlement({ dispatched: true })).toEqual({ reason: 'hold', costNanos: null });
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
