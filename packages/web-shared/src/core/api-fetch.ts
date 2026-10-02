import { InjectionToken } from '@angular/core';

/**
 * The default transport: the global `fetch`, looked up on every call (so a
 * test's `vi.stubGlobal('fetch', ...)` or a late polyfill is honoured).
 */
export const defaultApiFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

/**
 * The transport behind every `/api/*` call of ApiClient (and
 * `AuthService.loginOptions`). Same contract as `fetch`: it gets the path
 * (`/api/...`) and a RequestInit (method, headers, JSON body, optional
 * AbortSignal) and resolves with a Response, JSON or `text/event-stream`.
 *
 * The default is the browser's fetch. The demos (`/demo`, `/learn/demo`)
 * provide an in-browser backend here, so the real UI runs without any
 * network calls.
 */
export const API_FETCH = new InjectionToken<typeof fetch>('API_FETCH', {
  providedIn: 'root',
  factory: () => defaultApiFetch,
});

/**
 * Extra headers on every `/api/*` call of ApiClient, read per call. The
 * server acts as the caller's power account unless they say otherwise:
 * Tangent Learn sends `x-tangent-mode: simple` and its `x-tangent-payment`
 * choice (MODE_HEADER / PAYMENT_HEADER in @tangent/shared). Default: none.
 */
export const API_HEADERS = new InjectionToken<() => Record<string, string>>('API_HEADERS', {
  providedIn: 'root',
  factory: () => () => ({}),
});
