import { describe, expect, it } from 'vitest';
import { createBranchRequestSchema, createTreeRequestSchema, treeBackupSchema } from './api.js';
import { reviewRequestSchema } from './review.js';
import { fromLegacyRoute, parseRouteKey, providerRouteKey, routeKey, sameRoute } from './route.js';

describe('routes (provider + funding)', () => {
  it('keys a route: the provider id for own-key, `@credit` for Tangent credit', () => {
    expect(routeKey({ providerId: 'openrouter' })).toBe('openrouter');
    expect(routeKey({ providerId: 'openrouter', funding: 'own-key' })).toBe('openrouter');
    expect(routeKey({ providerId: 'openrouter', funding: 'credit' })).toBe('openrouter@credit');
    expect(providerRouteKey({ id: 'openrouter', funding: 'credit' })).toBe('openrouter@credit');
    for (const key of ['openrouter', 'openrouter@credit', 'anthropic'])
      expect(routeKey(parseRouteKey(key))).toBe(key);
    expect(sameRoute({ providerId: 'x' }, { providerId: 'x', funding: 'own-key' })).toBe(true);
    expect(sameRoute({ providerId: 'x' }, { providerId: 'x', funding: 'credit' })).toBe(false);
  });

  it('reads the legacy `tangent` id as the built-in endpoint on credit', () => {
    expect(parseRouteKey('tangent')).toEqual({ providerId: 'openrouter', funding: 'credit' });
    expect(fromLegacyRoute({ providerId: 'tangent', model: 'm' })).toEqual({
      providerId: 'openrouter',
      funding: 'credit',
      model: 'm',
    });
    // An explicit funding is kept; other ids pass unchanged.
    expect(fromLegacyRoute({ providerId: 'tangent', funding: 'own-key' as const })).toEqual({
      providerId: 'openrouter',
      funding: 'own-key',
    });
    expect(fromLegacyRoute({ providerId: 'anthropic' })).toEqual({ providerId: 'anthropic' });
  });

  it('request schemas apply the legacy alias and validate the funding', () => {
    expect(createTreeRequestSchema.parse({ providerId: 'tangent' })).toMatchObject({
      providerId: 'openrouter',
      funding: 'credit',
    });
    expect(
      createBranchRequestSchema.parse({ fromNodeId: 'n', providerId: 'tangent' }),
    ).toMatchObject({ providerId: 'openrouter', funding: 'credit' });
    expect(reviewRequestSchema.parse({ providerId: 'tangent', model: 'm' })).toEqual({
      providerId: 'openrouter',
      funding: 'credit',
      model: 'm',
    });
    expect(createTreeRequestSchema.safeParse({ funding: 'free' }).success).toBe(false);
  });

  it('accepts backups with or without a branch funding', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const branch = {
      id: 'b',
      treeId: 't',
      parentBranchId: null,
      branchPointNodeId: null,
      contextMode: 'path',
      anchorQuote: null,
      title: 'Main',
      titleSource: 'default',
      isPrivate: false,
      providerId: 'tangent',
      model: 'm',
      createdAt: at,
      updatedAt: at,
    };
    const backup = (b: object) => ({
      format: 'tangent-tree-backup',
      version: 1,
      exportedAt: at,
      tree: {
        id: 't',
        title: 'T',
        systemPrompt: null,
        trunkBranchId: 'b',
        createdAt: at,
        updatedAt: at,
      },
      branches: [b],
      nodes: [],
    });
    expect(treeBackupSchema.safeParse(backup(branch)).success).toBe(true);
    expect(treeBackupSchema.safeParse(backup({ ...branch, funding: 'credit' })).success).toBe(true);
    expect(treeBackupSchema.safeParse(backup({ ...branch, funding: 'nope' })).success).toBe(false);
  });
});
