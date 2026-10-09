// Which payment provider this deployment uses,
// picked like the email service (email/index.ts): `PAYMENT_PROVIDER`, default
// `polar`. This is the only place that chooses an adapter; everything else
// asks for "the provider" and gets the port.
import { appConfig } from '../../config.js';
import type { AppEnv } from '../../env.js';
import { createFakeProvider, parseFakeOptions } from '../providers/fake.js';
import { createPolarProvider } from '../providers/polar/adapter.js';
import type { PaymentProvider, ProviderId } from './port.js';

export * from './port.js';

/**
 * The active provider, or null when payments aren't configured (no top-ups,
 * no membership sold). Misconfiguration throws (config.ts): an unknown
 * PAYMENT_PROVIDER, or `fake` outside tests.
 */
export function paymentProvider(env: AppEnv): PaymentProvider | null {
  const payments = appConfig(env).payments;
  switch (payments.provider) {
    case 'polar':
      return payments.polar ? createPolarProvider(payments.polar) : null;
    case 'fake':
      return createFakeProvider(parseFakeOptions(payments.fake ?? undefined));
  }
}

/** True when a payment provider is configured: replaces the processor-specific check everywhere. */
export function paymentsConfigured(env: AppEnv): boolean {
  return paymentProvider(env) !== null;
}

/** The provider whose webhooks `/api/webhooks/:id` accepts: the active one. */
export function webhookProvider(env: AppEnv, id: string): PaymentProvider | null {
  const provider = paymentProvider(env);
  return provider && provider.id === (id as ProviderId) ? provider : null;
}
