// `cloudflare:workers` for the node project (vitest.config.ts): the suites
// there read only vars, so `env` is wrangler.jsonc's vars under the test
// bindings, as miniflare builds it for the workers project, without D1,
// Durable Objects or rate limiters. A suite that reaches for one fails at
// once and belongs in the workers project.
import { TEST_BINDINGS } from '../bindings.js';
import { shippedVars } from '../mocks/wrangler-vars.js';

export const env: Readonly<Record<string, string>> = { ...shippedVars(), ...TEST_BINDINGS };

/** What src/do/tree-session.ts and src/pool/pool-bank.ts extend; never instantiated here. */
export class DurableObject {}
