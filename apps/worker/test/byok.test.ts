import type { KeyStatusResponse, ProviderInfo, StreamEvent, TreeDetail } from '@tangent/shared';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEY_COOKIE_NAME } from '../src/byok/keys.js';
import { open, seal, SealConfigError, UnsealError } from '../src/byok/seal.js';
import { client } from './session-client.js';
import { BASE, call as callWorker, type CallInit, ok, parseSse } from './http.js';

const SECRET = env.KEY_ENCRYPTION_SECRET;
const OTHER_SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

/** `cookie`: the key cookie's sealed value. */
function call(path: string, init: CallInit & { cookie?: string } = {}): Promise<Response> {
  const { cookie, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (cookie !== undefined) headers.set('Cookie', `${KEY_COOKIE_NAME}=${cookie}`);
  return callWorker(path, { ...rest, headers });
}

function setCookieOf(res: Response): string | null {
  return res.headers.get('Set-Cookie');
}

/** The sealed value from a Set-Cookie header. */
function sealedFrom(res: Response): string {
  const header = setCookieOf(res);
  const m = header && new RegExp(`^${KEY_COOKIE_NAME}=([^;]*)`).exec(header);
  if (!m?.[1]) throw new Error(`no key cookie in ${header}`);
  return m[1];
}

async function saveKey(apiKey: string, provider = 'ant'): Promise<string> {
  const res = await call('/api/key', { method: 'POST', json: { provider, apiKey } });
  expect(res.status, await res.clone().text()).toBe(204);
  return sealedFrom(res);
}

async function antTree(): Promise<TreeDetail> {
  return ok<TreeDetail>(
    await call('/api/trees', { method: 'POST', json: { title: 'BYOK', providerId: 'ant' } }),
    201,
  );
}

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;

describe('seal / open', () => {
  it('round-trips with a version prefix and a fresh IV each time', async () => {
    const a = await seal('hello', SECRET);
    const b = await seal('hello', SECRET);
    expect(a.startsWith('v1.')).toBe(true);
    expect(a).not.toBe(b);
    expect(await open(a, SECRET)).toBe('hello');
    expect(a).not.toContain('hello');
  });

  it('rejects tampering, other versions, garbage and a rotated secret', async () => {
    const sealed = await seal('secret payload', SECRET);
    const payload = sealed.slice(3);
    for (const i of [0, 5, 20, payload.length - 2]) {
      const c = payload[i] === 'A' ? 'B' : 'A';
      await expect(
        open(`v1.${payload.slice(0, i)}${c}${payload.slice(i + 1)}`, SECRET),
      ).rejects.toBeInstanceOf(UnsealError);
    }
    await expect(open(`v2.${payload}`, SECRET)).rejects.toBeInstanceOf(UnsealError);
    await expect(open('v1.!!!', SECRET)).rejects.toBeInstanceOf(UnsealError);
    await expect(open('v1.AAAA', SECRET)).rejects.toBeInstanceOf(UnsealError);
    await expect(open(sealed, OTHER_SECRET)).rejects.toBeInstanceOf(UnsealError);
  });

  it('refuses a secret that is not 32 bytes of base64', async () => {
    await expect(seal('x', btoa('short'))).rejects.toBeInstanceOf(SealConfigError);
    await expect(seal('x', 'not base64 at all!')).rejects.toBeInstanceOf(SealConfigError);
  });
});

describe('bring-your-own-key API', () => {
  afterEach(() => vi.restoreAllMocks());

  it('status: enabled, no key', async () => {
    expect(await ok<KeyStatusResponse>(await call('/api/key/status'), 200)).toEqual({
      enabled: true,
      hasKey: false,
      providers: [],
    });
  });

  it('stores a verified key in a sealed __Host- HttpOnly cookie and never returns it', async () => {
    const apiKey = 'sk-ant-good-alpha-0123456789';
    const res = await call('/api/key', { method: 'POST', json: { provider: 'ant', apiKey } });
    expect(res.status).toBe(204);
    const header = setCookieOf(res)!;
    expect(header).toMatch(new RegExp(`^${KEY_COOKIE_NAME}=v1\\.[A-Za-z0-9_-]+;`));
    expect(header).toContain('Max-Age=604800');
    expect(header).toContain('Path=/');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Strict');
    expect(header).not.toContain(apiKey);
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    const sealed = sealedFrom(res);
    const status = await call('/api/key/status', { cookie: sealed });
    const text = await status.text();
    expect(JSON.parse(text)).toEqual({ enabled: true, hasKey: true, providers: ['ant'] });
    expect(text).not.toContain('alpha');

    const providers = await ok<ProviderInfo[]>(
      await call('/api/providers', { cookie: sealed }),
      200,
    );
    expect(providers.find((p) => p.id === 'ant')).toMatchObject({
      available: true,
      keySource: 'user',
      acceptsUserKey: true,
    });
    expect(JSON.stringify(providers)).not.toContain('alpha');
  });

  it('rejects bad input before sealing anything', async () => {
    const cases: [unknown, number][] = [
      [{ provider: 'ant', apiKey: 'sk-ant-bad-0123456789abcdef' }, 400], // upstream says 401
      [{ provider: 'ant', apiKey: 'short' }, 400],
      [{ provider: 'ant', apiKey: 'has spaces in it 0123456789' }, 400],
      [{ provider: 'fake', apiKey: 'sk-ant-good-0123456789abc' }, 400],
      [{ provider: 'nope', apiKey: 'sk-ant-good-0123456789abc' }, 400],
      [{ provider: 'ant' }, 400],
    ];
    for (const [json, status] of cases) {
      const res = await call('/api/key', { method: 'POST', json });
      expect(res.status, JSON.stringify(json)).toBe(status);
      expect(setCookieOf(res)).toBeNull();
    }
  });

  it('CSRF: requires a JSON content type and a same-origin fetch', async () => {
    const form = await call('/api/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'provider=ant&apiKey=sk-ant-good-0123456789abc',
    });
    expect(form.status).toBe(400);
    expect(setCookieOf(form)).toBeNull();

    for (const site of ['cross-site', 'same-site']) {
      const res = await call('/api/key', {
        method: 'POST',
        headers: { 'Sec-Fetch-Site': site },
        json: { provider: 'ant', apiKey: 'sk-ant-good-0123456789abc' },
      });
      expect(res.status).toBe(403);
      expect(setCookieOf(res)).toBeNull();
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
    const ok = await call('/api/key', {
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'same-origin' },
      json: { provider: 'ant', apiKey: 'sk-ant-good-0123456789abc' },
    });
    expect(ok.status).toBe(204);
  });

  it('streams a reply through the proxy using the key from the cookie', async () => {
    const sealed = await saveKey('sk-ant-good-bravo-0123456789');
    const tree = await antTree();
    const res = await call(`/api/branches/${tree.tree.trunkBranchId}/messages`, {
      method: 'POST',
      json: { content: 'hi' },
      cookie: sealed,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    const events = parseSse(await res.text());
    expect(events.at(-1)?.type).toBe('done');
    const text = events.map((e) => (e.type === 'delta' ? e.text : '')).join('');
    expect(text).toBe('key=-bravo-0123456789');
  });

  it('401 key_required without a key, with a tampered cookie, and after the secret rotates', async () => {
    const tree = await antTree();
    const send = (cookie?: string) =>
      call(`/api/branches/${tree.tree.trunkBranchId}/messages`, {
        method: 'POST',
        json: { content: 'hi' },
        ...(cookie !== undefined ? { cookie } : {}),
      });

    const none = await send();
    expect(none.status).toBe(401);
    expect(await errorCode(none)).toBe('key_required');

    const sealed = await saveKey('sk-ant-good-charlie-0123456789');
    const tampered = `${sealed.slice(0, -3)}${sealed.endsWith('AAA') ? 'BBB' : 'AAA'}`;
    const bad = await send(tampered);
    expect(bad.status).toBe(401);
    expect(await errorCode(bad)).toBe('key_required');
    expect(setCookieOf(bad)).toMatch(new RegExp(`^${KEY_COOKIE_NAME}=;.*Max-Age=0`));

    // Same payload shape, sealed with a different (rotated) secret.
    const rotated = await seal(
      JSON.stringify({
        keys: { ant: 'sk-ant-good-x-0123456789' },
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
      OTHER_SECRET,
    );
    const old = await send(rotated);
    expect(old.status).toBe(401);
    expect(await errorCode(old)).toBe('key_required');
    const status = await call('/api/key/status', { cookie: rotated });
    expect(setCookieOf(status)).toMatch(/Max-Age=0/);
    expect(((await status.json()) as KeyStatusResponse).hasKey).toBe(false);

    // Expired payload (server-side expiry, independent of the browser's Max-Age).
    const expired = await seal(
      JSON.stringify({ keys: { ant: 'sk-ant-good-x-0123456789' }, exp: 1 }),
      SECRET,
    );
    expect((await send(expired)).status).toBe(401);

    // Garbage never produces a 500.
    for (const junk of ['v1.', 'v1.AAAA', 'garbage', 'v2.abc']) {
      expect((await send(junk)).status).toBe(401);
    }
  });

  it('renews the cookie when it is used and more than a day old', async () => {
    const tree = await antTree();
    const now = Math.floor(Date.now() / 1000);
    const aging = await seal(
      JSON.stringify({
        keys: { ant: 'sk-ant-good-echo-0123456789' },
        exp: now + 2 * 86400,
        uid: null,
      }),
      SECRET,
    );
    for (const res of [
      await call('/api/key/status', { cookie: aging }),
      await call(`/api/branches/${tree.tree.trunkBranchId}/messages`, {
        method: 'POST',
        json: { content: 'hi' },
        cookie: aging,
      }),
    ]) {
      expect(res.status).toBeLessThan(300);
      await res.text();
      expect(setCookieOf(res)).toContain('Max-Age=604800');
      const renewed = JSON.parse(await open(sealedFrom(res), SECRET)) as { exp: number };
      expect(renewed.exp).toBeGreaterThanOrEqual(now + 604800);
    }

    // A cookie under a day old is left alone, so most requests set no cookie.
    const fresh = await saveKey('sk-ant-good-echo-0123456789');
    const status = await call('/api/key/status', { cookie: fresh });
    expect(status.status).toBe(200);
    expect(setCookieOf(status)).toBeNull();
  });

  it('forgets a key', async () => {
    const sealed = await saveKey('sk-ant-good-delta-0123456789');
    const res = await call('/api/key', {
      method: 'DELETE',
      json: { provider: 'ant' },
      cookie: sealed,
    });
    expect(res.status).toBe(204);
    expect(setCookieOf(res)).toMatch(new RegExp(`^${KEY_COOKIE_NAME}=;.*Max-Age=0`));

    const all = await call('/api/key', { method: 'DELETE', json: {}, cookie: sealed });
    expect(all.status).toBe(204);
    expect(setCookieOf(all)).toMatch(/Max-Age=0/);

    const noType = await call('/api/key', { method: 'DELETE', cookie: sealed });
    expect(noType.status).toBe(400);
  });

  it('only allow-listed models are proxied', async () => {
    const sealed = await saveKey('sk-ant-good-echo-0123456789');
    const tree = await antTree();
    await ok(
      await call(`/api/branches/${tree.tree.trunkBranchId}`, {
        method: 'PATCH',
        json: { model: 'claude-expensive' },
      }),
      200,
    );
    const res = await call(`/api/branches/${tree.tree.trunkBranchId}/messages`, {
      method: 'POST',
      json: { content: 'hi' },
      cookie: sealed,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('not enabled');
  });

  it('rate-limits generation per key cookie', async () => {
    const sealed = await saveKey('sk-ant-good-foxtrot-0123456789');
    const tree = await antTree();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await call(`/api/branches/${tree.tree.trunkBranchId}/context?resolve=true`, {
        cookie: sealed,
      });
      statuses.push(res.status);
      await res.text();
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });

  it('cancelling a generation aborts the upstream request', async () => {
    const sealed = await saveKey('sk-ant-good-golf-slow');
    const tree = await antTree();
    const res = await call(`/api/branches/${tree.tree.trunkBranchId}/messages`, {
      method: 'POST',
      json: { content: 'long please' },
      cookie: sealed,
    });
    const reader = res.body!.getReader();
    let buf = '';
    let start: StreamEvent | undefined;
    while (!start) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('stream ended early');
      buf += new TextDecoder().decode(chunk.value);
      start = parseSse(buf).find((e) => e.type === 'start');
    }
    if (start.type !== 'start') throw new Error('expected start');
    expect(
      (await call(`/api/nodes/${start.assistantNode.id}/cancel`, { method: 'POST' })).status,
    ).toBe(204);
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += new TextDecoder().decode(chunk.value);
    }
    const last = parseSse(buf).at(-1);
    expect(last).toMatchObject({ type: 'error', message: 'Cancelled' });
    const text = parseSse(buf)
      .map((e) => (e.type === 'delta' ? e.text : ''))
      .join('');
    expect(text.length).toBeLessThan(200);
  });

  it('logs no key material during a full session', async () => {
    const logged: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(
          args
            .map((a) => (a instanceof Error ? `${a.message} ${a.stack ?? ''}` : String(a)))
            .join(' '),
        );
      });
    }
    const apiKey = 'sk-ant-good-hotel-0123456789';
    const sealed = await saveKey(apiKey);
    const tree = await antTree();
    await (
      await call(`/api/branches/${tree.tree.trunkBranchId}/messages`, {
        method: 'POST',
        json: { content: 'hi' },
        cookie: sealed,
      })
    ).text();
    await (
      await call(`/api/branches/${tree.tree.trunkBranchId}/messages`, {
        method: 'POST',
        json: { content: 'hi' },
        cookie: 'v1.tampered',
      })
    ).text();
    await (
      await call('/api/key', {
        method: 'POST',
        json: { provider: 'ant', apiKey: 'sk-ant-bad-hotel-0123456789' },
      })
    ).text();
    await (await call('/api/key', { method: 'DELETE', json: {}, cookie: sealed })).text();
    const all = logged.join('\n');
    expect(all).not.toContain('hotel');
    expect(all).not.toContain(sealed);
  });
});

describe('the key cookie belongs to its user', () => {
  let seq = 0;
  const email = () => `byok${++seq}-${Math.random().toString(36).slice(2, 8)}@example.org`;
  const apiKey = 'sk-ant-good-owner-0123456789';

  /** A browser signed in as a fresh user, holding a saved `ant` key. */
  async function withSavedKey() {
    const browser = client();
    await browser.signIn(email());
    const saved = await browser.call('/api/key', {
      method: 'POST',
      json: { provider: 'ant', apiKey },
    });
    expect(saved.status, await saved.clone().text()).toBe(204);
    const status = await ok<KeyStatusResponse>(await browser.call('/api/key/status'), 200);
    expect(status.hasKey).toBe(true);
    return browser;
  }

  it('is cleared, never used, when another user signs in on the same browser', async () => {
    const browser = await withSavedKey();
    // The first user's session lapses without a sign-out; the next one signs in here.
    await browser.signIn(email());
    const tree = await ok<TreeDetail>(
      await browser.call('/api/trees', { method: 'POST', json: { title: 'T', providerId: 'ant' } }),
      201,
    );
    const send = await browser.call(`/api/branches/${tree.tree.trunkBranchId}/messages`, {
      method: 'POST',
      json: { content: 'hi' },
    });
    expect(send.status).toBe(401);
    expect(await errorCode(send)).toBe('key_required');
    expect(setCookieOf(send)).toMatch(new RegExp(`^${KEY_COOKIE_NAME}=;.*Max-Age=0`));
    const status = await ok<KeyStatusResponse>(await browser.call('/api/key/status'), 200);
    expect(status.hasKey).toBe(false);
  });

  it('is cleared by signing out', async () => {
    const browser = await withSavedKey();
    const out = await browser.call('/api/auth/sign-out', {
      method: 'POST',
      headers: { origin: BASE },
    });
    expect(out.status).toBe(200);
    expect(
      out.headers
        .getSetCookie()
        .some((c) => c.startsWith(`${KEY_COOKIE_NAME}=;`) && /Max-Age=0/i.test(c)),
    ).toBe(true);
  });
});
