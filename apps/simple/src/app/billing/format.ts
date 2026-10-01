import { MAX_TOP_UP_CENTS, MICROS_PER_USD, MIN_TOP_UP_CENTS } from '@tangent/shared';

/** Ledger micro-USD per US cent. */
const MICROS_PER_CENT = MICROS_PER_USD / 100;

/** `1_234_567` → `$1.23`; negative balances keep their sign (`-$0.40`). Rounds to the nearest cent. */
export function formatMicros(micros: number): string {
  const cents = Math.round(Math.abs(micros) / MICROS_PER_CENT);
  const sign = micros < 0 && cents > 0 ? '-' : '';
  return `${sign}$${dollars(cents)}`;
}

/**
 * A single charge. Most replies cost a fraction of a cent, so amounts under
 * $0.01 keep four decimals (`$0.0004`) instead of reading `$0.00`.
 */
export function formatCharge(micros: number): string {
  const abs = Math.abs(micros);
  if (abs === 0 || abs >= MICROS_PER_CENT) return formatMicros(micros);
  const tenThousandths = Math.max(1, Math.round(abs / 100));
  const sign = micros < 0 ? '-' : '';
  return `${sign}$0.${String(tenThousandths).padStart(4, '0')}`;
}

/** `500` → `$5`, `1250` → `$12.50`: whole dollars drop the cents. */
export function formatCents(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  const sign = cents < 0 && abs > 0 ? '-' : '';
  return abs % 100 === 0
    ? `${sign}$${(abs / 100).toLocaleString('en-US')}`
    : `${sign}$${dollars(abs)}`;
}

/**
 * Parses a dollar amount typed by a person into whole cents:
 * `12`, `12.5`, `$12.50`, ` 1,000 ` are accepted; anything else (empty,
 * negative, more than two decimals, letters) is null. Integer math only.
 */
export function parseDollarsToCents(input: string): number | null {
  const text = input.trim().replace(/^\$\s*/, '');
  if (!/^(\d{1,3}(,\d{3})+|\d+)?(\.\d{0,2})?$/.test(text)) return null;
  const [whole = '', fraction = ''] = text.replaceAll(',', '').split('.');
  if (whole === '' && fraction === '') return null;
  const cents = Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * Why a top-up amount can't be used, or null when it can. The server accepts
 * whole cents from `min` to `max` (by default $5 to $500).
 */
export function topUpError(
  cents: number | null,
  min: number = MIN_TOP_UP_CENTS,
  max: number = MAX_TOP_UP_CENTS,
): string | null {
  if (cents === null || !Number.isInteger(cents))
    return 'Enter an amount in dollars, like 25 or 12.50.';
  if (cents < min) return `The smallest top-up is ${formatCents(min)}.`;
  if (cents > max) return `The largest top-up is ${formatCents(max)}.`;
  return null;
}

/** True for a whole-cent amount the server will accept. */
export function isValidTopUpCents(
  cents: number,
  min: number = MIN_TOP_UP_CENTS,
  max: number = MAX_TOP_UP_CENTS,
): boolean {
  return topUpError(cents, min, max) === null;
}

/** Basis points as a percentage: `1000` → `10%`, `750` → `7.5%`. */
export function formatBps(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

function dollars(cents: number): string {
  const whole = Math.floor(cents / 100).toLocaleString('en-US');
  return `${whole}.${String(cents % 100).padStart(2, '0')}`;
}
