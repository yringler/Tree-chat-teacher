import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createEmailSender, EmailError, magicLinkEmail } from '../src/email/index.js';
import { LogEmailSender } from '../src/email/log.js';
import { ResendEmailSender } from '../src/email/resend.js';
import type { AppEnv } from '../src/env.js';

const message = { to: 'a@example.com', subject: 'Hi', text: 'plain', html: '<p>html</p>' };

describe('ResendEmailSender', () => {
  it('posts the message to Resend with the API key', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const sender = new ResendEmailSender({
      apiKey: 're_test',
      from: 'Tangent <login@example.com>',
      fetch: (url, init) => {
        calls.push({ url: String(url), init: init! });
        return Promise.resolve(Response.json({ id: 'email_1' }));
      },
    });
    await sender.send(message);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(calls[0]!.init.method).toBe('POST');
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer re_test');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      from: 'Tangent <login@example.com>',
      to: ['a@example.com'],
      subject: 'Hi',
      text: 'plain',
      html: '<p>html</p>',
    });
  });

  it('throws EmailError with the status and Resend message on rejection', async () => {
    const sender = new ResendEmailSender({
      apiKey: 're_test',
      from: 'x@example.com',
      fetch: () =>
        Promise.resolve(
          Response.json(
            { name: 'validation_error', message: 'Domain not verified', statusCode: 403 },
            { status: 403 },
          ),
        ),
    });
    const err = await sender.send(message).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailError);
    expect(err).toMatchObject({
      status: 403,
      message: 'Resend rejected the message (403): Domain not verified',
    });
  });

  it('throws EmailError when Resend is unreachable', async () => {
    const sender = new ResendEmailSender({
      apiKey: 're_test',
      from: 'x@example.com',
      fetch: () => Promise.reject(new Error('connection reset')),
    });
    await expect(sender.send(message)).rejects.toThrow('Resend unreachable: connection reset');
  });
});

describe('createEmailSender', () => {
  const e = (o: Partial<AppEnv>) => ({ ...env, ...o }) as AppEnv;

  it('defaults to Resend and needs its key and sender', () => {
    expect(
      createEmailSender(
        e({ EMAIL_PROVIDER: '', RESEND_API_KEY: 'k', EMAIL_FROM: 'x@example.com' }),
        'https://a.example',
      ),
    ).toBeInstanceOf(ResendEmailSender);
    expect(() =>
      createEmailSender(
        e({ EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'x@example.com' }),
        'https://a.example',
      ),
    ).toThrow(EmailError);
    expect(() =>
      createEmailSender(
        e({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k', EMAIL_FROM: '' }),
        'https://a.example',
      ),
    ).toThrow(EmailError);
  });

  it('allows the log sender on localhost only (a logged magic link is a credential)', () => {
    expect(createEmailSender(e({ EMAIL_PROVIDER: 'log' }), 'http://localhost:8787')).toBeInstanceOf(
      LogEmailSender,
    );
    expect(() =>
      createEmailSender(e({ EMAIL_PROVIDER: 'log' }), 'https://tangent.example.com'),
    ).toThrow('EMAIL_PROVIDER=log is only allowed on localhost');
  });

  it('rejects unknown providers', () => {
    expect(() =>
      createEmailSender(e({ EMAIL_PROVIDER: 'carrier-pigeon' }), 'https://a.example'),
    ).toThrow('Invalid EMAIL_PROVIDER="carrier-pigeon": expected resend, log');
  });
});

describe('magicLinkEmail', () => {
  it('includes the link in both bodies and escapes it in HTML', () => {
    const url = 'https://t.example/api/auth/magic-link/verify?token=a&callbackURL=%2F"<x>';
    const m = magicLinkEmail('a@example.com', url, 15);
    expect(m.to).toBe('a@example.com');
    expect(m.text).toContain(url);
    expect(m.text).toContain('15 minutes');
    expect(m.html).toContain('token=a&amp;callbackURL=%2F&quot;&lt;x&gt;');
    expect(m.html).not.toContain('"<x>');
  });
});
