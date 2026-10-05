import { DomainError, HTTP_STATUS, PoolBlockedError, ValidationError } from '@tangent/core';
import type { ApiError, ApiErrorCode } from '@tangent/shared';
import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { validator } from 'hono/validator';
import { ZodError, type z } from 'zod';

export function apiError(
  c: Context,
  code: ApiErrorCode,
  message: string,
  extra: Omit<ApiError['error'], 'code' | 'message'> = {},
): Response {
  const body: ApiError = { error: { code, message, ...extra } };
  return c.json(body, HTTP_STATUS[code] as ContentfulStatusCode);
}

/** The `ApiError` body of a domain error; a pool refusal carries what it hit (`error.pool`). */
export function apiErrorBody(err: DomainError): ApiError {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err instanceof PoolBlockedError ? { pool: err.details } : {}),
    },
  };
}

/** Human-readable one-liner, e.g. `title: Too small; nodeId: Required`. */
export function formatZodError(err: ZodError): string {
  const parts = err.issues.slice(0, 5).map((i) => {
    const path = i.path.map(String).join('.');
    return path ? `${path}: ${i.message}` : i.message;
  });
  if (err.issues.length > 5) parts.push(`(+${err.issues.length - 5} more)`);
  return parts.join('; ') || 'Invalid request';
}

function codeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 410:
      return 'gone';
    case 429:
      return 'rate_limited';
    default:
      return status >= 500 ? 'internal' : 'bad_request';
  }
}

export const onError: ErrorHandler = (err, c) => {
  if (err instanceof DomainError) {
    const { error } = apiErrorBody(err);
    return apiError(c, error.code, error.message, error.pool ? { pool: error.pool } : {});
  }
  if (err instanceof ZodError) return apiError(c, 'bad_request', formatZodError(err));
  if (err instanceof HTTPException) {
    const code = codeForStatus(err.status);
    // Hono's own exceptions carry safe, user-facing messages (e.g. malformed JSON).
    return apiError(c, code, code === 'internal' ? 'Internal error' : err.message || code);
  }
  console.error('Unhandled error', c.req.method, new URL(c.req.url).pathname, err);
  return apiError(c, 'internal', 'Internal error');
};

export const notFound: NotFoundHandler = (c) => apiError(c, 'not_found', 'Route not found');

function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError(formatZodError(result.error));
  return result.data;
}

/**
 * Validates the JSON body with `schema`; handlers read it with
 * `c.req.valid('json')`. Requires `Content-Type: application/json`.
 */
export function validateJson<S extends z.ZodType>(schema: S) {
  return validator('json', async (_value, c): Promise<z.output<S>> => {
    const type = c.req.header('Content-Type') ?? '';
    if (!/^application\/([a-z.+-]+\+)?json\b/i.test(type)) {
      throw new ValidationError('Expected a JSON body (Content-Type: application/json)');
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ValidationError('Malformed JSON in request body');
    }
    return parseOrThrow(schema, body);
  });
}

/** Validates query parameters with `schema`; read with `c.req.valid('query')`. */
export function validateQuery<S extends z.ZodType>(schema: S) {
  return validator('query', (value): z.output<S> => parseOrThrow(schema, value));
}
