import type { ApiErrorCode } from '@tangent/shared';

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
  key_required: 401,
  provider_error: 502,
  internal: 500,
};

/** No usable API key for the provider (missing, or an unreadable key cookie). */
export class KeyRequiredError extends DomainError {
  constructor(message: string) {
    super('key_required', message);
  }
}

/** A simple account lacks the credit (or billing setup) to start a metered generation. */
export class PaymentRequiredError extends DomainError {
  constructor(message = 'Add credit to keep learning') {
    super('payment_required', message);
  }
}
