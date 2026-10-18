import type { ProviderKind } from '@tangent/shared';
import { createAnthropicProvider } from './anthropic.js';
import { createFakeProvider } from './fake.js';
import { ANTHROPIC_ENDPOINT, OPENAI_ENDPOINT, stripTrailingSlash } from './internal.js';
import { createOpenAiCompatibleProvider } from './openai-compatible.js';
import type { ProviderFactory } from './registry.js';

/** A request that succeeds only with a valid key and costs nothing. */
export interface KeyCheckRequest {
  url: string;
  headers: Record<string, string>;
}

/** Everything that differs between provider kinds outside the adapters themselves. */
export interface KindDescriptor {
  create: ProviderFactory;
  /**
   * Replies are scripted (the test provider): it needs no key and takes none,
   * and is the default provider only when nothing real is usable.
   */
  scripted: boolean;
  /** A config with a baseUrl and no key is usable: a local or self-hosted server needs none. */
  keylessWithBaseUrl: boolean;
  /**
   * The endpoint a config without a baseUrl reaches: who runs it and how its
   * keys start. A custom baseUrl may be anyone, so the prefix isn't checked then.
   */
  defaultEndpoint: { url: string; vendor: string; keyPrefix: string } | null;
  /**
   * Who runs every endpoint of this kind, for the privacy policy: a custom
   * baseUrl is a gateway in front of the same API. Null when the baseUrl's
   * host is who runs it.
   */
  vendor: string | null;
  /** The key check for this kind, or null when it has no cheap endpoint for one. */
  verifyRequest(baseUrl: string | undefined, apiKey: string): KeyCheckRequest | null;
}

/** The one place new provider kinds are registered. */
export const PROVIDER_KINDS: Record<ProviderKind, KindDescriptor> = {
  anthropic: {
    create: createAnthropicProvider,
    scripted: false,
    keylessWithBaseUrl: false,
    defaultEndpoint: ANTHROPIC_ENDPOINT,
    vendor: ANTHROPIC_ENDPOINT.vendor,
    verifyRequest: (baseUrl, apiKey) => ({
      url: `${stripTrailingSlash(baseUrl ?? ANTHROPIC_ENDPOINT.url)}/v1/models?limit=1`,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    }),
  },
  'openai-compatible': {
    create: createOpenAiCompatibleProvider,
    scripted: false,
    keylessWithBaseUrl: true,
    defaultEndpoint: OPENAI_ENDPOINT,
    vendor: null,
    verifyRequest: (baseUrl, apiKey) => ({
      url: `${stripTrailingSlash(baseUrl ?? OPENAI_ENDPOINT.url)}/models`,
      headers: { authorization: `Bearer ${apiKey}` },
    }),
  },
  fake: {
    create: createFakeProvider,
    scripted: true,
    keylessWithBaseUrl: false,
    defaultEndpoint: null,
    vendor: null,
    verifyRequest: () => null,
  },
};
