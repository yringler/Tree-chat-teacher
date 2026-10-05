// FEATURED_CONVERSATIONS_ENABLED (docs/pool/PLAN.md §S8b; spec §9 "Verbatim
// showcase"): only a stub exists. With the flag off (as deployed) and even on,
// every featured endpoint is 404, /api/me never offers it, and no table or
// column holds anything for it. The apps' template specs check that no UI
// renders (packages/web-shared/src/pool/featured.spec.ts).
import type { ApiError, MeResponse } from '@tangent/shared';
import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { appConfig } from '../src/config.js';
import type { AppEnv } from '../src/env.js';
import { featuredEnabled } from '../src/routes/featured.js';
import { authEnv, client, ORIGIN } from './session-client.js';

const env = rawEnv as unknown as AppEnv;

const PATHS = [
  '/api/featured',
  '/api/featured/',
  '/api/featured/x',
  '/api/featured/conversations',
  '/api/featured/conversations/x/publish',
  '/api/featured/conversations/x/unpublish',
];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function flagEnv(on: boolean, overrides: Partial<AppEnv> = {}): AppEnv {
  return authEnv({ FEATURED_CONVERSATIONS_ENABLED: on ? 'true' : 'false', ...overrides });
}

describe('FEATURED_CONVERSATIONS_ENABLED (spec test)', () => {
  it('is off as deployed (and in the tests)', () => {
    expect(appConfig(env).flags.featuredConversationsEnabled).toBe(false);
    expect(featuredEnabled(env)).toBe(false);
    // Even on, it would need public sharing (a registered DMCA agent).
    expect(featuredEnabled(flagEnv(true, { DMCA_AGENT_REGISTERED: 'false' }))).toBe(false);
    expect(featuredEnabled(flagEnv(true, { DMCA_AGENT_REGISTERED: 'true' }))).toBe(true);
  });

  for (const on of [false, true]) {
    it(`every featured endpoint is 404, signed in or not (flag ${on ? 'on' : 'off'})`, async () => {
      const e = flagEnv(on, { DMCA_AGENT_REGISTERED: 'true' });
      const anonymous = createApp();
      const user = client(e);
      await user.signIn(`featured-${Math.random().toString(36).slice(2, 8)}@example.org`);
      for (const path of PATHS) {
        for (const method of METHODS) {
          const init: RequestInit = {
            method,
            ...(method === 'GET' ? {} : { body: '{}', headers: { 'content-type': 'application/json' } }),
          };
          for (const res of [
            await anonymous.request(`${ORIGIN}${path}`, init, e),
            await user.call(path, init),
          ]) {
            expect(res.status, `${method} ${path}`).toBe(404);
            expect(((await res.json()) as ApiError).error.code).toBe('not_found');
          }
        }
      }
    });

    it(`/api/me never offers it (flag ${on ? 'on' : 'off'})`, async () => {
      const user = client(flagEnv(on, { DMCA_AGENT_REGISTERED: 'true' }));
      await user.signIn(`featured-me-${Math.random().toString(36).slice(2, 8)}@example.org`);
      const me = (await (await user.call('/api/me')).json()) as MeResponse;
      expect(me.featuredConversations).toBe(false);
    });
  }

  it('collects nothing: no table or column for it exists', async () => {
    const { results: tables } = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type IN ('table', 'index', 'view')`,
    ).all<{ name: string }>();
    expect(tables.length).toBeGreaterThan(0);
    for (const { name } of tables) expect(name).not.toMatch(/featur/i);
    // Every column is in its table's CREATE statement.
    const { results: ddl } = await env.DB.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL`,
    ).all<{ name: string; sql: string }>();
    expect(ddl.some((t) => t.name === 'usage_events')).toBe(true);
    for (const { name, sql } of ddl) expect(sql, name).not.toMatch(/featur/i);
  });
});
