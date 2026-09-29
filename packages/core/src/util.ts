/** Small runtime-agnostic helpers (Web Crypto `getRandomValues` only). */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Sortable-ish id: 10 chars of base36 time + 12 random chars. */
export function newId(now: number = Date.now()): string {
  const time = now.toString(36).padStart(10, '0');
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % 36];
  return time + rand;
}

/** Unguessable URL token: 24 random bytes (192 bits), base64url. */
export function newShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();
