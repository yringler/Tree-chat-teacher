import { MICROS_PER_USD } from './billing.js';

/*
 * Money as people read it, shared by the apps and the Worker's server-rendered
 * pages (the landing page's pool meter, `/pool`). Integer math on the ledger's
 * micro-USD and on whole cents; display only.
 */

/** Ledger micro-USD per US cent. */
const MICROS_PER_CENT = MICROS_PER_USD / 100;

/** `1_234_567` → `$1.23`; negative balances keep their sign (`-$0.40`). Rounds to the nearest cent. */
export function formatMicros(micros: number): string {
  const cents = Math.round(Math.abs(micros) / MICROS_PER_CENT);
  const sign = micros < 0 && cents > 0 ? '-' : '';
  return `${sign}$${dollars(cents)}`;
}

/** `500` → `$5`, `1250` → `$12.50`: whole dollars drop the cents. */
export function formatCents(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  const sign = cents < 0 && abs > 0 ? '-' : '';
  return abs % 100 === 0
    ? `${sign}$${(abs / 100).toLocaleString('en-US')}`
    : `${sign}$${dollars(abs)}`;
}

/** Basis points as a percentage: `1000` → `10%`, `750` → `7.5%`. */
export function formatBps(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

function dollars(cents: number): string {
  const whole = Math.floor(cents / 100).toLocaleString('en-US');
  return `${whole}.${String(cents % 100).padStart(2, '0')}`;
}
