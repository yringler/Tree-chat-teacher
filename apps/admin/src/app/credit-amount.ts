import { ADMIN_CREDIT_MAX_CENTS } from '@tangent/shared';
import { formatCents, parseDollarsToCents } from '@tangent/web-shared';

/**
 * A signed admin credit amount typed in dollars (`25`, `$100.50`, `-5.50`: a
 * leading `-` debits) as whole cents, or the reason `POST /api/admin/credit`
 * would refuse it (zero, malformed, beyond `ADMIN_CREDIT_MAX_CENTS`).
 */
export function signedCreditCents(amount: string): number | string {
  const text = amount.trim();
  const negative = text.startsWith('-');
  const cents = parseDollarsToCents(negative ? text.slice(1) : text);
  if (cents === null || cents === 0) return 'Enter an amount in dollars, like 25 or -5.50.';
  if (cents > ADMIN_CREDIT_MAX_CENTS)
    return `At most ${formatCents(ADMIN_CREDIT_MAX_CENTS)} at a time.`;
  return negative ? -cents : cents;
}
