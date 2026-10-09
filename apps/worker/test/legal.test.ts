import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppBindings, AppEnv } from '../src/env.js';
import { landingRoutes } from '../src/http/landing.js';
import { LEGAL_STYLE, legalRoutes } from '../src/http/legal.js';
import { BASE } from './http.js';

function setup(overrides: Partial<AppEnv> = {}) {
  const app = new Hono<AppBindings>();
  app.route('/', legalRoutes());
  app.route('/', landingRoutes());
  const e = { ...env, BETTER_AUTH_SECRET: 'secret', ...overrides } as AppEnv;
  return (path: string) => app.request(`${BASE}${path}`, {}, e);
}

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

describe('legal pages', () => {
  for (const [path, heading] of [
    ['/privacy', 'Privacy policy'],
    ['/terms', 'Terms of service'],
  ] as const) {
    it(`${path} is a public, script-free page allowed only its own stylesheet`, async () => {
      const res = await setup()(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      const csp = res.headers.get('Content-Security-Policy')!;
      expect(csp).toContain(`style-src 'sha256-${await sha256Base64(LEGAL_STYLE)}'`);
      expect(csp).toContain("default-src 'none'");
      const html = await res.text();
      expect(html).toContain(`<h1>${heading}</h1>`);
      expect(html).not.toContain('<script');
      expect(html).toContain(`<style>${LEGAL_STYLE}</style>`);
    });
  }

  it('names the operator and contact from the LEGAL_* vars, escaped', async () => {
    const request = setup({
      LEGAL_OPERATOR: 'Ada <Lovelace> LLC',
      LEGAL_CONTACT_EMAIL: 'legal@example.org',
      LEGAL_JURISDICTION: 'the State of New York, USA',
    });
    const privacy = await (await request('/privacy')).text();
    expect(privacy).toContain('Ada &lt;Lovelace&gt; LLC');
    expect(privacy).not.toContain('<Lovelace>');
    expect(privacy).toContain('href="mailto:legal@example.org"');
    const terms = await (await request('/terms')).text();
    expect(terms).toContain('the laws of the State of New York, USA');
    expect(terms).toMatch(/© \d{4} Ada &lt;Lovelace&gt; LLC/);
  });

  it('falls back to the host when the operator vars are empty', async () => {
    const html = await (
      await setup({ LEGAL_OPERATOR: '', LEGAL_CONTACT_EMAIL: '', LEGAL_JURISDICTION: '' })(
        '/privacy',
      )
    ).text();
    expect(html).toContain('the operator of tangent.example.com');
    expect(html).toContain('mailto:privacy@tangent.example.com');
  });

  it('the landing page links both and carries the copyright line', async () => {
    const html = await (await setup({ LEGAL_OPERATOR: 'Ada LLC' })('/welcome')).text();
    expect(html).toContain('<a href="/privacy">Privacy</a>');
    expect(html).toContain('<a href="/terms">Terms</a>');
    expect(html).toMatch(
      /© \d{4} Ada LLC\. Tangent and the Tangent logo are trademarks of Ada LLC\./,
    );
  });

  it('says how long unpicked Compare answers outlive an account deletion', async () => {
    const privacy = await (await setup()('/privacy')).text();
    expect(privacy).toContain(
      "Compare answers you haven't picked (with the question they answer): 30 minutes",
    );
    expect(privacy).toContain(
      'deleting your account leaves any still held to go when their 30 minutes are up',
    );
  });

  it('says what the open pool keeps, and what of it outlives an account deletion', async () => {
    const privacy = await (await setup()('/privacy')).text();
    expect(privacy).toContain('<tr><td>Open pool (if you use it)</td>');
    expect(privacy).toContain('a keyed hash of your IP address');
    expect(privacy).toContain('a SHA-256 hash of your email address');
    expect(privacy).toContain(
      "Open pool records: when your account is deleted, the pool's usage records are kept without your user id (the pool's accounts add them up), and without your network key once that UTC day is over",
    );
    expect(privacy).toContain(
      "Your pool identity is kept for 90 days after the deletion, so that deleting an account and signing up again with the same mailbox neither lifts a suspension nor resets that day's caps, and then deleted.",
    );
    expect(privacy).not.toContain('with no set end');
    expect(privacy).not.toContain('without your user id or network key');
  });

  it('the terms promise no credit with the membership', async () => {
    const terms = await (await setup()('/terms')).text();
    expect(terms).toContain('The membership includes no credit.');
    expect(terms).not.toMatch(/credit (it|the membership) included|credit already granted/);
  });

  it('words share links by DMCA_AGENT_REGISTERED', async () => {
    const on = setup({ DMCA_AGENT_REGISTERED: 'true' });
    const off = setup({ DMCA_AGENT_REGISTERED: 'false' });
    const offNote = 'Share links are available only to accounts we enable them for.';

    const privacyOn = await (await on('/privacy')).text();
    expect(privacyOn).toContain("can't see them unless you publish a share link.");
    expect(privacyOn).not.toContain('Share links are not generally available');
    const privacyOff = await (await off('/privacy')).text();
    expect(privacyOff).toContain('which only accounts we have enabled it for can do');
    expect(privacyOff).toContain('Share links are not generally available');

    expect(await (await on('/terms')).text()).not.toContain(offNote);
    expect(await (await off('/terms')).text()).toContain(offNote);

    expect(await (await on('/welcome')).text()).toContain(
      'Read-only share links, and Markdown or HTML export',
    );
    const landingOff = await (await off('/welcome')).text();
    expect(landingOff).not.toContain('share links');
    expect(landingOff).toContain('<li>Markdown or HTML export</li>');
  });
});
