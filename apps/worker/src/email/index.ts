import type { AppEnv } from '../env.js';
import { LogEmailSender } from './log.js';
import { ResendEmailSender } from './resend.js';
import { EmailError, type EmailSender } from './types.js';

export { magicLinkEmail } from './templates.js';
export { EmailError, type EmailMessage, type EmailSender } from './types.js';

function isLocalhost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Picks the delivery service from `EMAIL_PROVIDER` (default `resend`). This is
 * the only provider-specific switch in the app. Misconfiguration throws, so a
 * sign-in attempt fails loudly instead of silently dropping the email.
 */
export function createEmailSender(env: AppEnv, baseUrl: string): EmailSender {
  const provider = (env.EMAIL_PROVIDER ?? '').trim() || 'resend';
  switch (provider) {
    case 'resend': {
      const apiKey = env.RESEND_API_KEY?.trim();
      const from = env.EMAIL_FROM?.trim();
      if (!apiKey || !from)
        throw new EmailError('Email is not configured (RESEND_API_KEY and EMAIL_FROM)');
      return new ResendEmailSender({ apiKey, from });
    }
    case 'log':
      if (!isLocalhost(baseUrl))
        throw new EmailError('EMAIL_PROVIDER=log is only allowed on localhost');
      return new LogEmailSender();
    default:
      throw new EmailError(`Unknown EMAIL_PROVIDER "${provider}"`);
  }
}
