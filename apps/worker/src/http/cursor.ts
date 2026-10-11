import { ValidationError } from '@tangent/core';

/**
 * The opaque cursor of the admin lists, which page by a timestamp then an id:
 * the last row's, base64url. Timestamps are epoch milliseconds; an ISO column
 * goes through `Date.parse` and back through `toISOString`.
 */
export function encodeCursor(at: number, id: string): string {
  return btoa(`${at}|${id}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The row a cursor names; a 400 for anything `encodeCursor` didn't make. */
export function decodeCursor(cursor: string): { at: number; id: string } {
  try {
    const b64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const [at, id, ...rest] = atob(b64).split('|');
    const ms = Number(at);
    if (at && Number.isSafeInteger(ms) && id && rest.length === 0) return { at: ms, id };
  } catch {
    // fall through
  }
  throw new ValidationError('Invalid cursor');
}
