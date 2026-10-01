import { InjectionToken } from '@angular/core';
import { passkeyClient } from '@better-auth/passkey/client';
import { stripeClient } from '@better-auth/stripe/client';
import { createAuthClient } from 'better-auth/client';
import { magicLinkClient } from 'better-auth/client/plugins';

/**
 * Better Auth's browser client for `/api/auth/*`, with the plugins the
 * Worker registers: magic links, passkeys and the Stripe subscription
 * endpoints (used by BillingClient; the Worker only mounts those when
 * billing is configured).
 */
export function createTangentAuthClient(baseURL: string = location.origin) {
  return createAuthClient({
    baseURL,
    basePath: '/api/auth',
    plugins: [magicLinkClient(), passkeyClient(), stripeClient({ subscription: true })],
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
