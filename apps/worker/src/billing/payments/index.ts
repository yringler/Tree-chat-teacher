// Which payment provider this deployment uses (03-architecture.md §2.5),
// picked like the email service (email/index.ts): `PAYMENT_PROVIDER`, default
// `polar`. This is the only place that chooses an adapter; everything else
// asks for "the provider" and gets the port.
import type { AppEnv } from '../../env.js';
import { createFakeProvider, parseFakeOptions } from '../providers/fake.js';
import { createPolarProvider } from '../providers/polar/adapter.js';
import { polarConfig } from '../providers/polar/config.js';
import type { PaymentProvider, ProviderId } from './port.js';

export * from './port.js';

/** `PAYMENT_PROVIDER`, trimmed; `polar` when empty. */
function selectedProvider(env: AppEnv): string {
  return env.PAYMENT_PROVIDER?.trim() || 'polar';
}

/**
 * The active provider, or null when payments aren't configured (no top-ups,
 * no membership sold). Misconfiguration throws: an unknown PAYMENT_PROVIDER,
 * or `fake` outside tests.
 */
export function paymentProvider(env: AppEnv): PaymentProvider | null {
  const id = selectedProvider(env);
  switch (id) {
    case 'polar': {
      const config = polarConfig(env);
      return config ? createPolarProvider(config) : null;
    }
    case 'fake':
      if (env.TEST_SEAMS !== 'true')
        throw new Error('PAYMENT_PROVIDER=fake is only allowed in tests (TEST_SEAMS)');
      return createFakeProvider(parseFakeOptions(env.FAKE_PAYMENTS));
    default:
      throw new Error(`Unknown PAYMENT_PROVIDER "${id}"`);
  }
}

/** True when a payment provider is configured: replaces the processor-specific check everywhere. */
export function paymentsConfigured(env: AppEnv): boolean {
  return paymentProvider(env) !== null;
}

/**
 * The provider whose webhooks `/api/webhooks/:id` accepts: the active one.
 * A post-launch switch may add a legacy provider here (PAYMENT_PROVIDER_LEGACY,
 * webhooks and dispute polls only) for the old provider's refund window.
 */
export function webhookProvider(env: AppEnv, id: string): PaymentProvider | null {
  const provider = paymentProvider(env);
  return provider && provider.id === (id as ProviderId) ? provider : null;
}
