import { createMiddleware } from 'hono/factory';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AppBindings } from '../env.js';
import { apiError } from '../http/errors.js';

/**
 * Cloudflare Access JWT verification (PLAN §6). Every `/api/*` request must
 * carry a valid Access token for our application AUD, even when it reaches
 * the Worker directly on *.workers.dev.
 */

export interface AccessConfig {
  /** `team.cloudflareaccess.com` or `https://team.cloudflareaccess.com` (trailing slash ok). */
  teamDomain: string;
  /** Access application AUD tag. */
  aud: string;
}

export interface AccessIdentity {
  /** null for service-token JWTs, which carry no email. */
  email: string | null;
}

export type JwksGetter = (teamDomain: string) => JWTVerifyGetKey;

export class AccessError extends Error {
  constructor(
    readonly reason: 'missing' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'AccessError';
  }
}

export const ACCESS_HEADER = 'Cf-Access-Jwt-Assertion';
export const ACCESS_COOKIE = 'CF_Authorization';

/** Normalizes to `https://<host>` without trailing slash (the JWT `iss`). */
export function normalizeTeamDomain(teamDomain: string): string {
  let d = teamDomain.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(d)) d = `https://${d}`;
  return d.replace(/^http:\/\//i, 'https://');
}

// One remote JWKS per certs URL per isolate: jose caches keys and handles rotation.
const remoteJwks = new Map<string, JWTVerifyGetKey>();

export const defaultJwksGetter: JwksGetter = (teamDomain) => {
  const url = `${normalizeTeamDomain(teamDomain)}/cdn-cgi/access/certs`;
  let jwks = remoteJwks.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url));
    remoteJwks.set(url, jwks);
  }
  return jwks;
};

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value || null;
    }
  }
  return null;
}

export function extractAccessToken(request: Request): string | null {
  const header = request.headers.get(ACCESS_HEADER)?.trim();
  if (header) return header;
  return readCookie(request.headers.get('Cookie'), ACCESS_COOKIE);
}

/**
 * Verifies the Access JWT on `request`. Throws AccessError('missing') when
 * no token is present and AccessError('invalid') for any verification failure.
 */
export async function verifyAccessJwt(
  request: Request,
  config: AccessConfig,
  jwks?: JWTVerifyGetKey,
): Promise<AccessIdentity> {
  const token = extractAccessToken(request);
  if (!token) throw new AccessError('missing', 'Missing Cloudflare Access token');
  const issuer = normalizeTeamDomain(config.teamDomain);
  try {
    const { payload } = await jwtVerify(token, jwks ?? defaultJwksGetter(issuer), {
      issuer,
      audience: config.aud,
      algorithms: ['RS256'],
      requiredClaims: ['exp'],
    });
    const email =
      typeof payload['email'] === 'string' && payload['email'] ? payload['email'] : null;
    return { email };
  } catch (err) {
    if (err instanceof joseErrors.JOSEError) {
      throw new AccessError('invalid', `Invalid Cloudflare Access token (${err.code})`);
    }
    throw new AccessError('invalid', 'Invalid Cloudflare Access token');
  }
}

export interface AccessMiddlewareOptions {
  /** Test hook: supply a local JWKS instead of fetching the team's certs. */
  getJwks?: JwksGetter;
}

/**
 * Hono middleware for `/api/*`. Fails closed: with no ACCESS_AUD configured,
 * requests are refused unless DEV_ALLOW_NO_AUTH === 'true' (local dev only).
 */
export function accessMiddleware(options: AccessMiddlewareOptions = {}) {
  const getJwks = options.getJwks ?? defaultJwksGetter;
  return createMiddleware<AppBindings>(async (c, next) => {
    const aud = (c.env.ACCESS_AUD ?? '').trim();
    const teamDomain = (c.env.ACCESS_TEAM_DOMAIN ?? '').trim();
    if (!aud) {
      if (c.env.DEV_ALLOW_NO_AUTH === 'true') {
        c.set('identity', { email: null, devMode: true });
        return next();
      }
      return apiError(c, 'internal', 'Cloudflare Access is not configured');
    }
    if (!teamDomain) return apiError(c, 'internal', 'Cloudflare Access is not configured');

    try {
      const { email } = await verifyAccessJwt(c.req.raw, { teamDomain, aud }, getJwks(teamDomain));
      c.set('identity', { email, devMode: false });
    } catch (err) {
      if (err instanceof AccessError) {
        return err.reason === 'missing'
          ? apiError(c, 'unauthorized', err.message)
          : apiError(c, 'forbidden', err.message);
      }
      throw err;
    }
    return next();
  });
}
