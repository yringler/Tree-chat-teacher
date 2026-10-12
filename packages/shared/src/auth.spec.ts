import { describe, expect, it } from 'vitest';
import { loginUrl, RETURN_TO_PARAM, safeReturnPath } from './auth.js';

describe('safeReturnPath', () => {
  it('keeps a same-origin path with its query and hash', () => {
    expect(safeReturnPath('/')).toBe('/');
    expect(safeReturnPath('/learn/t/abc')).toBe('/learn/t/abc');
    expect(safeReturnPath('/learn/t/abc/b/b1?x=1&y=a%20b#n_2')).toBe(
      '/learn/t/abc/b/b1?x=1&y=a%20b#n_2',
    );
    expect(safeReturnPath('/delete-account?from=email')).toBe('/delete-account?from=email');
    // An encoded slash in the query is data, not a path separator.
    expect(safeReturnPath('/login?returnTo=%2Flearn%2F')).toBe('/login?returnTo=%2Flearn%2F');
  });

  it('refuses anything that could leave the origin', () => {
    for (const raw of [
      '//evil.example',
      '//evil.example/learn/',
      '/\\evil.example',
      '/learn\\..\\..\\evil',
      'https://evil.example/',
      'http://tangent.example.com/learn/',
      'javascript:alert(1)',
      'data:text/html,hi',
      'learn/t/abc',
      './learn/',
      '?x=1',
      '#top',
      ' /learn/',
      '/%2F%2Fevil.example',
      '/%2fevil.example',
      '/%5Cevil.example',
    ]) {
      expect(safeReturnPath(raw), raw).toBeNull();
    }
  });

  it('refuses control characters, which URL parsers drop or treat as separators', () => {
    for (const raw of [
      '/\t/evil.example',
      '/\n/evil.example',
      '/learn/\r',
      '/a\u0000',
      '/a\u007f',
      '/a\u0085',
    ]) {
      expect(safeReturnPath(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it('refuses empty, missing, non-string and overlong input', () => {
    expect(safeReturnPath('')).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath(undefined)).toBeNull();
    expect(safeReturnPath(42)).toBeNull();
    expect(safeReturnPath(`/${'a'.repeat(4096)}`)).toBeNull();
  });
});

describe('loginUrl', () => {
  it('carries a safe return target as returnTo', () => {
    expect(RETURN_TO_PARAM).toBe('returnTo');
    expect(loginUrl('/learn/login', { returnTo: '/learn/t/abc?x=1#n_2' })).toBe(
      '/learn/login?returnTo=%2Flearn%2Ft%2Fabc%3Fx%3D1%23n_2',
    );
  });

  it('drops an unsafe one and keeps an error code', () => {
    expect(loginUrl('/login', { returnTo: '//evil.example' })).toBe('/login');
    expect(loginUrl('/login', {})).toBe('/login');
    expect(loginUrl('/login', { returnTo: '/admin/', error: 'not_allowed' })).toBe(
      '/login?error=not_allowed&returnTo=%2Fadmin%2F',
    );
  });
});
