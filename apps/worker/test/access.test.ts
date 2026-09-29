import { env, exports } from 'cloudflare:workers';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWTVerifyGetKey,
} from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  AccessError,
  extractAccessToken,
  normalizeTeamDomain,
  verifyAccessJwt,
} from '../src/auth/access.js';
import type { AppEnv } from '../src/env.js';

const TEAM = 'https://tangent-test.cloudflareaccess.com';
const AUD = 'aud-tag-123';

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  const other = await generateKeyPair('RS256');
  otherPrivateKey = other.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] });
});

interface TokenOpts {
  aud?: string;
  iss?: string;
  exp?: number | string;
  email?: string | null;
  key?: CryptoKey;
}

async function token(opts: TokenOpts = {}): Promise<string> {
  const claims: Record<string, unknown> = {};
  if (opts.email !== null) claims['email'] = opts.email ?? 'owner@example.com';
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuedAt()
    .setIssuer(opts.iss ?? TEAM)
    .setAudience(opts.aud ?? AUD)
    .setSubject('user-1')
    .setExpirationTime(opts.exp ?? '5m')
    .sign(opts.key ?? privateKey);
}

function req(headers: Record<string, string> = {}): Request {
  return new Request('https://tangent.example.com/api/me', { headers });
}

const config = { teamDomain: TEAM, aud: AUD };

async function rejection(p: Promise<unknown>): Promise<AccessError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AccessError);
  return err as AccessError;
}

describe('normalizeTeamDomain', () => {
  it('accepts bare hosts and full URLs, strips trailing slashes', () => {
    expect(normalizeTeamDomain('team.cloudflareaccess.com')).toBe(
      'https://team.cloudflareaccess.com',
    );
    expect(normalizeTeamDomain('https://team.cloudflareaccess.com/')).toBe(
      'https://team.cloudflareaccess.com',
    );
    expect(normalizeTeamDomain(' https://team.cloudflareaccess.com// ')).toBe(
      'https://team.cloudflareaccess.com',
    );
  });
});

describe('verifyAccessJwt', () => {
  it('accepts a valid token from the header', async () => {
    const t = await token();
    await expect(
      verifyAccessJwt(req({ 'Cf-Access-Jwt-Assertion': t }), config, jwks),
    ).resolves.toEqual({
      email: 'owner@example.com',
    });
  });

  it('accepts a bare team domain in config', async () => {
    const t = await token();
    const res = await verifyAccessJwt(
      req({ 'Cf-Access-Jwt-Assertion': t }),
      { teamDomain: 'tangent-test.cloudflareaccess.com/', aud: AUD },
      jwks,
    );
    expect(res.email).toBe('owner@example.com');
  });

  it('returns email null for tokens without email (service tokens)', async () => {
    const t = await token({ email: null });
    expect(await verifyAccessJwt(req({ 'Cf-Access-Jwt-Assertion': t }), config, jwks)).toEqual({
      email: null,
    });
  });

  it('falls back to the CF_Authorization cookie', async () => {
    const t = await token();
    const r = req({ Cookie: `theme=dark; CF_Authorization=${t}; other=1` });
    expect(extractAccessToken(r)).toBe(t);
    expect((await verifyAccessJwt(r, config, jwks)).email).toBe('owner@example.com');
  });

  it('rejects a missing token as missing', async () => {
    expect((await rejection(verifyAccessJwt(req(), config, jwks))).reason).toBe('missing');
    expect((await rejection(verifyAccessJwt(req({ Cookie: 'a=b' }), config, jwks))).reason).toBe(
      'missing',
    );
  });

  it.each([
    ['wrong audience', { aud: 'someone-else' }],
    ['wrong issuer', { iss: 'https://evil.cloudflareaccess.com' }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 600 }],
  ] as const)('rejects %s as invalid', async (_name, opts) => {
    const t = await token(opts);
    const err = await rejection(
      verifyAccessJwt(req({ 'Cf-Access-Jwt-Assertion': t }), config, jwks),
    );
    expect(err.reason).toBe('invalid');
  });

  it('rejects a token signed by an unknown key and garbage tokens', async () => {
    const t = await token({ key: otherPrivateKey });
    expect(
      (await rejection(verifyAccessJwt(req({ 'Cf-Access-Jwt-Assertion': t }), config, jwks)))
        .reason,
    ).toBe('invalid');
    expect(
      (
        await rejection(
          verifyAccessJwt(req({ 'Cf-Access-Jwt-Assertion': 'not.a.jwt' }), config, jwks),
        )
      ).reason,
    ).toBe('invalid');
  });
});

