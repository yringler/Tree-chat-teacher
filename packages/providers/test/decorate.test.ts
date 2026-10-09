import type { LlmProvider, ProviderCapabilities } from '@tangent/shared';
import { describe, expect, it, vi } from 'vitest';
import { decorateProvider } from '../src/decorate.js';

const CAPABILITIES: ProviderCapabilities = {
  maxContextTokens: 1000,
  maxOutputTokens: 100,
  supportsSystemPrompt: true,
  supportsTokenCount: true,
  supportsWebSearch: false,
};

/**
 * A provider with every member of `LlmProvider`, optional ones included: a
 * member added to the interface fails to compile here until it is listed,
 * and the forwarding test below then fails until `decorateProvider` forwards it.
 */
function everyMember(): Required<LlmProvider> {
  return {
    id: 'inner',
    kind: 'fake',
    label: 'Inner',
    models: vi.fn(() => [{ id: 'm', label: 'M' }]),
    defaultModel: vi.fn(() => 'm'),
    capabilities: vi.fn((_model) => ({ ...CAPABILITIES })),
    resolveCapabilities: vi.fn((_model) => Promise.resolve({ ...CAPABILITIES })),
    stream: vi.fn((_request) => ({ async *[Symbol.asyncIterator]() {} })),
    countTokens: vi.fn((_request) => Promise.resolve(5)),
  };
}

describe('decorateProvider', () => {
  it('forwards every member of the provider, with its arguments and result', () => {
    const inner = everyMember();
    const decorated = decorateProvider(inner);
    for (const [key, member] of Object.entries(inner)) {
      const forwarded: unknown = Reflect.get(decorated, key);
      if (!vi.isMockFunction(member)) {
        expect(forwarded, key).toBe(member);
        continue;
      }
      expect(typeof forwarded, key).toBe('function');
      if (typeof forwarded !== 'function') continue;
      const result: unknown = forwarded('argument');
      // The argument reaches the members that take one.
      const takes = member.getMockImplementation()?.length ?? 0;
      expect(member.mock.calls, key).toEqual([['argument'].slice(0, takes)]);
      expect(result, key).toBe(member.mock.results[0]?.value);
    }
  });

  it('replaces only the overridden members', () => {
    const inner = everyMember();
    const decorated = decorateProvider(inner, { defaultModel: () => 'pinned' });
    expect(decorated.defaultModel()).toBe('pinned');
    expect(inner.defaultModel).not.toHaveBeenCalled();
    expect(decorated.models()).toEqual([{ id: 'm', label: 'M' }]);
  });

  it('leaves an optional member absent when neither side has it', () => {
    const { resolveCapabilities: _resolve, countTokens: _count, ...required } = everyMember();
    const decorated = decorateProvider(required);
    expect('resolveCapabilities' in decorated).toBe(false);
    expect('countTokens' in decorated).toBe(false);
    const counted = decorateProvider(required, { countTokens: () => Promise.resolve(7) });
    expect('countTokens' in counted).toBe(true);
  });
});
