// Wave 1 stub (foundation). Implemented in wave 2 by the `billing` agent.
//
// Stand-in for https://openrouter.ai in tests (e.g. GET /api/v1/generation).
// It runs in Node (the Vitest host), not in workerd: vitest.config.ts's
// `outboundService` delegates every outbound request to this origin here.
// Keep it free of `cloudflare:*` imports.

export const OPENROUTER_ORIGIN = 'https://openrouter.ai';

export async function mockOpenRouter(_request: Request): Promise<Response> {
  return new Response('openrouter mock not implemented', { status: 599 });
}
