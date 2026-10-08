// Ledger idempotency keys (`credit_grants.provider_ref`). Adapters mint one
// ref per provider object (`<provider>:<object>:<id>`); the domain derives the
// secondary keys it needs from them, so no provider has to. `admin:` and
// `dev:` keys (an admin's adjustment, a simulated purchase) are never minted
// by a provider: `ProviderId` has no such literal.
import type { ProviderId, ProviderRef } from './port.js';

/** `<provider>:<object>:<rawId>`, e.g. `polar:order:6c1e…`. */
export function providerRef(provider: ProviderId, object: string, rawId: string): ProviderRef {
  if (!object || object.includes(':')) throw new Error(`providerRef: bad object "${object}"`);
  if (!rawId) throw new Error(`providerRef: empty ${object} id`);
  return `${provider}:${object}:${rawId}` as ProviderRef;
}

/** The credit back of a won dispute: what the dispute debited, returned once. */
export function reinstatedRef(disputeRef: ProviderRef): ProviderRef {
  return `${disputeRef}:reinstated` as ProviderRef;
}

/** The membership's included credit taken back once, however many refunds a payment gets. */
export function membershipRefundRef(paymentRef: ProviderRef): ProviderRef {
  return `${paymentRef}:membership-refund` as ProviderRef;
}
