import { poolErrorCode, type ApiErrorCode, type PoolBlockDetails } from '@tangent/shared';

/** Domain errors thrown by services; the HTTP layer maps `code` to a status. */
export class DomainError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string) {
    super('not_found', `${what} not found`);
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super('bad_request', message);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super('conflict', message);
  }
}

export class GoneError extends DomainError {
  constructor(message: string) {
    super('gone', message);
  }
}

export const HTTP_STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  gone: 410,
  rate_limited: 429,
  payment_required: 402,
  membership_required: 402,
  key_required: 401,
  provider_error: 502,
  internal: 500,
  pool_empty: 402,
  pool_cap_reached: 429,
  pool_consent_required: 403,
  pool_unavailable: 403,
  no_customer: 404,
};

/** No usable API key for the provider (missing, or an unreadable key cookie). */
export class KeyRequiredError extends DomainError {
  constructor(message: string) {
    super('key_required', message);
  }
}

/** The user's credit (or the billing setup) can't start a call on the built-in provider. */
export class PaymentRequiredError extends DomainError {
  constructor(message = 'Add credit to keep learning') {
    super('payment_required', message);
  }
}

/**
 * The request needs the yearly membership (required once the operator
 * configures it: power mode on the user's own keys, and buying credit) and the user
 * neither has one nor had the fee waived.
 */
export class MembershipRequiredError extends DomainError {
  constructor(message = 'A Tangent membership is needed to keep going') {
    super('membership_required', message);
  }
}

const POOL_MESSAGES: Record<ReturnType<typeof poolErrorCode>, string> = {
  pool_empty: "The open pool can't cover this right now",
  pool_cap_reached: "You have reached today's open pool limit",
  pool_unavailable: 'The open pool is not available for this account',
};

/**
 * The open pool refused a request (402 `pool_empty`, 429
 * `pool_cap_reached` or 403 `pool_unavailable`, by `details.reason`). The HTTP
 * layer sends `details` as `ApiError.error.pool`.
 */
export class PoolBlockedError extends DomainError {
  constructor(
    readonly details: PoolBlockDetails,
    message?: string,
  ) {
    const code = poolErrorCode(details.reason);
    super(code, message ?? POOL_MESSAGES[code]);
  }
}

/** A refusal with no cap involved (`empty`, `unpriced`, or an account that may not use the pool). */
export function poolBlock(reason: PoolBlockDetails['reason']): PoolBlockDetails {
  return { reason, limit: null, resetAt: null, member: false, memberLimit: null };
}

/**
 * 403 `pool_consent_required`: the user has not acknowledged the current pool
 * notice (`POOL_NOTICE_TEXT`). The HTTP layer sends the version to
 * acknowledge as `ApiError.error.consent`.
 */
export class PoolConsentRequiredError extends DomainError {
  constructor(readonly currentVersion: number) {
    super(
      'pool_consent_required',
      'Read and acknowledge the open pool notice before using the pool',
    );
  }
}
