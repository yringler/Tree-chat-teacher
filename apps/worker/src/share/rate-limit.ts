/**
 * Per-IP rate limit for public share routes. Returns true when the request
 * may proceed. A missing binding (e.g. an environment without the rate
 * limiting API) or a limiter failure lets the request through: the share
 * routes are read-only and still check revocation on every request.
 */
export async function checkShareRateLimit(
  env: { SHARE_RATE_LIMITER?: RateLimit | undefined },
  request: Request,
): Promise<boolean> {
  const limiter = env.SHARE_RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') return true;
  const key = request.headers.get('CF-Connecting-IP')?.trim() || 'anon';
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch (err) {
    console.warn('Share rate limiter failed; allowing request', err);
    return true;
  }
}
