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
}
