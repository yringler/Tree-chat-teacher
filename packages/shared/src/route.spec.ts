import { describe, expect, it } from 'vitest';
import { createBranchRequestSchema, createTreeRequestSchema, treeBackupSchema } from './api.js';
import { reviewRequestSchema } from './review.js';
import { parseRouteKey, providerRouteKey, routeKey, sameRoute } from './route.js';

describe('routes (provider + funding)', () => {
  it('keys a route: the provider id for own-key, `@credit` for Tangent credit', () => {
    expect(routeKey({ providerId: 'openrouter' })).toBe('openrouter');
    expect(routeKey({ providerId: 'openrouter', funding: 'own-key' })).toBe('openrouter');
    expect(routeKey({ providerId: 'openrouter', funding: 'credit' })).toBe('openrouter@credit');
    expect(providerRouteKey({ id: 'openrouter', funding: 'credit' })).toBe('openrouter@credit');
    for (const key of ['openrouter', 'openrouter@credit', 'anthropic', 'tangent'])
      expect(routeKey(parseRouteKey(key))).toBe(key);
    expect(sameRoute({ providerId: 'x' }, { providerId: 'x', funding: 'own-key' })).toBe(true);
    expect(sameRoute({ providerId: 'x' }, { providerId: 'x', funding: 'credit' })).toBe(false);
  });

  it('request schemas pass the provider through as named and validate the funding', () => {
    expect(createTreeRequestSchema.parse({ providerId: 'tangent' })).toEqual({
      providerId: 'tangent',
    });
    expect(
      createBranchRequestSchema.parse({ fromNodeId: 'n', providerId: 'openrouter' }),
    ).toMatchObject({ providerId: 'openrouter' });
    expect(reviewRequestSchema.parse({ providerId: 'openrouter', model: 'm' })).toEqual({
      providerId: 'openrouter',
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
      providerId: 'openrouter',
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
