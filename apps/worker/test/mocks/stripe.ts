// Wave 1 stub (foundation). Implemented in wave 2 by the `billing` agent.
//
// Stand-in for https://api.stripe.com in tests. It runs in Node (the Vitest
// host), not in workerd: vitest.config.ts's `outboundService` delegates every
// outbound request to this origin here. Keep it free of `cloudflare:*` imports.

export const STRIPE_ORIGIN = 'https://api.stripe.com';

export async function mockStripe(_request: Request): Promise<Response> {
  return new Response('stripe mock not implemented', { status: 599 });
}
