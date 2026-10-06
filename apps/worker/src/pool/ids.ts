// Identifiers of the open pool: its PoolBank instance, and the keyed,
// daily-rotating hash that stands in for a caller's network on pool rows.
import type { AppEnv } from '../env.js';
import type { PoolBank } from './pool-bank.js';

/** The PoolBank Durable Object of `poolId` (one instance per pool account id). */
export function poolBank(env: AppEnv, poolId: string): DurableObjectStub<PoolBank> {
  return env.POOL_BANK.get(env.POOL_BANK.idFromName(poolId));
}

/** `YYYY-MM-DD` of `now` in UTC. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Expands an IPv6 address to its 8 groups; null when it isn't one. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const b = v4.slice(1).map(Number);
    if (b.some((n) => n > 255)) return null;
    text = `${text.slice(0, v4.index)}${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * The network a pool caller is limited by: the IPv4 address itself, or the
 * /64 of an IPv6 address (one subscriber usually holds a whole /64). An
 * IPv4-mapped IPv6 address counts as its IPv4 address. Anything unparseable
 * is used as is.
 */
export function ipPrefix(ip: string): string {
  const s = ip.trim();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return s;
  const groups = ipv6Groups(s);
  if (!groups) return s.toLowerCase();
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (mapped)
    return [groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8, groups[7]! & 255].join('.');
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

/**
 * `ip_key` of pool rows: HMAC-SHA256(secret, `<UTC day>:<network>`), first 16
 * hex characters. It rotates daily, so it cannot link a network across days,
 * and it stores no address.
 */
export async function ipKey(secret: string, day: string, ip: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, enc.encode(`${day}:${ipPrefix(ip)}`)),
  );
  return Array.from(mac.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}
