// Alerts to the operator (src/alerts.ts), sent through test/mocks/resend.ts.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendAlert } from '../src/alerts.js';
import type { AppEnv } from '../src/env.js';
import { RESEND_ORIGIN } from './mocks/resend.js';

const ORIGIN = 'https://tangent.example.com';

function mailEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    ...env,
    EMAIL_PROVIDER: 'resend',
    RESEND_API_KEY: 're_test',
    EMAIL_FROM: 'Tangent <alerts@example.com>',
    ...overrides,
  } as AppEnv;
}

interface Sent {
  to: string[];
  subject: string;
  text: string;
  html: string;
}

async function mailTo(to: string): Promise<Sent[]> {
  const res = await fetch(`${RESEND_ORIGIN}/__mock/emails?to=${encodeURIComponent(to)}`);
  return (await res.json()) as Sent[];
}

function logLines(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
}

describe('sendAlert', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emails the legal contact the reason, the ids and the admin link', async () => {
    const to = `legal-${crypto.randomUUID()}@example.org`;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await sendAlert(mailEnv({ LEGAL_CONTACT_EMAIL: to }), ORIGIN, {
      reason: 'screened_csam',
      shareId: 'share-1',
      subjectUserId: 'user-1',
      holdId: 'hold-1',
    });
    const [mail, ...rest] = await mailTo(to);
    expect(rest).toEqual([]);
    expect(mail!.to).toEqual([to]);
    expect(mail!.subject).toContain('CSAM');
    for (const part of [mail!.text, mail!.html]) {
      expect(part).toContain('share-1');
      expect(part).toContain('user-1');
      expect(part).toContain('hold-1');
      expect(part).toContain(`${ORIGIN}/admin/`);
    }
    expect(mail!.text).not.toContain('Report:');
  });

  it('falls back to privacy@ the host when no contact is set', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const origin = `https://${crypto.randomUUID()}.example.net`;
    await sendAlert(mailEnv({ LEGAL_CONTACT_EMAIL: '' }), origin, {
      reason: 'screened_csam',
      shareId: 's',
      subjectUserId: null,
    });
    expect(await mailTo(`privacy@${new URL(origin).hostname}`)).toHaveLength(1);
  });

  it('logs alert_failed instead of throwing when the mail is refused or email is not set up', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const alert = { reason: 'screened_csam', shareId: 'share-2', subjectUserId: 'u' } as const;
    await sendAlert(mailEnv({ RESEND_API_KEY: 're_down' }), ORIGIN, alert);
    await sendAlert(mailEnv({ RESEND_API_KEY: '' }), ORIGIN, alert);
    const lines = logLines(error);
    expect(lines.map((l) => [l['event'], l['shareId']])).toEqual([
      ['alert_failed', 'share-2'],
      ['alert_failed', 'share-2'],
    ]);
  });
});
