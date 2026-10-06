import {
  formatBps,
  formatCents,
  formatMicros,
  MAX_TOP_UP_CENTS,
  MICROS_PER_USD,
  MIN_TOP_UP_CENTS,
} from '@tangent/shared';

// formatMicros, formatCents and formatBps live in @tangent/shared (the Worker's pages use them too).
export { formatBps, formatCents, formatMicros };

/** Ledger micro-USD per US cent. */
const MICROS_PER_CENT = MICROS_PER_USD / 100;

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
