import { escapeHtml, renderViewerPage, viewerCsp } from '@tangent/render';
import type { SharePayload } from '@tangent/shared';
import { Hono, type Context } from 'hono';
import type { AppBindings } from '../env.js';
import { getCached, putCached, shareCacheKey, type ShareCacheVariant } from '../share/cache.js';
import { checkShareRateLimit } from '../share/rate-limit.js';
import { userIdOfAccount } from '../auth/account.js';
import { canShare } from '../availability.js';
import { shareService } from '../registries.js';

const SNAPSHOT_TTL_SECONDS = 86_400;

/**
 * Public, read-only share routes. They never look at the session and serve
 * no identity, only allow-listed DTOs. While sharing is off (`sharingEnabled`)
 * a link opens only if its owner may share (`canShare`: an admin or a user the
 * operator allowed); every other one is 404. Validity (revoked/expired) and
 * that permission are checked against D1 on every request, before the edge
 * cache, so revoking either takes the link down at once; only snapshot
 * rendering is edge-cached, under a key that includes the share version.
 */
export function shareRoutes(): Hono<AppBindings> {
  const s = new Hono<AppBindings>();
  s.get('/:token/data.json', (c) => serve(c, c.req.param('token'), 'json'));
  s.get('/:token', (c) => serve(c, c.req.param('token'), 'html'));
  return s;
}

async function serve(
  c: Context<AppBindings>,
  token: string,
  variant: ShareCacheVariant,
): Promise<Response> {
  if (!(await checkShareRateLimit(c.env, c.req.raw))) {
    return statusPage(variant, 429, 'Too many requests', 'Please try again in a minute.', {
      'Retry-After': '60',
    });
  }
  const shares = shareService(c.env, c.req.url);
  const check = await shares.checkPublic(token);
  if (!check.ok) {
    return check.reason === 'gone'
      ? statusPage(
          variant,
          410,
          'Link no longer available',
          'This shared conversation was revoked or has expired.',
        )
      : statusPage(variant, 404, 'Not found', 'There is no shared conversation at this address.');
  }
  const { share } = check;
  // Sharing off (no DMCA agent registered): only the links of owners who may share open,
  // old ones included (no query while sharing is on). Checked before the cache: a cached
  // snapshot outlives the permission.
  if (!(await canShare(c.env, userIdOfAccount(share.accountId)))) {
    return statusPage(
      variant,
      404,
      'Not found',
      'Shared conversations are not available on this site.',
    );
  }
  if (variant === 'html') {
    c.executionCtx.waitUntil(shares.recordView(share.id).catch(() => undefined));
  }

  const cacheable = share.mode === 'snapshot';
  const key = shareCacheKey(token, share.version, variant);
  if (cacheable) {
    const hit = await getCached(key);
    if (hit) return withPublicHeaders(hit, variant, true);
  }

  const resolved = await shares.resolvePublic(token);
  if (!resolved.ok) {
    return statusPage(
      variant,
      410,
      'Link no longer available',
      'This shared conversation is no longer available.',
    );
  }
  const response =
    variant === 'json'
      ? Response.json(resolved.payload)
      : await htmlResponse(resolved.payload, new URL(`/s/${token}`, c.req.url).toString());
  const out = withPublicHeaders(response, variant, false);
  if (cacheable) putCached(c.executionCtx, key, out, SNAPSHOT_TTL_SECONDS);
  return out;
}

async function htmlResponse(payload: SharePayload, url: string): Promise<Response> {
  const csp = await viewerCsp();
  const html = renderViewerPage(payload, { variant: 'share', url, csp });
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp },
  });
}

/** Security headers. Browsers must not cache: revocation is checked per request. */
function withPublicHeaders(res: Response, variant: ShareCacheVariant, cacheHit: boolean): Response {
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'no-store');
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Referrer-Policy', 'no-referrer');
  out.headers.set('X-Robots-Tag', 'noindex, nofollow');
  out.headers.set('X-Frame-Options', 'DENY');
  out.headers.set('X-Share-Cache', cacheHit ? 'HIT' : 'MISS');
  if (variant === 'json') out.headers.set('Content-Type', 'application/json; charset=utf-8');
  return out;
}

function statusPage(
  variant: ShareCacheVariant,
  status: number,
  title: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  const common = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', ...headers };
  if (variant === 'json') {
    const code = status === 429 ? 'rate_limited' : status === 410 ? 'gone' : 'not_found';
    return Response.json({ error: { code, message } }, { status, headers: common });
  }
  const body =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">` +
    `<title>${escapeHtml(title)}</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem">` +
    `<h1 style="font-size:1.4rem">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
  return new Response(body, {
    status,
    headers: {
      ...common,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
