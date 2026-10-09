import { API_ROUTES, type RouteSpec } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { validatedPart } from '../src/http/errors.js';

/** The `/api/*` routes the apps never call, with who does. */
const NOT_IN_THE_TABLE: Record<string, string> = {
  'GET /api/auth/*': 'Better Auth (sign-in, callbacks, session, passkeys)',
  'POST /api/auth/*': 'Better Auth',
  'POST /api/webhooks/:provider': "the payment provider's webhooks",
};

describe('the API route table', () => {
  it('lists exactly the /api routes the Worker serves, with their methods', () => {
    const served = new Set(
      createApp()
        .routes.filter((r) => r.method !== 'ALL' && r.path.startsWith('/api/'))
        .map((r) => `${r.method} ${r.path}`),
    );
    const listed = Object.values(API_ROUTES).map((r) => `${r.method} /api${r.path}`);
    expect(new Set(listed).size, 'routes listed twice').toBe(listed.length);
    expect(
      [...served].filter((r) => !listed.includes(r) && !(r in NOT_IN_THE_TABLE)),
      'served but missing from the table',
    ).toEqual([]);
    expect(
      listed.filter((r) => !served.has(r)),
      'in the table but not served',
    ).toEqual([]);
    expect(
      Object.keys(NOT_IN_THE_TABLE).filter((r) => !served.has(r)),
      'exempt routes that no longer exist',
    ).toEqual([]);
  });

  it('validates each route with its own entry’s body and query schemas, and nothing else', () => {
    const key = (method: string, path: string) => `${method} ${path}`;
    // What each served route validates, as `part routeName`.
    const checks = new Map<string, string[]>();
    const nameOf = new Map<RouteSpec, string>(
      Object.entries(API_ROUTES).map(([name, route]) => [route, name]),
    );
    for (const r of createApp().routes) {
      const v = validatedPart(r.handler);
      if (!v) continue;
      const k = key(r.method, r.path);
      checks.set(k, [...(checks.get(k) ?? []), `${v.part} ${nameOf.get(v.route) ?? '?'}`]);
    }
    const expected = new Map<string, string[]>();
    for (const [name, route] of Object.entries(API_ROUTES)) {
      const parts = [
        ...('query' in route ? [`query ${name}`] : []),
        ...('body' in route ? [`body ${name}`] : []),
      ];
      if (parts.length) expected.set(key(route.method, `/api${route.path}`), parts);
    }
    const sorted = (m: Map<string, string[]>) =>
      Object.fromEntries([...m].map(([k, v]) => [k, [...v].sort()]).sort());
    expect(sorted(checks)).toEqual(sorted(expected));
  });
});
