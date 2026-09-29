/**
 * Edge cache for public share responses (PLAN §1 "Public share"). Keys embed
 * the share version so a republish never serves stale content; purge is
 * best-effort because the Cache API is per-colo. Every helper swallows Cache
 * API failures (unavailable on workers.dev / in some test setups): worst case
 * is a cache miss.
 */

export type ShareCacheVariant = 'html' | 'json';

interface WaitUntilCtx {
  waitUntil(promise: Promise<unknown>): void;
}

const CACHE_ORIGIN = 'https://share-cache.internal';

export function shareCacheKey(token: string, version: number, variant: ShareCacheVariant): Request {
  return new Request(`${CACHE_ORIGIN}/${encodeURIComponent(token)}/v${version}/${variant}`);
}

function defaultCache(): Cache | null {
  try {
    const storage = (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches;
    return storage?.default ?? null;
  } catch {
    return null;
  }
}

export async function getCached(key: Request): Promise<Response | null> {
  try {
    const cache = defaultCache();
    if (!cache) return null;
    return (await cache.match(key)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Stores a copy of `response` under `key` for `ttlSeconds`. The Cache-Control
 * header is only set on the cached copy; `response` itself is untouched and
 * still readable by the caller.
 */
export function putCached(
  ctx: WaitUntilCtx,
  key: Request,
  response: Response,
  ttlSeconds: number,
): void {
  try {
    const cache = defaultCache();
    if (!cache || !response.ok) return;
    const copy = new Response(response.clone().body, response);
    copy.headers.set('Cache-Control', `public, max-age=${Math.max(0, Math.floor(ttlSeconds))}`);
    copy.headers.delete('Set-Cookie');
    ctx.waitUntil(cache.put(key, copy).catch(() => undefined));
  } catch {
    // Cache unavailable: nothing to do.
  }
}

/** Best-effort purge of all variants of the given versions in this colo. */
export async function purgeShare(token: string, versions: number[]): Promise<void> {
  try {
    const cache = defaultCache();
    if (!cache) return;
    const variants: ShareCacheVariant[] = ['html', 'json'];
    await Promise.all(
      versions.flatMap((v) =>
        variants.map((variant) =>
          cache.delete(shareCacheKey(token, v, variant)).catch(() => false),
        ),
      ),
    );
  } catch {
    // Ignore: purge is best-effort.
  }
}
