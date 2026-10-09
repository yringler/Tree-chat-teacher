import { describe, expect, it } from 'vitest';
import { API_ROUTES, matchRoute, ROUTE_NAMES, routeUrl } from './api-routes.js';

describe('the API route table', () => {
  it('names every route once, by method and path', () => {
    expect(ROUTE_NAMES).toEqual(Object.keys(API_ROUTES));
    const keys = Object.values(API_ROUTES).map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('builds a URL with encoded parameters and the given query, leaving out absent values', () => {
    expect(routeUrl(API_ROUTES.commitCandidate, { branchId: 'b 1', candidateId: 'c/1' })).toBe(
      '/api/branches/b%201/candidates/c%2F1/commit',
    );
    expect(
      routeUrl(API_ROUTES.usage, {}, { cursor: 'c 1/2', limit: 20, other: null, none: undefined }),
    ).toBe('/api/billing/usage?cursor=c+1%2F2&limit=20');
    expect(() => routeUrl(API_ROUTES.getTree)).toThrow(/:treeId/);
  });

  it("matches a path to a route's parameters, decoded", () => {
    expect(
      matchRoute(API_ROUTES.commitCandidate, '/api/branches/b%201/candidates/c%2F1/commit'),
    ).toEqual({ branchId: 'b 1', candidateId: 'c/1' });
    expect(matchRoute(API_ROUTES.listTrees, '/api/trees')).toEqual({});
    expect(matchRoute(API_ROUTES.getTree, '/api/trees/t/backup')).toBeNull();
    expect(matchRoute(API_ROUTES.getTree, '/api/trees/')).toBeNull();
  });
});
