// The Polar adapter's configuration, parsed from its env vars by config.ts
// (`appConfig(env).payments.polar`). Products, prices and portal settings are
// created in the Polar dashboard (docs/operating.md, "Credit, membership and billing").

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
   * Polar's fee as an estimate, for an order that reports no usable fee:
   * `bps` of the total charged plus `fixedCents` (`POLAR_FEE_BPS`,
   * `POLAR_FEE_FIXED_CENTS`).
   */
  feeEstimate: { bps: number; fixedCents: number };
}