describe('accessMiddleware via the Hono app', () => {
  const app = createApp({ access: { getJwks: () => jwks } });
  const configured = {
    ...env,
    ACCESS_AUD: AUD,
    ACCESS_TEAM_DOMAIN: TEAM,
    DEV_ALLOW_NO_AUTH: '',
  } as AppEnv;

  async function call(e: AppEnv, headers: Record<string, string> = {}) {
    const res = await app.request('/api/me', { headers }, e);
    return { status: res.status, body: (await res.json()) as unknown };
  }

  it('200 with identity for a valid token', async () => {
    const t = await token();
    expect(await call(configured, { 'Cf-Access-Jwt-Assertion': t })).toEqual({
      status: 200,
      body: { email: 'owner@example.com', devMode: false },
    });
  });

  it('200 via cookie fallback', async () => {
    const t = await token();
    expect((await call(configured, { Cookie: `CF_Authorization=${t}` })).status).toBe(200);
  });

  it('401 when the token is missing', async () => {
    expect(await call(configured)).toEqual({
      status: 401,
      body: { error: { code: 'unauthorized', message: expect.any(String) as unknown } },
    });
  });

  it('403 for wrong aud / wrong iss / expired', async () => {
    for (const opts of [
      { aud: 'x' },
      { iss: 'https://other.cloudflareaccess.com' },
      { exp: Math.floor(Date.now() / 1000) - 60 },
    ]) {
      const t = await token(opts);
      const r = await call(configured, { 'Cf-Access-Jwt-Assertion': t });
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ error: { code: 'forbidden' } });
    }
  });

  it('fails closed with 500 when ACCESS_AUD is empty and no dev bypass', async () => {
    const t = await token();
    for (const dev of ['', 'false', '1', 'TRUE']) {
      const r = await call({ ...configured, ACCESS_AUD: '', DEV_ALLOW_NO_AUTH: dev } as AppEnv, {
        'Cf-Access-Jwt-Assertion': t,
      });
      expect(r).toEqual({
        status: 500,
        body: { error: { code: 'internal', message: 'Cloudflare Access is not configured' } },
      });
    }
  });

  it('fails closed when AUD is set but the team domain is missing', async () => {
    const t = await token();
    const r = await call({ ...configured, ACCESS_TEAM_DOMAIN: '' } as AppEnv, {
      'Cf-Access-Jwt-Assertion': t,
    });
    expect(r.status).toBe(500);
  });

  it('dev bypass only applies when ACCESS_AUD is empty', async () => {
    const dev = await call({ ...configured, ACCESS_AUD: '', DEV_ALLOW_NO_AUTH: 'true' } as AppEnv);
    expect(dev).toEqual({ status: 200, body: { email: null, devMode: true } });

    // AUD configured: DEV_ALLOW_NO_AUTH is ignored and a token is required.
    const r = await call({ ...configured, DEV_ALLOW_NO_AUTH: 'true' } as AppEnv);
    expect(r.status).toBe(401);
  });

  it('unknown /api routes still require auth; after auth they 404 as ApiError', async () => {
    expect((await app.request('/api/nope', {}, configured)).status).toBe(401);
    const t = await token();
    const res = await app.request(
      '/api/nope',
      { headers: { 'Cf-Access-Jwt-Assertion': t } },
      configured,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});

describe('deployed Worker entrypoint', () => {
  it('serves /api/me in dev-bypass mode (test config: AUD empty, DEV_ALLOW_NO_AUTH=true)', async () => {
    const res = await exports.default.fetch('https://tangent.example.com/api/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: null, devMode: true });
  });
});
