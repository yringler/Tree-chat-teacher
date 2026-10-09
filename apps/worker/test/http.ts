// Requests to the Worker under test as the dev bypass (no session: the
// default power account, vitest.config.ts), and readers of its answers. The
// suites that need signed-in users use session-client.ts.
import type { StreamEvent } from '@tangent/shared';
import { exports } from 'cloudflare:workers';
import { expect } from 'vitest';

/** The origin every test request goes to (the apps' own, so same-origin checks pass). */
export const BASE = 'https://tangent.example.com';

/** `json` is sent as the body, with its content type (and POST unless `method` says otherwise). */
export type CallInit = RequestInit & { json?: unknown };

/** `path` on the Worker's own fetch handler. */
export function call(path: string, init: CallInit = {}): Promise<Response> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set('Content-Type', 'application/json');
  return exports.default.fetch(
    new Request(BASE + path, {
      ...rest,
      method: rest.method ?? (json !== undefined ? 'POST' : 'GET'),
      headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    }),
  );
}

/** The JSON body (null when empty), after checking the status (the body is the message). */
export async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  expect(r.status, text).toBe(status);
  return (text ? JSON.parse(text) : null) as T;
}

/** The events of an SSE body, in order (`data:` lines; comments and keepalives skipped). */
export function parseSse<T = StreamEvent>(text: string): T[] {
  return text
    .split('\n\n')
    .map((frame) => frame.split('\n').find((l) => l.startsWith('data:')))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(5).trim()) as T);
}
