// Ledger idempotency keys (`credit_grants.provider_ref`). Adapters mint one
// ref per provider object (`<provider>:<object>:<id>`); the domain derives the
// secondary keys it needs from them, so no provider has to.
import type { ProviderId, ProviderRef } from './port.js';

/**
 * Prefixes of grants that are not payments: an admin's adjustment, a
 * simulated purchase, the pool's daily share of the markup on personal credit
 * (pool/revenue-share.ts).
 */
const RESERVED_PREFIXES = ['admin:', 'dev:', 'pool-share:'] as const;

/** `<provider>:<object>:<rawId>`, e.g. `polar:order:6c1e…`. */
export function providerRef(provider: ProviderId, object: string, rawId: string): ProviderRef {
  if (!object || object.includes(':')) throw new Error(`providerRef: bad object "${object}"`);
  if (!rawId) throw new Error(`providerRef: empty ${object} id`);
  return `${provider}:${object}:${rawId}` as ProviderRef;
}

/** The provider a ref was minted by (its first segment). */
export function providerOfRef(ref: ProviderRef): string {
  return ref.slice(0, ref.indexOf(':'));
}

/** The credit back of a won dispute: what the dispute debited, returned once. */
export function reinstatedRef(disputeRef: ProviderRef): ProviderRef {
  return `${disputeRef}:reinstated` as ProviderRef;
}

/** The membership's included credit taken back once, however many refunds a payment gets. */
export function membershipRefundRef(paymentRef: ProviderRef): ProviderRef {
  return `${paymentRef}:membership-refund` as ProviderRef;
}

/** The pool's share of a membership payment (pool/revenue-share.ts), granted once per payment. */
export function membershipPoolShareRef(paymentRef: ProviderRef): ProviderRef {
  return `${paymentRef}:pool-share` as ProviderRef;
}

/** What one refund of a membership payment takes back of the pool's share of it, once per refund. */
export function poolShareReversalRef(refundRef: ProviderRef): ProviderRef {
  return `${refundRef}:pool-share` as ProviderRef;
}

/** True for `admin:`, `dev:` and `pool-share:` keys, which no provider may mint. */
export function isReservedRef(ref: string): boolean {
  return RESERVED_PREFIXES.some((p) => ref.startsWith(p));
}
