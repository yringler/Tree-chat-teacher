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
  provider_error: 502,
  internal: 500,
};
