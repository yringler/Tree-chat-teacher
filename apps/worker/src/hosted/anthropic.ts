// The Anthropic backend: Anthropic's own API on the operator's
// BUILT_IN_ANTHROPIC_API_KEY, for the Claude models it maps. It reports no
// cost, so a call is charged its tokens at the logical model's price (the one
// OpenRouter's list syncs) plus Anthropic's fee per billed search, and there
// is no generation to look up afterwards.
import { BUILT_IN_ANTHROPIC_API_KEY_SECRET, namedSecrets } from '../config.js';
import type { HostedBackend, HostedEndpoint } from './backend.js';

const ENDPOINT: HostedEndpoint = {
  kind: 'anthropic',
  apiKeySecret: BUILT_IN_ANTHROPIC_API_KEY_SECRET,
  // Anthropic's own web_search tool (grounding, see billing/grounding.ts).
  options: { webSearch: true },
};

/**
 * The Claude models the built-in provider uses, by logical id, and their
 * Anthropic ids. A list rather than a rule over the id's shape: a model
 * missing here runs on OpenRouter, while a derived id Anthropic doesn't have
 * would fail the call.
 */
const MODEL_IDS: Readonly<Record<string, string>> = {
  'anthropic/claude-haiku-5.5': 'claude-haiku-5-5',
  'anthropic/claude-sonnet-5.5': 'claude-sonnet-5-5',
};

export const anthropicBackend: HostedBackend = {
  id: 'anthropic',
  config: () => ENDPOINT,
  apiKey: (env) => {
    const name = BUILT_IN_ANTHROPIC_API_KEY_SECRET;
    return namedSecrets(env, new Set([name]))[name]?.trim() || null;
  },
  modelId: (logical) => MODEL_IDS[logical] ?? null,
  cost: 'tokens',
  fetchGeneration: null,
  // The pool pays Anthropic its list price, with no purchase fee on top.
  feeBps: () => 0,
};
