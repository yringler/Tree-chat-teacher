// The Polar adapter's configuration: its own env vars and nothing else
// (03-architecture.md §2, rule 1). Products, prices and portal settings are
// created in the Polar dashboard (README, "Membership, credit and billing").
import { intVar } from '../../../config.js';
import type { AppEnv } from '../../../env.js';

export type PolarServer = 'sandbox' | 'production';

export interface PolarConfig {
  accessToken: string;
  webhookSecret: string;
  server: PolarServer;
  /** The one-time product top-ups are sold as; null = no top-ups. */
  creditsProductId: string | null;
  /** The yearly membership product; null = no membership is sold. */
  membershipProductId: string | null;
  /**
   * Polar's fee as an estimate (D3), for an order that reports no usable fee:
   * `bps` of the total charged plus `fixedCents`. Defaults: the Starter plan,
   * 5% + 50¢ (international cards add 1.5% that this can't know).
   */
  feeEstimate: { bps: number; fixedCents: number };
}

const DEFAULT_POLAR_FEE_BPS = 500;
const DEFAULT_POLAR_FEE_FIXED_CENTS = 50;

/**
 * The adapter's config, or null when Polar isn't configured (the access token
 * or the webhook secret is unset). `POLAR_SERVER` defaults to `sandbox`, so a
 * missing var can't charge real cards (D8); anything but `production` is the
 * sandbox.
 */
export function polarConfig(env: AppEnv): PolarConfig | null {
  const accessToken = env.POLAR_ACCESS_TOKEN?.trim();
  const webhookSecret = env.POLAR_WEBHOOK_SECRET?.trim();
  if (!accessToken || !webhookSecret) return null;
  return {
    accessToken,
    webhookSecret,
    server: env.POLAR_SERVER?.trim() === 'production' ? 'production' : 'sandbox',
    creditsProductId: env.POLAR_CREDITS_PRODUCT_ID?.trim() || null,
    membershipProductId: env.POLAR_MEMBERSHIP_PRODUCT_ID?.trim() || null,
    feeEstimate: {
      bps: intVar(env.POLAR_FEE_BPS, DEFAULT_POLAR_FEE_BPS),
      fixedCents: intVar(env.POLAR_FEE_FIXED_CENTS, DEFAULT_POLAR_FEE_FIXED_CENTS),
    },
  };
}
