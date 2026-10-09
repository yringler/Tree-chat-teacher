import { API_ROUTES } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

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
});
