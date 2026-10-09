import { MODE_HEADER, PAYMENT_HEADER, type LearnPayment } from '@tangent/shared';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import { createApp } from '../src/app.js';
import { REMEMBER_COOKIE } from '../src/auth/auth.js';
import type { EmailMessage, EmailSender } from '../src/email/index.js';
import type { AppEnv } from '../src/env.js';
import { BASE } from './http.js';

/**
 * Signed-in browsers for the suites that need real sessions (multi-user,
 * admin): auth configured as in production, magic links captured in memory.
 */

export class CapturingSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

/** Auth configured as in production: open sign-up, the fake payment provider and the fake built-in provider from vitest.config.ts. */
export function authEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    ...env,
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-0123',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    TURNSTILE_SITE_KEY: 'site-key',
    ...overrides,
  } as AppEnv;
}

export type CallInit = RequestInit & { json?: unknown; learn?: LearnPayment };

let ipSeq = 0;

/**
 * A browser: its own IP (Better Auth rate limits are per IP; `opts.ip` shares
 * one between browsers) and cookie jar. `learn` sends the request as Tangent
 * Learn does (mode and payment headers); without it the request is the power app's.
 */
export function client(e: AppEnv = authEnv(), opts: { ip?: string } = {}) {
  const mail = new CapturingSender();
  const app = createApp({ auth: { emailSender: mail } });
  const ip = opts.ip ?? `198.51.100.${++ipSeq}`;
  const jar = new Map<string, string>();
  const keep = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0]!;
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      if (eq === pair.length - 1 || /Max-Age=0/i.test(c)) jar.delete(name);
      else jar.set(name, pair.slice(eq + 1));
    }
  };
  const call = async (path: string, init: CallInit = {}, as: AppEnv = e) => {
    const { json, learn, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set('cf-connecting-ip', ip);
    if (jar.size > 0 && !headers.has('cookie')) {
      headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    }
    if (json !== undefined) headers.set('content-type', 'application/json');
    if (learn) {
      headers.set(MODE_HEADER, 'simple');
      headers.set(PAYMENT_HEADER, learn);
    }
    const ctx = createExecutionContext();
    const res = await app.request(
      `${BASE}${path}`,
      { ...rest, headers, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) },
      as,
      ctx,
    );
    // Read the body before waiting: a streamed response only finishes once consumed.
    const text = await res.text();
    await waitOnExecutionContext(ctx);
    keep(res);
    const nullBody = [101, 204, 205, 304].includes(res.status);
    return new Response(nullBody ? null : text, { status: res.status, headers: res.headers });
  };
  const signIn = async (email: string) => {
    const res = await call('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { origin: BASE, 'x-captcha-response': 'pass' },
      json: { email, callbackURL: '/', errorCallbackURL: '/login' },
    });
    expect(res.status).toBe(200);
    const message = mail.sent.at(-1)!;
    const link = new URL(/https?:\/\/\S+/.exec(message.text)![0]);
    await call(link.pathname + link.search, {
      headers: { cookie: `${REMEMBER_COOKIE}=1` },
      redirect: 'manual',
    });
  };
  return { call, signIn, mail, env: e, ip };
}
