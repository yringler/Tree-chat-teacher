import type { LlmProvider } from '@tangent/shared';

/** What a decorator may replace: any member but the provider's identity. */
export type ProviderOverrides = Partial<Omit<LlmProvider, 'id' | 'kind' | 'label'>>;

/**
 * `inner` with `overrides` in place of some of its members and every other
 * member forwarded: the one way a host wraps a provider (the Worker's usage
 * meter, pinned model and real context windows), so a member added to
 * `LlmProvider` reaches every wrapper. An optional member stays absent when
 * neither `overrides` nor `inner` has it.
 */
export function decorateProvider(
  inner: LlmProvider,
  overrides: ProviderOverrides = {},
): LlmProvider {
  const decorated: LlmProvider = {
    get id() {
      return inner.id;
    },
    get kind() {
      return inner.kind;
    },
    get label() {
      return inner.label;
    },
    models: overrides.models ?? (() => inner.models()),
    defaultModel: overrides.defaultModel ?? (() => inner.defaultModel()),
    capabilities: overrides.capabilities ?? ((model) => inner.capabilities(model)),
    stream: overrides.stream ?? ((request) => inner.stream(request)),
  };
  const resolve = overrides.resolveCapabilities ?? inner.resolveCapabilities?.bind(inner);
  if (resolve) decorated.resolveCapabilities = resolve;
  const count = overrides.countTokens ?? inner.countTokens?.bind(inner);
  if (count) decorated.countTokens = count;
  return decorated;
}
