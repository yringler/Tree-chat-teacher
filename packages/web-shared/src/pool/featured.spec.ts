import '@angular/compiler'; // JIT: the component metadata below.
import type { MeResponse } from '@tangent/shared';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as webShared from '../index';

/** Template of a JIT-compiled component (the decorator's metadata); null for anything else. */
function templateOf(value: unknown): string | null {
  if (typeof value !== 'function') return null;
  const annotations = (value as { __annotations__?: { template?: string }[] }).__annotations__;
  return annotations?.[0]?.template ?? null;
}

// FEATURED_CONVERSATIONS_ENABLED (docs/pool/PLAN.md §S8b): only a stub exists
// on the server (every /api/featured route is 404), so no app may render an
// entry point to it.
describe('featured conversations: no UI (spec test)', () => {
  it('no shared component template mentions featuring a conversation', () => {
    const templates = Object.entries(webShared)
      .map(([name, value]) => [name, templateOf(value)] as const)
      .filter((e): e is readonly [string, string] => e[1] !== null);
    expect(templates.length).toBeGreaterThan(10);
    for (const [name, template] of templates) expect(template, name).not.toMatch(/featur/i);
  });

  it('the server never offers it: MeResponse.featuredConversations is always false', () => {
    expectTypeOf<MeResponse['featuredConversations']>().toEqualTypeOf<false>();
  });

  it('the client has no featured endpoint', () => {
    const methods = Object.getOwnPropertyNames(webShared.ApiClient.prototype);
    expect(methods.length).toBeGreaterThan(10);
    for (const m of methods) expect(m).not.toMatch(/featur/i);
  });
});
