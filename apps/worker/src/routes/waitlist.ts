import { ValidationError } from '@tangent/core';
import { API_ROUTES } from '@tangent/shared';
import { Hono } from 'hono';
import { clientIp } from '../auth/account.js';
import { turnstileHostname } from '../auth/auth.js';
import type { AppBindings } from '../env.js';
import { validateJson } from '../http/errors.js';
import { verifyTurnstile } from '../pool/turnstile.js';

/**
 * `POST /api/waitlist`, public: the login page's form while sign-ups are
 * closed. A Turnstile pass is required, as for a magic link (the same widget
 * issues it, so its action isn't pinned). The answer is 204 whether the
 * address was new, already waiting or already a user, so the form can't be
 * used to learn who has an account.
 */
export function waitlistRoutes(): Hono<AppBindings> {
  const r = new Hono<AppBindings>();
  r.post('/', validateJson(API_ROUTES.joinWaitlist), async (c) => {
    const { email, captchaToken } = c.req.valid('json');
    const passed = await verifyTurnstile(c.env, captchaToken, clientIp(c.req.raw.headers), {
      hostname: turnstileHostname(c.env, c.req.raw),
    });
    if (!passed) throw new ValidationError("The human check didn't go through; please try again");
    await c.env.DB.prepare(
      `INSERT INTO waitlist (email, created_at)
       SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM auth_users WHERE email = ?1)
       ON CONFLICT (email) DO NOTHING`,
    )
      .bind(email.toLowerCase(), new Date().toISOString())
      .run();
    return c.body(null, 204);
  });
  return r;
}
