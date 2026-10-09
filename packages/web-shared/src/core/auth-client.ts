import { InjectionToken } from '@angular/core';
import { passkeyClient } from '@better-auth/passkey/client';
import { createAuthClient } from 'better-auth/client';
import { magicLinkClient } from 'better-auth/client/plugins';
import { AUTH_BASE_PATH } from '@tangent/shared';

/**
 * Better Auth's browser client for `/api/auth/*`, with the plugins the
 * Worker registers: magic links and passkeys. Payments don't go through
 * Better Auth (BillingClient calls `/api/billing/*`).
 */
export function createTangentAuthClient(baseURL: string = location.origin) {
  return createAuthClient({
    baseURL,
    basePath: AUTH_BASE_PATH,
    plugins: [magicLinkClient(), passkeyClient()],
  });
}

export type TangentAuthClient = ReturnType<typeof createTangentAuthClient>;

/** One client per app; tests can provide a fake. */
export const AUTH_CLIENT = new InjectionToken<TangentAuthClient>('AUTH_CLIENT', {
  providedIn: 'root',
  factory: () => createTangentAuthClient(),
});

/** A Better Auth client error as a sentence for the UI. */
export function authErrorMessage(error: {
  message?: string | undefined;
  status?: number;
  code?: string | undefined;
}): string {
  if (error.status === 429) return 'Too many attempts. Wait a minute and try again.';
  return error.message || 'Something went wrong. Please try again.';
}
