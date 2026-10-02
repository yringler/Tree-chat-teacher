import { APP_BASE_HREF } from '@angular/common';
import type { Provider } from '@angular/core';
import {
  API_FETCH,
  AUTH_CLIENT,
  provideAppPaths,
  type TangentAuthClient,
} from '@tangent/web-shared';
import { createDemoFetch } from './demo-backend';
import { DEMO_BASE, DEMO_MODE } from './demo-mode';

/**
 * Better Auth client stand-in: every call (sign-in, sign-out, session,
 * passkeys, Stripe plans) resolves with an error and touches no network.
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
 * Extra root providers for `/learn/demo/...` (added after appConfig's, so
 * they win): the in-browser backend as the API transport, the router based
 * at `/learn/demo/`, sign-in paths that stay in the demo, and no auth client.
 */
export function demoProviders(): Provider[] {
  return [
    { provide: DEMO_MODE, useValue: true },
    { provide: API_FETCH, useFactory: () => createDemoFetch() },
    { provide: APP_BASE_HREF, useValue: DEMO_BASE },
    provideAppPaths({ home: DEMO_BASE, login: DEMO_BASE }),
    { provide: AUTH_CLIENT, useFactory: createDemoAuthClient },
  ];
}
