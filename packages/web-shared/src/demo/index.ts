import { APP_BASE_HREF } from '@angular/common';
import type { Provider } from '@angular/core';
import { API_FETCH } from '../core/api-fetch';
import { provideAppPaths } from '../core/app-paths';
import { AUTH_CLIENT, type TangentAuthClient } from '../core/auth-client';
import { accountModeOf, DEMO_BASES, DEMO_MODE, type AppId } from '../core/demo';
import { createDemoFetch } from './backend';

/*
 * `@tangent/web-shared/demo`: the in-browser backend and the providers that
 * turn an app into its demo. Imported only dynamically (each app's main.ts),
 * so the ChatService and the lorem generator stay out of the main bundles.
 */

export {
  createDemoFetch,
  DEMO_ACCOUNT_ID,
  DEMO_EMAIL,
  DEMO_START_BALANCE_MICROS,
  DemoBackend,
  sseFrame,
  type DemoBackendOptions,
  type DemoStorage,
} from './backend';

/**
 * Better Auth client stand-in: every call (sign-in, sign-out, session,
 * passkeys) resolves with an error and touches no network.
 */
export function createDemoAuthClient(): TangentAuthClient {
  const result = async () => ({
    data: null,
    error: { message: "That isn't available in the demo.", status: 400 },
  });
  const handler: ProxyHandler<() => void> = {
    // `then` stays undefined so the stub is never mistaken for a promise.
    get: (_target, prop) => (prop === 'then' ? undefined : stub),
    apply: () => result(),
  };
  const stub: unknown = new Proxy(() => undefined, handler);
  return stub as TangentAuthClient;
}

/**
 * Extra root providers for an app's demo URL (added after its appConfig's,
 * so they win): the in-browser backend as the API transport, the router
 * based at the demo URL, sign-in paths that stay in the demo, and no auth
 * client. The backend acts as the app's account (Canvas shares the power
 * demo's conversations, as it shares the power account for real).
 */
export function demoProviders(app: AppId): Provider[] {
  const base = DEMO_BASES[app];
  const mode = accountModeOf(app);
  return [
    { provide: DEMO_MODE, useValue: true },
    { provide: API_FETCH, useFactory: () => createDemoFetch({ mode }) },
    { provide: APP_BASE_HREF, useValue: base },
    provideAppPaths({ home: base, login: base }),
    { provide: AUTH_CLIENT, useFactory: createDemoAuthClient },
  ];
}
